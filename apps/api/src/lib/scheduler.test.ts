import { describe, expect, test } from "bun:test";
import { maintenanceJobs } from "./maintenance-jobs";
import { startScheduler, type ScheduledJob } from "./scheduler";

const quietLog = () => {
  const lines: string[] = [];
  return {
    lines,
    info: (message: string) => lines.push(message),
    error: (message: string) => lines.push(message),
  };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A command that stays running until the test lets it finish. */
function heldRun() {
  const started: string[] = [];
  let release: (code: number) => void = () => {};
  const run = (command: readonly string[]) => {
    started.push(command.join(" "));
    return new Promise<number>((resolve) => {
      release = resolve;
    });
  };
  return { started, run, release: (code = 0) => release(code) };
}

describe("startScheduler", () => {
  test("runs a job at start and again on its interval", async () => {
    const started: string[] = [];
    const job: ScheduledJob = { name: "tick", command: ["echo", "tick"], everyMs: 20 };
    const scheduler = startScheduler(
      [job],
      async (command) => {
        started.push(command.join(" "));
        return 0;
      },
      quietLog(),
    );

    expect(started).toEqual(["echo tick"]);
    await sleep(70);
    await scheduler.stop();
    expect(started.length).toBeGreaterThanOrEqual(3);
  });

  test("skips a turn instead of starting a second copy of a running job", async () => {
    const held = heldRun();
    const log = quietLog();
    const scheduler = startScheduler(
      [{ name: "slow", command: ["slow"], everyMs: 10 }],
      held.run,
      log,
    );

    await sleep(45);
    expect(held.started).toEqual(["slow"]);
    expect(log.lines).toContain("[scheduler] slow still running, skipping this turn");

    held.release();
    await scheduler.stop();
  });

  test("stop waits for a run in progress", async () => {
    const held = heldRun();
    const scheduler = startScheduler(
      [{ name: "purge", command: ["purge"], everyMs: 60_000 }],
      held.run,
      quietLog(),
    );

    let stopped = false;
    const stopping = scheduler.stop().then(() => {
      stopped = true;
    });
    await sleep(10);
    expect(stopped).toBe(false);

    held.release();
    await stopping;
    expect(stopped).toBe(true);
  });

  test("logs a non-zero exit and a command that cannot start, and keeps going", async () => {
    const log = quietLog();
    const scheduler = startScheduler(
      [
        { name: "failing", command: ["false"], everyMs: 60_000 },
        { name: "missing", command: ["nope"], everyMs: 60_000 },
        { name: "off", command: ["never"], everyMs: 0 },
      ],
      async (command) => {
        if (command[0] === "nope") throw new Error("ENOENT");
        return 1;
      },
      log,
    );
    await scheduler.stop();

    expect(log.lines).toContain("[scheduler] off disabled");
    expect(log.lines.some((line) => line.startsWith("[scheduler] failing exited 1"))).toBe(true);
    expect(log.lines).toContain("[scheduler] missing could not start: Error: ENOENT");
  });
});

describe("maintenanceJobs", () => {
  test("runs the root scripts on their default intervals", () => {
    expect(maintenanceJobs({})).toEqual([
      { name: "email:retry", command: ["bun", "run", "email:retry"], everyMs: 5 * 60_000 },
      { name: "scans:reconcile", command: ["bun", "run", "scans:reconcile"], everyMs: 5 * 60_000 },
      { name: "purge:retention", command: ["bun", "run", "purge:retention"], everyMs: 24 * 60 * 60_000 },
    ]);
  });

  test("reads intervals in minutes and treats 0 as off", () => {
    const jobs = maintenanceJobs({
      EMAIL_RETRY_EVERY_MINUTES: "1",
      SCANS_RECONCILE_EVERY_MINUTES: "0",
      PURGE_RETENTION_EVERY_MINUTES: "",
    });
    expect(jobs.map((job) => job.everyMs)).toEqual([60_000, 0, 24 * 60 * 60_000]);
  });

  test("refuses an interval it cannot read rather than guessing", () => {
    expect(() => maintenanceJobs({ EMAIL_RETRY_EVERY_MINUTES: "often" })).toThrow(
      'expected a number of minutes >= 0, got "often"',
    );
  });
});
