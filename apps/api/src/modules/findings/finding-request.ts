import { z } from "zod";
import {
  ACTIONABLE_TRIAGE_STATES,
  COMPARISON_STATUSES,
  FINDING_CONFIDENCES,
  FINDING_SEVERITIES,
  JUSTIFIED_TRIAGE_STATES,
  TRIAGE_STATES,
  type ComparisonStatus,
  type FindingConfidence,
  type FindingSeverity,
  type TriageState,
} from "@wvs/shared";
import type { ProblemFieldError } from "../../common/problem";
import {
  decodeFindingCursor,
  DEFAULT_SORT,
  defaultDirection,
  FINDING_SORT_KEYS,
  isFindingSortKey,
  type FindingCursor,
  type FindingSortKey,
  type SortDirection,
} from "./finding-sort";

/**
 * F.6 request validation (NFR-SEC-2). Every problem is reported at once, so a
 * caller can fix them all in one edit.
 */

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;
export const MAX_BULK_TRIAGE = 100;
export const MAX_JUSTIFICATION_LENGTH = 2000;
export const MAX_SEARCH_LENGTH = 200;

export interface FindingListQuery {
  /** Present: exactly that scan's findings. Absent: the current posture. */
  scanId?: string;
  targetId?: string;
  severities?: FindingSeverity[];
  confidences?: FindingConfidence[];
  /** Undefined means every triage state. */
  triageStates?: TriageState[];
  diffStatuses?: ComparisonStatus[];
  detectorId?: string;
  owaspCategory?: string;
  search?: string;
  sort: FindingSortKey;
  direction: SortDirection;
  limit: number;
  cursor?: FindingCursor;
}

export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ProblemFieldError[] };

type QueryValue = unknown;

/** A single string parameter; repeated or structured values are refused. */
function single(
  name: string,
  value: QueryValue,
  errors: ProblemFieldError[],
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    errors.push({ pointer: `/${name}`, detail: `${name} must be given once.` });
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Accepts `a,b` and repeated `?x=a&x=b` alike. */
function list<T extends string>(
  name: string,
  value: QueryValue,
  allowed: readonly T[],
  errors: ProblemFieldError[],
): T[] | undefined {
  if (value === undefined) return undefined;
  const raw = (Array.isArray(value) ? value : [value]).flatMap((entry) =>
    typeof entry === "string" ? entry.split(",") : [null],
  );
  const members = raw.map((entry) => entry?.trim() ?? null);
  const invalid = members.filter(
    (entry) => entry === null || !(allowed as readonly string[]).includes(entry),
  );
  if (invalid.length > 0 || members.length === 0) {
    errors.push({
      pointer: `/${name}`,
      detail: `${name} must be one or more of: ${allowed.join(", ")}`,
    });
    return undefined;
  }
  return [...new Set(members as T[])];
}

/**
 * The current posture shows what still needs action unless asked otherwise;
 * one scan's findings are shown whole. `triage=all` lifts the default.
 */
function parseTriageStates(
  value: QueryValue,
  isScan: boolean,
  errors: ProblemFieldError[],
): TriageState[] | undefined {
  if (value === "all") return undefined;
  if (value !== undefined) return list("triage", value, TRIAGE_STATES, errors);
  return isScan ? undefined : [...ACTIONABLE_TRIAGE_STATES];
}

function parseSort(
  query: Record<string, QueryValue>,
  errors: ProblemFieldError[],
): { sort: FindingSortKey; direction: SortDirection } {
  const sortParam = single("sort", query.sort, errors);
  const sortValid = sortParam === undefined || isFindingSortKey(sortParam);
  if (!sortValid) {
    errors.push({
      pointer: "/sort",
      detail: `sort must be one of: ${FINDING_SORT_KEYS.join(", ")}`,
    });
  }
  const sort = sortValid && sortParam ? sortParam : DEFAULT_SORT;

  const directionParam = single("direction", query.direction, errors);
  const directionValid =
    directionParam === undefined ||
    directionParam === "asc" ||
    directionParam === "desc";
  if (!directionValid) {
    errors.push({
      pointer: "/direction",
      detail: "direction must be asc or desc.",
    });
  }
  const direction =
    directionValid && directionParam
      ? (directionParam as SortDirection)
      : defaultDirection(sort);

  return { sort, direction };
}

function parseLimit(value: QueryValue, errors: ProblemFieldError[]): number {
  const limitParam = single("limit", value, errors);
  if (limitParam === undefined) return DEFAULT_PAGE_SIZE;
  const parsed = Number(limitParam);
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= MAX_PAGE_SIZE) {
    return parsed;
  }
  errors.push({
    pointer: "/limit",
    detail: `limit must be an integer between 1 and ${MAX_PAGE_SIZE}.`,
  });
  return DEFAULT_PAGE_SIZE;
}

