/**
 * F.8 maintenance scheduler: runs each maintenance command on a fixed interval.
 *
 * Each job is the same command an operator runs by hand (`bun run email:retry`
 * and so on), started as its own process. That keeps the scripts the single
 * definition of what a run does, including their exit codes and connection
 * cleanup, and lets the retention purge use owner credentials without the
 * scheduler opening a privileged connection itself.
 *
 * Run exactly one scheduler per deployment. Overlap is prevented within this
 * process only: a run still going when its next turn comes is skipped, not
 * stacked.
 */

export interface ScheduledJob {
  name: string;
  command: readonly string[];
  everyMs: number;
}

/** Starts a command and resolves with its exit code. */
export type RunCommand = (command: readonly string[]) => Promise<number>;

export interface SchedulerLog {
  info(message: string): void;
  error(message: string): void;
}

export interface Scheduler {
  /** Stops scheduling and waits for runs already in progress. */
  stop(): Promise<void>;
}

export function startScheduler(
  jobs: readonly ScheduledJob[],
  run: RunCommand,
  log: SchedulerLog = console,
): Scheduler {
  const running = new Map<string, Promise<void>>();
  const timers: ReturnType<typeof setInterval>[] = [];

  const tick = (job: ScheduledJob) => {
    if (running.has(job.name)) {
      log.info(`[scheduler] ${job.name} still running, skipping this turn`);
      return;
    }
    const started = Date.now();
    const attempt = run(job.command)
      .then((code) => {
        const took = `${Date.now() - started}ms`;
        if (code === 0) log.info(`[scheduler] ${job.name} finished in ${took}`);
        else log.error(`[scheduler] ${job.name} exited ${code} after ${took}`);
      })
      .catch((error: unknown) => {
        log.error(`[scheduler] ${job.name} could not start: ${String(error)}`);
      })
      .finally(() => running.delete(job.name));
    running.set(job.name, attempt);
  };

  for (const job of jobs) {
    if (job.everyMs <= 0) {
      log.info(`[scheduler] ${job.name} disabled`);
      continue;
    }
    log.info(`[scheduler] ${job.name} every ${job.everyMs / 60_000} min`);
    // At start as well as on the interval, so a restart does not push the
    // next run a whole interval away.
    tick(job);
    timers.push(setInterval(() => tick(job), job.everyMs));
  }

  return {
    async stop() {
      for (const timer of timers) clearInterval(timer);
      await Promise.all(running.values());
    },
  };
}
