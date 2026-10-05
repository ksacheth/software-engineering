/**
 * F.8 maintenance scheduler process. Runs `email:retry`, `scans:reconcile` and
 * `purge:retention` on their intervals (see lib/maintenance-jobs.ts):
 *
 *   bun run scheduler
 *
 * One per deployment. The container deployment runs it as the `scheduler`
 * service; it needs the owner database URL because the retention purge does.
 */
import { fileURLToPath } from "node:url";
import { maintenanceJobs } from "../lib/maintenance-jobs";
import { startScheduler } from "../lib/scheduler";

/** The root scripts are run from the repo root, four levels up from here. */
const REPO_ROOT = fileURLToPath(new URL("../../../../", import.meta.url));

const scheduler = startScheduler(maintenanceJobs(process.env), async (command) => {
  const child = Bun.spawn([...command], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  return child.exited;
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.log(`[scheduler] ${signal} received, waiting for running jobs`);
    void scheduler.stop().finally(() => process.exit(0));
  });
}
