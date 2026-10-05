import type { ScheduledJob } from "./scheduler";

/**
 * F.8: the maintenance work a deployment must run without anyone invoking it.
 *
 * Each command is a root `package.json` script, so the schedule runs exactly
 * what an operator would. Intervals are in minutes, from the environment, and
 * 0 turns a job off.
 */
const MAINTENANCE_JOBS = [
  // F.1 §3.2.3: failed transactional email is retried.
  { name: "email:retry", env: "EMAIL_RETRY_EVERY_MINUTES", defaultMinutes: 5 },
  // #6: re-deliver scans whose queue job was lost, end those that cannot run.
  { name: "scans:reconcile", env: "SCANS_RECONCILE_EVERY_MINUTES", defaultMinutes: 5 },
  // F.6, C.7: evidence and the URL ledger leave after the retention window.
  { name: "purge:retention", env: "PURGE_RETENTION_EVERY_MINUTES", defaultMinutes: 24 * 60 },
] as const;

function minutes(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`[scheduler] expected a number of minutes >= 0, got "${value}"`);
  }
  return parsed;
}

export function maintenanceJobs(
  env: Record<string, string | undefined>,
): ScheduledJob[] {
  return MAINTENANCE_JOBS.map((job) => ({
    name: job.name,
    command: ["bun", "run", job.name],
    everyMs: minutes(env[job.env], job.defaultMinutes) * 60_000,
  }));
}
