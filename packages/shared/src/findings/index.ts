/**
 * F.6 findings contract: the enums the API and the dashboard both speak.
 *
 * Duplicated from the Prisma enums, like the scan contract; the API asserts
 * the copies stay assignable (apps/api/src/modules/scans/enum-drift.ts).
 * `FINDING_SEVERITIES` stays with the scan events, where it was first needed.
 */

export const TRIAGE_STATES = [
  "OPEN",
  "CONFIRMED",
  "FALSE_POSITIVE",
  "ACCEPTED_RISK",
  "RESOLVED",
] as const;

export type TriageState = (typeof TRIAGE_STATES)[number];

/**
 * Triage states that hide risk. Setting one needs a stated reason, because the
 * judgement carries forward to every later scan of the target.
 */
export const JUSTIFIED_TRIAGE_STATES: readonly TriageState[] = [
  "FALSE_POSITIVE",
  "ACCEPTED_RISK",
];

/** What the current posture shows by default: findings that still need action. */
export const ACTIONABLE_TRIAGE_STATES: readonly TriageState[] = [
  "OPEN",
  "CONFIRMED",
];

export function isTriageState(value: unknown): value is TriageState {
  return (
    typeof value === "string" &&
    (TRIAGE_STATES as readonly string[]).includes(value)
  );
}

export const COMPARISON_STATUSES = ["NEW", "PERSISTING", "RESOLVED"] as const;

export type ComparisonStatus = (typeof COMPARISON_STATUSES)[number];

export const FINDING_CONFIDENCES = ["CONFIRMED", "FIRM", "TENTATIVE"] as const;

export type FindingConfidence = (typeof FINDING_CONFIDENCES)[number];
