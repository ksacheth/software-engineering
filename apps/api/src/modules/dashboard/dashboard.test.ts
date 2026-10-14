import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { randomUUID } from "node:crypto";
import {
  createSession,
  createVerifiedTarget,
  prepareDatabase,
  prisma,
  request,
  resetDatabase,
  startTestApi,
  type TestApi,
  type TestSession,
} from "../../test-support/harness";
import {
  createCompletedScan,
  createFinding,
  recordTriage,
} from "../../dev-data/findings";

/**
 * The dashboard overview, through the running API against real Postgres.
 *
 * Every number on the dashboard summarises a list one click away, so the tests
 * pin each count to that list's rule: archived targets left out, the posture
 * read from each target's latest completed scan, and dismissed findings not
 * counted.
 */

setDefaultTimeout(30_000);

let api: TestApi;

beforeAll(async () => {
  await prepareDatabase();
  api = await startTestApi();
});

afterAll(async () => {
  await api.close();
});

beforeEach(async () => {
  await resetDatabase();
});

interface Summary {
  targets: { total: number; scannable: number };
  scans: Record<string, number>;
  findings: Record<string, number>;
}

async function summaryFor(session: TestSession): Promise<Summary> {
  const res = await request(api, session, "/api/dashboard");
  expect(res.status).toBe(200);
  return ((await res.json()) as { summary: Summary }).summary;
}

function pendingTarget(organizationId: string) {
  return prisma.target.create({
    data: {
      organizationId,
      origin: `https://pending-${randomUUID().slice(0, 8)}.example.test`,
      label: "Pending target",
      verificationToken: randomUUID(),
      verificationMethod: "DNS_TXT",
      authorisationAck: true,
      authorisationAckAt: new Date(),
    },
  });
}

describe("the dashboard summary", () => {
  test("is all zeros for a new organisation", async () => {
    const session = await createSession();
    const summary = await summaryFor(session);

    expect(summary.targets).toEqual({ total: 0, scannable: 0 });
    expect(Object.values(summary.scans).every((count) => count === 0)).toBe(true);
    expect(summary.findings).toEqual({ CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 });
  });

  test("counts targets as the Targets page lists them", async () => {
    const session = await createSession();
    await createVerifiedTarget(session.organizationId);
    await pendingTarget(session.organizationId);
    const archived = await createVerifiedTarget(session.organizationId);
    await prisma.target.update({
      where: { id: archived.id },
      data: { isArchived: true, archivedAt: new Date() },
    });

    expect((await summaryFor(session)).targets).toEqual({ total: 2, scannable: 1 });
  });

  test("counts scans by status", async () => {
    const session = await createSession();
    const target = await createVerifiedTarget(session.organizationId);
    const ids = { organizationId: session.organizationId, targetId: target.id };
    await createCompletedScan(prisma, ids);
    await createCompletedScan(prisma, ids);
    await prisma.scanJob.create({ data: { ...ids, status: "RUNNING", phase: "DISCOVERY" } });

    const { scans } = await summaryFor(session);
    expect(scans.COMPLETED).toBe(2);
    expect(scans.RUNNING).toBe(1);
    expect(scans.FAILED).toBe(0);
  });

  test("counts the current posture by severity, without dismissed findings", async () => {
    const session = await createSession();
    const target = await createVerifiedTarget(session.organizationId);
    const ids = { organizationId: session.organizationId, targetId: target.id };

    // An older scan's findings are not the posture: only the latest completed scan counts.
    const older = await createCompletedScan(prisma, { ...ids, completedAt: new Date(Date.now() - 86_400_000) });
    await createFinding(prisma, { scanJobId: older.id, targetId: target.id, fingerprint: "fp-gone", severity: "CRITICAL" });

    const latest = await createCompletedScan(prisma, ids);
    const finding = (fingerprint: string, severity: "HIGH" | "MEDIUM" | "LOW") =>
      createFinding(prisma, { scanJobId: latest.id, targetId: target.id, fingerprint, severity });
    await finding("fp-high", "HIGH");
    await finding("fp-medium-1", "MEDIUM");
    await finding("fp-medium-2", "MEDIUM");
    await finding("fp-dismissed", "LOW");
    await recordTriage(prisma, { targetId: target.id, fingerprint: "fp-dismissed", state: "FALSE_POSITIVE" });

    expect((await summaryFor(session)).findings).toEqual({
      CRITICAL: 0,
      HIGH: 1,
      MEDIUM: 2,
      LOW: 0,
      INFO: 0,
    });
  });

  test("never counts another organisation's data", async () => {
    const session = await createSession();
    const other = await createSession();
    const theirs = await createVerifiedTarget(other.organizationId);
    const scan = await createCompletedScan(prisma, { organizationId: other.organizationId, targetId: theirs.id });
    await createFinding(prisma, { scanJobId: scan.id, targetId: theirs.id, fingerprint: "fp-theirs", severity: "HIGH" });

    const summary = await summaryFor(session);
    expect(summary.targets.total).toBe(0);
    expect(summary.scans.COMPLETED).toBe(0);
    expect(summary.findings.HIGH).toBe(0);
  });

  test("is readable by a viewer", async () => {
    const viewer = await createSession("VIEWER");
    const res = await request(api, viewer, "/api/dashboard");
    expect(res.status).toBe(200);
  });

  test("refuses a caller with no session", async () => {
    const res = await fetch(`${api.baseUrl}/api/dashboard`);
    expect(res.status).toBe(401);
  });
});
