/**
 * CVSS v3 base score from a vector string (FIRST, CVSS v3.1 specification §7).
 *
 * OSV gives an advisory's severity as a vector, not a number, so the score the
 * findings list sorts on has to be worked out here. Only v3.0 and v3.1 vectors
 * are scored, with the v3.1 formula: the two differ only in how they round,
 * and v3.1's rounding fixes floating-point cases v3.0 got wrong. A v2 or v4
 * vector, or anything malformed, yields null rather than a wrong number.
 */

const WEIGHTS = {
  AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
  AC: { L: 0.77, H: 0.44 },
  UI: { N: 0.85, R: 0.62 },
  CIA: { H: 0.56, L: 0.22, N: 0 },
} as const;

/** Privileges Required weighs more when the scope changes. */
const PRIVILEGES = {
  U: { N: 0.85, L: 0.62, H: 0.27 },
  C: { N: 0.85, L: 0.68, H: 0.5 },
} as const;

const VECTOR = /^CVSS:3\.[01]\/(.+)$/;

/** Rounds up to one decimal, as v3.1 Appendix A defines it. */
function roundUp(value: number): number {
  const scaled = Math.round(value * 100_000);
  return scaled % 10_000 === 0 ? scaled / 100_000 : (Math.floor(scaled / 10_000) + 1) / 10;
}

type Metric = "AV" | "AC" | "PR" | "UI" | "C" | "I" | "A";
type Scope = "U" | "C";
type Weights = Record<Metric, number>;

const METRICS: Metric[] = ["AV", "AC", "PR", "UI", "C", "I", "A"];

/** Each metric's weights; Privileges Required depends on the scope. */
function tablesFor(scope: Scope): Record<Metric, Record<string, number>> {
  return {
    AV: WEIGHTS.AV,
    AC: WEIGHTS.AC,
    PR: PRIVILEGES[scope],
    UI: WEIGHTS.UI,
    C: WEIGHTS.CIA,
    I: WEIGHTS.CIA,
    A: WEIGHTS.CIA,
  };
}

/** The weight of every base metric, or null if any is missing or unknown. */
function weightsOf(values: Map<string, string>, scope: Scope): Weights | null {
  const tables = tablesFor(scope);
  const weights = {} as Weights;
  for (const metric of METRICS) {
    const value = values.get(metric);
    // hasOwn, so a value such as `constructor` is not read off the prototype.
    const weight = value !== undefined && Object.hasOwn(tables[metric], value) ? tables[metric][value] : undefined;
    if (weight === undefined) return null;
    weights[metric] = weight;
  }
  return weights;
}

/** The base score equations of §7.1. */
function score(w: Weights, scope: Scope): number {
  const iss = 1 - (1 - w.C) * (1 - w.I) * (1 - w.A);
  const impact = scope === "U" ? 6.42 * iss : 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15;
  if (impact <= 0) return 0;

  const exploitability = 8.22 * w.AV * w.AC * w.PR * w.UI;
  const combined = scope === "U" ? impact + exploitability : 1.08 * (impact + exploitability);
  return roundUp(Math.min(combined, 10));
}

export function cvssBaseScore(vector: string): number | null {
  const body = VECTOR.exec(vector.trim())?.[1];
  if (!body) return null;

  const values = new Map(body.split("/").map((part) => part.split(":") as [string, string]));
  const scope = values.get("S");
  if (scope !== "U" && scope !== "C") return null;

  const weights = weightsOf(values, scope);
  return weights ? score(weights, scope) : null;
}