function parseCursor(
  value: QueryValue,
  order: { sort: FindingSortKey; direction: SortDirection },
  errors: ProblemFieldError[],
): FindingCursor | undefined {
  const cursorParam = single("cursor", value, errors);
  if (cursorParam === undefined) return undefined;

  const decoded = decodeFindingCursor(cursorParam);
  if (!decoded) {
    errors.push({
      pointer: "/cursor",
      detail: "cursor is not a cursor this API issued.",
    });
    return undefined;
  }
  // A cursor carries the sort-key values of one order; applied to another it
  // would skip or repeat rows without any sign of doing so.
  if (decoded.sort !== order.sort || decoded.direction !== order.direction) {
    errors.push({
      pointer: "/cursor",
      detail: "cursor was issued for a different sort order.",
    });
    return undefined;
  }
  return decoded;
}

function parseSearch(
  value: QueryValue,
  errors: ProblemFieldError[],
): string | undefined {
  const search = single("q", value, errors);
  if (search && search.length > MAX_SEARCH_LENGTH) {
    errors.push({
      pointer: "/q",
      detail: `q must be at most ${MAX_SEARCH_LENGTH} characters.`,
    });
  }
  return search;
}

export function parseFindingListQuery(
  query: Record<string, QueryValue>,
): Parsed<FindingListQuery> {
  const errors: ProblemFieldError[] = [];

  const scanId = single("scanId", query.scanId, errors);
  const order = parseSort(query, errors);

  const value: FindingListQuery = {
    scanId,
    targetId: single("targetId", query.targetId, errors),
    detectorId: single("detectorId", query.detectorId, errors),
    owaspCategory: single("owaspCategory", query.owaspCategory, errors),
    search: parseSearch(query.q, errors),
    severities: list("severity", query.severity, FINDING_SEVERITIES, errors),
    confidences: list("confidence", query.confidence, FINDING_CONFIDENCES, errors),
    diffStatuses: list("diff", query.diff, COMPARISON_STATUSES, errors),
    triageStates: parseTriageStates(query.triage, Boolean(scanId), errors),
    ...order,
    limit: parseLimit(query.limit, errors),
    cursor: parseCursor(query.cursor, order, errors),
  };

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

// ------------------------------------------------------------------ triage ---

const justification = z
  .string()
  .trim()
  .max(MAX_JUSTIFICATION_LENGTH)
  .optional()
  .transform((value) => (value ? value : undefined));

const triageFields = {
  state: z.enum(TRIAGE_STATES),
  justification,
};

/**
 * Hiding risk needs a stated reason: the judgement carries forward to every
 * later scan of the target, so an unexplained one is unexplained forever.
 */
function requireJustification(
  value: { state: TriageState; justification?: string },
  ctx: z.RefinementCtx,
): void {
  if (JUSTIFIED_TRIAGE_STATES.includes(value.state) && !value.justification) {
    ctx.addIssue({
      code: "custom",
      path: ["justification"],
      message: `A justification is required to mark a finding ${value.state}.`,
    });
  }
}

export const triageSchema = z
  .strictObject(triageFields)
  .superRefine(requireJustification);

export const bulkTriageSchema = z
  .strictObject({
    findingIds: z
      .array(z.string().min(1))
      .min(1)
      .max(MAX_BULK_TRIAGE)
      .transform((ids) => [...new Set(ids)]),
    ...triageFields,
  })
  .superRefine(requireJustification);

export interface TriageRequest {
  state: TriageState;
  justification?: string;
}

export interface BulkTriageRequest extends TriageRequest {
  findingIds: string[];
}

function pointerFor(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "/" : `/${path.map(String).join("/")}`;
}

function parseWith<T>(schema: z.ZodType<T>, body: unknown): Parsed<T> {
  const parsed = schema.safeParse(body ?? {});
  if (parsed.success) return { ok: true, value: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => ({
      pointer: pointerFor(issue.path),
      detail: issue.message,
    })),
  };
}

export function parseTriageRequest(body: unknown): Parsed<TriageRequest> {
  return parseWith(triageSchema, body);
}

export function parseBulkTriageRequest(
  body: unknown,
): Parsed<BulkTriageRequest> {
  return parseWith(bulkTriageSchema, body);
}
