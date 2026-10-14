import type { FindingSeverity, ScanStatus } from "@wvs/shared";

/**
 * The dashboard overview. Counts only; each one summarises a list page and is
 * computed on the server by that page's own rule, so the two never disagree.
 */
export interface DashboardSummary {
  /** Targets the Targets page lists (archived ones left out). */
  targets: { total: number; scannable: number };
  scans: Record<ScanStatus, number>;
  /** The current posture, as the Findings page shows it unfiltered. */
  findings: Record<FindingSeverity, number>;
}

export async function fetchDashboardSummary(): Promise<{
  summary: DashboardSummary;
}> {
  const res = await fetch("/api/dashboard", { credentials: "same-origin" });
  if (!res.ok) {
    throw new Error(`The dashboard request failed with status ${res.status}`);
  }
  return (await res.json()) as { summary: DashboardSummary };
}
