import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  createSession,
  createVerifiedTarget,
  prepareDatabase,
  prisma,
  resetDatabase,
  scanQueue,
  startTestApi,
  type TestApi,
  type TestSession,
  type TestTarget,
} from "../../test-support/harness";
import { reconcileScans } from "./scan-reconciler";

/**
 * #6, the half that can be tested today: a QUEUED row with no job behind it.
 *
 * The API owns both sides of this failure, so the whole path is exercisable
 * without an orchestrator. Each case seeds the row and the queue into the state
 * the failure leaves them in, rather than mocking the sweep.
 */

let api: TestApi;
let queue: ReturnType<typeof scanQueue>;

beforeAll(async () => {
  await prepareDatabase();
  api = await startTestApi();
  queue = scanQueue();
});

afterAll(async () => {
  await api.close();
  await queue.close();
});

beforeEach(async () => {
  await resetDatabase();
  await queue.obliterate({ force: true });
});

/** Old enough to be past the lost-after window, unless told otherwise. */
function ago(ms: number): Date {
  return new Date(Date.now() - ms);
}

const LOST = 5 * 60_000;
const ANCIENT = 48 * 60 * 60_000;

async function seedQueued(
  session: TestSession,
  target: TestTarget,
  queuedAt: Date,
) {
  return prisma.scanJob.create({
    data: {
      targetId: target.id,
      organizationId: session.organizationId,
      status: "QUEUED",
      createdById: session.userId,
      queuedAt,
    },
  });
}

describe("reconciling scans the queue lost", () => {
  test("re-delivers a queued scan that has no job", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedQueued(session, target, ago(LOST));

    const summary = await reconcileScans();

    expect(summary).toMatchObject({ examined: 1, requeued: 1 });

    const job = await queue.getJob(scan.id);
    expect(job).toBeDefined();
    expect(job!.data).toEqual({
      scanJobId: scan.id,
      organizationId: session.organizationId,
      attempt: 1,
    });

    // Still queued: the scan was never the problem, its delivery was.
    const row = await prisma.scanJob.findUniqueOrThrow({
      where: { id: scan.id },
    });
    expect(row.status).toBe("QUEUED");
  });

  test("leaves a queued scan alone while its job is still in the queue", async () => {
    // A busy or stopped fleet is a capacity problem, not a lost row. Acting
    // here would turn a slow day into failed work.
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedQueued(session, target, ago(LOST));
    await queue.add(
      "scan",
      {
        scanJobId: scan.id,
        organizationId: session.organizationId,
        attempt: 1,
      },
      { jobId: scan.id },
    );

    const summary = await reconcileScans();

    expect(summary).toMatchObject({ examined: 0, requeued: 0 });
    expect(
      (await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } }))
        .status,
    ).toBe("QUEUED");
  });

  test("leaves a freshly queued scan alone, because its enqueue may be in flight", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedQueued(session, target, new Date());

    const summary = await reconcileScans();

    expect(summary.examined).toBe(0);
    expect(await queue.getJob(scan.id)).toBeUndefined();
  });

  test("ends a lost scan whose target may no longer be scanned", async () => {
    // C.2 has no bypass. The authorisation was checked when the scan was
    // requested, and re-delivering on the strength of that older check would
    // crawl a target nobody is allowed to crawl now.
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedQueued(session, target, ago(LOST));

    await prisma.target.update({
      where: { id: target.id },
      data: { isArchived: true },
    });

    const summary = await reconcileScans();

    expect(summary).toMatchObject({ examined: 1, requeued: 0, refused: 1 });
    expect(await queue.getJob(scan.id)).toBeUndefined();

    const row = await prisma.scanJob.findUniqueOrThrow({
      where: { id: scan.id },
    });
    expect(row.status).toBe("FAILED");
    expect(row.failureReason).toContain("could no longer be scanned");
  });

  test("ends a lost scan too old to start", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedQueued(session, target, ago(ANCIENT));

    const summary = await reconcileScans();

    expect(summary).toMatchObject({ examined: 1, abandoned: 1, requeued: 0 });
    expect(await queue.getJob(scan.id)).toBeUndefined();
    expect(
      (await prisma.scanJob.findUniqueOrThrow({ where: { id: scan.id } }))
        .status,
    ).toBe("FAILED");
  });

  test("records an ended scan in the audit log without attributing it to a user", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedQueued(session, target, ago(ANCIENT));

    await reconcileScans();

    const audits = await prisma.auditLog.findMany({
      where: { resourceId: scan.id },
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]!.action).toBe("SCAN_FAILED");
    // Nobody performed this. Naming a user would make the log say something
    // untrue about who decided it.
    expect(audits[0]!.userId).toBeNull();
    expect(audits[0]!.organizationId).toBe(session.organizationId);
  });

  test("releases the capacity a lost scan was holding", async () => {
    // The point of the whole sweep: QUEUED occupies quota, so a lost row makes
    // its target unscannable until something clears it.
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    await seedQueued(session, target, ago(ANCIENT));

    const before = await prisma.scanJob.count({
      where: {
        organizationId: session.organizationId,
        status: { in: ["QUEUED", "RUNNING", "PAUSED"] },
      },
    });
    expect(before).toBe(1);

    await reconcileScans();

    const after = await prisma.scanJob.count({
      where: {
        organizationId: session.organizationId,
        status: { in: ["QUEUED", "RUNNING", "PAUSED"] },
      },
    });
    expect(after).toBe(0);
  });

  test("ignores scans that are not queued", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    for (const status of ["RUNNING", "PAUSED", "COMPLETED", "FAILED"] as const) {
      await prisma.scanJob.create({
        data: {
          targetId: target.id,
          organizationId: session.organizationId,
          status,
          createdById: session.userId,
          queuedAt: ago(ANCIENT),
        },
      });
    }

    const summary = await reconcileScans();

    expect(summary).toMatchObject({
      examined: 0,
      requeued: 0,
      refused: 0,
      abandoned: 0,
    });
  });

  test("is safe to run twice, producing one job", async () => {
    const session = await createSession("ANALYST");
    const target = await createVerifiedTarget(session.organizationId);
    const scan = await seedQueued(session, target, ago(LOST));

    const first = await reconcileScans();
    const second = await reconcileScans();

    expect(first.requeued).toBe(1);
    // The second sweep sees the job the first one added and leaves it alone.
    expect(second).toMatchObject({ examined: 0, requeued: 0 });
    expect(await queue.getJobCountByTypes("waiting", "delayed", "active")).toBe(
      1,
    );
  });
});
