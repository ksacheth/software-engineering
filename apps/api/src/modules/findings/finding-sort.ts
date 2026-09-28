import type { Prisma } from "@wvs/database";
import { FINDING_SEVERITIES, type FindingSeverity } from "@wvs/shared";

/**
 * F.6 finding sort orders and the keyset cursors that page through them.
 *
 * SRS §3.2.4 asks for cursor pagination, and NFR-PERF-1 rules out OFFSET: page
 * N of a long findings history must not cost N pages of rows. A keyset cursor
 * has to follow the sort the user chose, so the cursor records the sort it was
 * issued for and the sort-key values of the last row, and a cursor presented
 * with a different sort is refused rather than silently misapplied.
 *
 * Two properties of the columns shape the comparison:
 *
 * - CVSS and EPSS are nullable. Nulls sort last in either direction, so a
 *   finding with no score never outranks one with a score.
 * - Severity is an enum, which Prisma cannot compare with lt/gt. Postgres orders
 *   an enum by declaration, INFO to CRITICAL, so "below HIGH" is expressed as
 *   membership of the members declared before it.
 *
 * `id` is the final key in every order, which makes each order total and so
 * makes the cursor exact.
 */

export const FINDING_SORT_KEYS = [
  "severity",
  "cvss",
  "epss",
  "name",
  "detected",
] as const;

export type FindingSortKey = (typeof FINDING_SORT_KEYS)[number];
export type SortDirection = "asc" | "desc";

export function isFindingSortKey(value: unknown): value is FindingSortKey {
  return (
    typeof value === "string" &&
    (FINDING_SORT_KEYS as readonly string[]).includes(value)
  );
}

type Column = "severity" | "cvssScore" | "epssScore" | "name" | "createdAt";

interface SortColumn {
  column: Column;
  nullable: boolean;
}

/**
 * The columns behind each key. Severity breaks ties by CVSS in the same
 * direction, which is what "most urgent first" means when two findings share a
 * label.
 */
const SORT_COLUMNS: Record<FindingSortKey, SortColumn[]> = {
  severity: [
    { column: "severity", nullable: false },
    { column: "cvssScore", nullable: true },
  ],
  cvss: [{ column: "cvssScore", nullable: true }],
  epss: [{ column: "epssScore", nullable: true }],
  name: [{ column: "name", nullable: false }],
  detected: [{ column: "createdAt", nullable: false }],
};

export const DEFAULT_SORT: FindingSortKey = "severity";

export function defaultDirection(key: FindingSortKey): SortDirection {
  return key === "name" ? "asc" : "desc";
}

type CursorValue = string | number | null;

export interface FindingCursor {
  sort: FindingSortKey;
  direction: SortDirection;
  values: CursorValue[];
  id: string;
}

/** The subset of a finding row the cursor reads. */
export interface SortableFinding {
  id: string;
  severity: FindingSeverity;
  cvssScore: number | null;
  epssScore: number | null;
  name: string;
  createdAt: Date;
}

export function findingOrderBy(
  sort: FindingSortKey,
  direction: SortDirection,
): Prisma.FindingOrderByWithRelationInput[] {
  const order: Prisma.FindingOrderByWithRelationInput[] = SORT_COLUMNS[
    sort
  ].map(
    ({ column, nullable }) =>
      ({
        [column]: nullable ? { sort: direction, nulls: "last" } : direction,
      }) as Prisma.FindingOrderByWithRelationInput,
  );
  order.push({ id: "asc" });
  return order;
}

function cursorValue(row: SortableFinding, column: Column): CursorValue {
  const value = row[column];
  return value instanceof Date ? value.toISOString() : value;
}

export function encodeFindingCursor(
  row: SortableFinding,
  sort: FindingSortKey,
  direction: SortDirection,
): string {
  const cursor: FindingCursor = {
    sort,
    direction,
    values: SORT_COLUMNS[sort].map(({ column }) => cursorValue(row, column)),
    id: row.id,
  };
  return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}

function isValidValue(column: SortColumn, value: unknown): boolean {
  if (value === null) return column.nullable;
  switch (column.column) {
    case "severity":
      return (FINDING_SEVERITIES as readonly unknown[]).includes(value);
    case "cvssScore":
    case "epssScore":
      return typeof value === "number" && Number.isFinite(value);
    case "name":
      return typeof value === "string";
    case "createdAt":
      return (
        typeof value === "string" && !Number.isNaN(new Date(value).getTime())
      );
  }
}

/** Returns null for anything that is not a cursor this API issued. */
export function decodeFindingCursor(value: string): FindingCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      !isFindingSortKey(parsed?.sort) ||
      (parsed.direction !== "asc" && parsed.direction !== "desc") ||
      typeof parsed.id !== "string" ||
      !Array.isArray(parsed.values)
    ) {
      return null;
    }
    const columns = SORT_COLUMNS[parsed.sort as FindingSortKey];
    if (
      parsed.values.length !== columns.length ||
      !columns.every((column, i) => isValidValue(column, parsed.values[i]))
    ) {
      return null;
    }
    return {
      sort: parsed.sort,
      direction: parsed.direction,
      values: parsed.values,
      id: parsed.id,
    };
  } catch {
    return null;
  }
}

function severitiesBeyond(
  value: FindingSeverity,
  direction: SortDirection,
): FindingSeverity[] {
  const index = FINDING_SEVERITIES.indexOf(value);
  return direction === "desc"
    ? FINDING_SEVERITIES.slice(0, index)
    : FINDING_SEVERITIES.slice(index + 1);
}

function toColumnValue(column: Column, value: CursorValue): unknown {
  return column === "createdAt" ? new Date(value as string) : value;
}

/** Rows strictly past `value` in this column's order, excluding nulls. */
function beyond(
  column: Column,
  value: CursorValue,
  direction: SortDirection,
): Prisma.FindingWhereInput {
  if (column === "severity") {
    return { severity: { in: severitiesBeyond(value as FindingSeverity, direction) } };
  }
  const bound = toColumnValue(column, value);
  return { [column]: direction === "desc" ? { lt: bound } : { gt: bound } };
}

/**
 * Every row that sorts after the cursor.
 *
 * Built key by key: a row is after the cursor if it is beyond it on the first
 * key, or equal on the first key and after it on the rest. With nulls last, a
 * null is beyond any value, and a null cursor value is only followed by other
 * nulls.
 */
export function findingsAfter(cursor: FindingCursor): Prisma.FindingWhereInput {
  const columns = SORT_COLUMNS[cursor.sort];

  const after = (index: number): Prisma.FindingWhereInput => {
    if (index === columns.length) return { id: { gt: cursor.id } };

    const { column, nullable } = columns[index]!;
    const value = cursor.values[index]!;
    const direction = cursor.direction;
    const rest = after(index + 1);

    if (value === null) {
      return { AND: [{ [column]: null }, rest] };
    }

    const branches: Prisma.FindingWhereInput[] = [
      beyond(column, value, direction),
      { AND: [{ [column]: toColumnValue(column, value) }, rest] },
    ];
    if (nullable) branches.push({ [column]: null });
    return { OR: branches };
  };

  return after(0);
}
