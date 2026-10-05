import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { rm } from "node:fs/promises";
import {
  createSession,
  createVerifiedTarget,
  prepareDatabase,
  prisma,
  reportQueue,
  request,
  resetDatabase,
  startTestApi,
  TEST_REPORT_STORAGE,
  type TestApi,
  type TestSession,
  type TestTarget,
} from "../../test-support/harness";
import {
  createCompletedScan,
  createDiff,
  createEvidence,
  createFinding,
  recordTriage,
  type FindingInput,
} from "../../dev-data/findings";
import { generateReport, markReportFailed } from "./report-generator";
import { UNAUTHENTICATED_LIMITATION } from "./coverage";

/**
 * F.7 reports, through the running API against real Postgres and Redis.
 *
 * Generation is driven by calling the generator directly rather than running a
 * BullMQ worker: the queue hand-off is asserted on its own, and a worker in the
 * test process would race the assertions for the job.
 */

setDefaultTimeout(30_000);

let api: TestApi;
let queue: ReturnType<typeof reportQueue>;

beforeAll(async () => {
  await prepareDatabase();
  api = await startTestApi();
  queue = reportQueue();
});

afterAll(async () => {
  await api.close();
  await queue.close();
  await rm(TEST_REPORT_STORAGE, { recursive: true, force: true });
});

beforeEach(async () => {
  await resetDatabase();
  await queue.obliterate({ force: true });
});

const DAY = 24 * 60 * 60 * 1000;

interface ReportBody {
  id: string;
  status: string;
  template: string;
  format: string;
  includesEvidence: boolean;
  expiresAt: string | null;
  expired: boolean;
  coverageLimitations: string[] | null;
  filters: { minSeverity: string | null; triageStates: string[] };
  share: { active: boolean; expiresAt: string | null };
  failureReason: string | null;
}

async function world(role: TestSession["role"] = "ANALYST") {
  const session = await createSession(role);
  const target = await createVerifiedTarget(session.organizationId);
  const scan = await completedScan(session, target);
  return { session, target, scan };
}

function completedScan(session: TestSession, target: TestTarget, daysAgo = 0) {
  return createCompletedScan(prisma, {
    organizationId: session.organizationId,
    targetId: target.id,
    createdById: session.userId,
    completedAt: new Date(Date.now() - daysAgo * DAY),
  });
}

function findingIn(
  scan: { id: string; targetId: string },
  fingerprint: string,
  extra: Partial<FindingInput> = {},
) {
  return createFinding(prisma, {
    scanJobId: scan.id,
    targetId: scan.targetId,
    fingerprint,
    name: `Finding ${fingerprint}`,
    ...extra,
  });
}

async function requestReport(
  session: TestSession,
  body: Record<string, unknown>,
): Promise<Response> {
  return request(api, session, "/api/reports", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

/** Request a report and generate it, returning the READY row. */
async function generated(
  session: TestSession,
  body: Record<string, unknown>,
): Promise<ReportBody> {
  const res = await requestReport(session, body);
  expect(res.status).toBe(202);
  const { report } = (await res.json()) as { report: ReportBody };
  expect(await generateReport(report.id)).toBe("READY");
  const detail = await request(api, session, `/api/reports/${report.id}`);
  return ((await detail.json()) as { report: ReportBody }).report;
}

function download(session: TestSession, id: string): Promise<Response> {
  return request(api, session, `/api/reports/${id}/download`);
}

async function downloadJson(session: TestSession, id: string) {
  const res = await download(session, id);
  expect(res.status).toBe(200);
  return (await res.json()) as {
    coverageLimitations: string[];
    findings: { fingerprint: string; evidence?: { status: string } }[];
    trend: { scanId: string; total: number }[];
    summary: { total: number; diff: Record<string, number> | null };
  };
}

// ----------------------------------------------------------------- request ---

describe("requesting a report", () => {
  test("queues it, audits the export and hands the job to the queue", async () => {
    const { session, scan } = await world();
    const res = await requestReport(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });
    expect(res.status).toBe(202);
    const { report } = (await res.json()) as { report: ReportBody };
    expect(report.status).toBe("QUEUED");
    expect(report.coverageLimitations).toBeNull();

    const job = await queue.getJob(report.id);
    expect(job?.data).toEqual({ reportId: report.id });

    const audit = await prisma.auditLog.findMany({
      where: { action: "REPORT_EXPORTED", resourceId: report.id },
    });
    expect(audit).toHaveLength(1);
    expect(audit[0]!.userId).toBe(session.userId);
    expect(audit[0]!.metadata).toMatchObject({
      scanJobId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });
  });

  test("is refused for a scan that has not completed", async () => {
    const { session, target } = await world();
    const running = await prisma.scanJob.create({
      data: {
        organizationId: session.organizationId,
        targetId: target.id,
        status: "RUNNING",
      },
    });
    const res = await requestReport(session, {
      scanId: running.id,
      template: "TECHNICAL_REPORT",
      format: "JSON",
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({
      code: "SCAN_NOT_COMPLETED",
      scanStatus: "RUNNING",
    });
  });

  test("does not find another organisation's scan", async () => {
    const { scan } = await world();
    const stranger = await createSession("ANALYST");
    const res = await requestReport(stranger, {
      scanId: scan.id,
      template: "TECHNICAL_REPORT",
      format: "JSON",
    });
    expect(res.status).toBe(404);
  });

  test("reports every invalid member at once", async () => {
    const { session, scan } = await world();
    const res = await requestReport(session, {
      scanId: scan.id,
      template: "SUMMARY",
      format: "DOCX",
      minSeverity: "SEVERE",
      extra: true,
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { pointer: string }[] };
    const pointers = body.errors.map((e) => e.pointer);
    expect(pointers).toEqual(
      expect.arrayContaining(["/template", "/format", "/minSeverity"]),
    );
  });

  test("is open to VIEWER, whose need is an exportable summary", async () => {
    const { session, scan } = await world("VIEWER");
    const res = await requestReport(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });
    expect(res.status).toBe(202);
  });
});

// -------------------------------------------------------------- generation ---

describe("generation", () => {
  test("produces every format as a downloadable attachment", async () => {
    const { session, scan } = await world();
    await findingIn(scan, "fp-1", { severity: "HIGH" });

    const expectations = {
      PDF: "application/pdf",
      HTML: "text/html; charset=utf-8",
      JSON: "application/json; charset=utf-8",
      CSV: "text/csv; charset=utf-8",
      SARIF: "application/sarif+json",
    } as const;

    for (const [format, contentType] of Object.entries(expectations)) {
      const report = await generated(session, {
        scanId: scan.id,
        template: "TECHNICAL_REPORT",
        format,
      });
      expect(report.status).toBe("READY");
      const res = await download(session, report.id);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe(contentType);
      expect(res.headers.get("content-disposition")).toStartWith(
        'attachment; filename="wvs-technical-report-target-',
      );
      expect(res.headers.get("content-security-policy")).toContain("sandbox");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(0);
    }
  });

  test("stores the coverage limitations the file states", async () => {
    const { session, scan } = await world();
    await prisma.scanJob.update({
      where: { id: scan.id },
      data: { bindingLimit: "PAGE_CEILING_REACHED", excludedPaths: ["/admin"] },
    });
    const report = await generated(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "JSON",
    });
    expect(report.coverageLimitations![0]).toBe(UNAUTHENTICATED_LIMITATION);
    expect(report.coverageLimitations!.join("\n")).toContain("page ceiling");

    const body = await downloadJson(session, report.id);
    expect(body.coverageLimitations).toEqual(report.coverageLimitations!);
    expect(body.coverageLimitations.join("\n")).toContain("/admin");
  });

  test("applies the severity threshold and triage filter", async () => {
    const { session, scan } = await world();
    await findingIn(scan, "fp-critical", { severity: "CRITICAL" });
    await findingIn(scan, "fp-high-accepted", { severity: "HIGH" });
    await findingIn(scan, "fp-low", { severity: "LOW" });
    await recordTriage(prisma, {
      targetId: scan.targetId,
      fingerprint: "fp-high-accepted",
      state: "ACCEPTED_RISK",
      justification: "Compensating control",
    });

    const report = await generated(session, {
      scanId: scan.id,
      template: "TECHNICAL_REPORT",
      format: "JSON",
      minSeverity: "HIGH",
      triageStates: ["OPEN", "CONFIRMED"],
    });
    expect(report.filters).toEqual({
      minSeverity: "HIGH",
      triageStates: ["OPEN", "CONFIRMED"],
    });
    const body = await downloadJson(session, report.id);
    expect(body.findings.map((f) => f.fingerprint)).toEqual(["fp-critical"]);
    expect(body.coverageLimitations.join("\n")).toContain("HIGH severity or higher");
  });

  test("an executive summary carries no evidence, whoever asks", async () => {
    const { session, scan } = await world();
    const finding = await findingIn(scan, "fp-1");
    await createEvidence(prisma, finding.id);
    const report = await generated(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "JSON",
    });
    expect(report.includesEvidence).toBe(false);
    const body = await downloadJson(session, report.id);
    expect(body.findings[0]!.evidence).toBeUndefined();
  });

  test("a technical report shows only confirmed-redacted evidence (ADR-0010)", async () => {
    const { session, scan } = await world();
    const expiry = new Date(Date.now() + 10 * DAY);
    const shown = await findingIn(scan, "fp-shown");
    await createEvidence(prisma, shown.id, { expiresAt: expiry });
    const unredacted = await findingIn(scan, "fp-unredacted");
    await createEvidence(prisma, unredacted.id, { isRedacted: false });
    const purged = await findingIn(scan, "fp-purged");
    await createEvidence(prisma, purged.id, { isPurged: true });

    const report = await generated(session, {
      scanId: scan.id,
      template: "TECHNICAL_REPORT",
      format: "JSON",
    });
    expect(report.includesEvidence).toBe(true);
    // C.7: the file is not served past the evidence's retention expiry.
    expect(new Date(report.expiresAt!).getTime()).toBe(expiry.getTime());

    const body = await downloadJson(session, report.id);
    const status = Object.fromEntries(
      body.findings.map((f) => [f.fingerprint, f.evidence?.status]),
    );
    expect(status).toEqual({
      "fp-shown": "AVAILABLE",
      "fp-unredacted": "WITHHELD_UNREDACTED",
      "fp-purged": "PURGED",
    });
    expect(body.coverageLimitations.join("\n")).toContain("redaction has not been confirmed");
  });

  test("a VIEWER's technical report holds no raw evidence", async () => {
    const { session, scan } = await world("VIEWER");
    const finding = await findingIn(scan, "fp-1");
    await createEvidence(prisma, finding.id);
    const report = await generated(session, {
      scanId: scan.id,
      template: "TECHNICAL_REPORT",
      format: "JSON",
    });
    expect(report.includesEvidence).toBe(false);
    const body = await downloadJson(session, report.id);
    expect(body.findings[0]!.evidence?.status).toBe("WITHHELD_ROLE");
  });

  test("the trend covers earlier completed scans of the target", async () => {
    const { session, target } = await world();
    const older = await completedScan(session, target, 7);
    await findingIn(older, "fp-a");
    await findingIn(older, "fp-b");
    const latest = await completedScan(session, target, 1);
    await findingIn(latest, "fp-a");
    await createDiff(prisma, {
      scanJobId: latest.id,
      targetId: target.id,
      fingerprint: "fp-b",
      status: "RESOLVED",
    });
    await createDiff(prisma, {
      scanJobId: latest.id,
      targetId: target.id,
      fingerprint: "fp-a",
      status: "PERSISTING",
    });

    const report = await generated(session, {
      scanId: latest.id,
      template: "EXECUTIVE_SUMMARY",
      format: "JSON",
    });
    const body = await downloadJson(session, report.id);
    // The world() scan completed "now", after `latest`, so it is not in the
    // trend of a report on `latest`.
    expect(body.trend.map((p) => [p.scanId, p.total])).toEqual([
      [older.id, 2],
      [latest.id, 1],
    ]);
    expect(body.summary.diff).toEqual({ NEW: 0, PERSISTING: 1, RESOLVED: 1 });
  });

  test("generation is idempotent across deliveries", async () => {
    const { session, scan } = await world();
    const report = await generated(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "CSV",
    });
    expect(await generateReport(report.id)).toBe("SKIPPED");
  });

  test("a report the queue gave up on is marked failed", async () => {
    const { session, scan } = await world();
    const res = await requestReport(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });
    const { report } = (await res.json()) as { report: ReportBody };
    await markReportFailed(report.id);
    const detail = await request(api, session, `/api/reports/${report.id}`);
    const body = ((await detail.json()) as { report: ReportBody }).report;
    expect(body.status).toBe("FAILED");
    expect(body.failureReason).toBeString();
    // A failed report cannot be generated later by a stray delivery.
    expect(await generateReport(report.id)).toBe("SKIPPED");
  });
});

// ------------------------------------------------------------ reads/download ---

describe("reading and downloading", () => {
  test("lists the organisation's reports, newest first, filterable by scan", async () => {
    const { session, target, scan } = await world();
    const other = await completedScan(session, target, 2);
    for (const scanId of [scan.id, other.id]) {
      await requestReport(session, { scanId, template: "EXECUTIVE_SUMMARY", format: "PDF" });
    }
    const stranger = await world();
    await requestReport(stranger.session, {
      scanId: stranger.scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });

    const all = await request(api, session, "/api/reports");
    const { reports } = (await all.json()) as { reports: { scan: { id: string } }[] };
    expect(reports.map((r) => r.scan.id)).toEqual([other.id, scan.id]);

    const one = await request(api, session, `/api/reports?scanId=${scan.id}`);
    const filtered = (await one.json()) as { reports: unknown[] };
    expect(filtered.reports).toHaveLength(1);
  });

  test("does not find another organisation's report", async () => {
    const { session, scan } = await world();
    const report = await generated(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });
    const stranger = await createSession("ADMIN");
    expect((await request(api, stranger, `/api/reports/${report.id}`)).status).toBe(404);
    expect((await download(stranger, report.id)).status).toBe(404);
  });

  test("a report still generating cannot be downloaded", async () => {
    const { session, scan } = await world();
    const res = await requestReport(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });
    const { report } = (await res.json()) as { report: ReportBody };
    const dl = await download(session, report.id);
    expect(dl.status).toBe(409);
    expect(await dl.json()).toMatchObject({ code: "REPORT_NOT_READY" });
  });

  test("a VIEWER cannot download a colleague's report that holds evidence", async () => {
    const { session, scan } = await world();
    const finding = await findingIn(scan, "fp-1");
    await createEvidence(prisma, finding.id);
    const report = await generated(session, {
      scanId: scan.id,
      template: "TECHNICAL_REPORT",
      format: "PDF",
    });

    const viewer = await createSession("VIEWER");
    await prisma.member.update({
      where: { userId: viewer.userId },
      data: { organizationId: session.organizationId },
    });
    await prisma.session.updateMany({
      where: { userId: viewer.userId },
      data: { activeOrganizationId: session.organizationId },
    });

    const res = await download(viewer, report.id);
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "EVIDENCE_WITHHELD" });
  });

  test("a report whose evidence has passed retention is gone (C.7)", async () => {
    const { session, scan } = await world();
    const finding = await findingIn(scan, "fp-1");
    await createEvidence(prisma, finding.id);
    const report = await generated(session, {
      scanId: scan.id,
      template: "TECHNICAL_REPORT",
      format: "HTML",
    });
    await prisma.scanReport.update({
      where: { id: report.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const res = await download(session, report.id);
    expect(res.status).toBe(410);
    expect(await res.json()).toMatchObject({ code: "REPORT_EXPIRED" });
  });
});

// ------------------------------------------------------------------ sharing ---

describe("share links", () => {
  async function share(session: TestSession, id: string, body: Record<string, unknown> = {}) {
    return request(api, session, `/api/reports/${id}/share`, {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  async function readyReport(role: TestSession["role"] = "ANALYST") {
    const { session, scan } = await world(role);
    const report = await generated(session, {
      scanId: scan.id,
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
    });
    return { session, report };
  }

  test("serve the file without a session until they expire", async () => {
    const { session, report } = await readyReport();
    const res = await share(session, report.id, { expiresInDays: 3 });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { sharePath: string; report: ReportBody };
    expect(body.sharePath).toMatch(/^\/api\/reports\/shared\/[A-Za-z0-9_-]{43}$/);
    expect(body.report.share.active).toBe(true);

    const shared = await fetch(`${api.baseUrl}${body.sharePath}`);
    expect(shared.status).toBe(200);
    expect(shared.headers.get("content-type")).toBe("application/pdf");

    // Only the hash is stored, never the token.
    const token = body.sharePath.split("/").pop()!;
    const row = await prisma.scanReport.findUniqueOrThrow({ where: { id: report.id } });
    expect(row.shareTokenHash).not.toBe(token);
    expect(row.shareTokenHash).toHaveLength(64);

    const audit = await prisma.auditLog.findMany({
      where: { action: "REPORT_SHARED", resourceId: report.id },
    });
    expect(audit).toHaveLength(1);

    await prisma.scanReport.update({
      where: { id: report.id },
      data: { shareExpiresAt: new Date(Date.now() - 1000) },
    });
    expect((await fetch(`${api.baseUrl}${body.sharePath}`)).status).toBe(404);
  });

  test("stop working when revoked or replaced", async () => {
    const { session, report } = await readyReport();
    const first = (await (await share(session, report.id)).json()) as { sharePath: string };
    const second = (await (await share(session, report.id)).json()) as { sharePath: string };
    expect((await fetch(`${api.baseUrl}${first.sharePath}`)).status).toBe(404);
    expect((await fetch(`${api.baseUrl}${second.sharePath}`)).status).toBe(200);

    const revoked = await request(api, session, `/api/reports/${report.id}/share`, {
      method: "DELETE",
    });
    expect(revoked.status).toBe(200);
    expect(((await revoked.json()) as { report: ReportBody }).report.share.active).toBe(false);
    expect((await fetch(`${api.baseUrl}${second.sharePath}`)).status).toBe(404);
    expect(
      await prisma.auditLog.count({
        where: { action: "REPORT_SHARE_REVOKED", resourceId: report.id },
      }),
    ).toBe(1);
  });

  test("never outlive the evidence in the file", async () => {
    const { session, scan } = await world();
    const finding = await findingIn(scan, "fp-1");
    const expiry = new Date(Date.now() + 2 * DAY);
    await createEvidence(prisma, finding.id, { expiresAt: expiry });
    const report = await generated(session, {
      scanId: scan.id,
      template: "TECHNICAL_REPORT",
      format: "PDF",
    });
    const res = await share(session, report.id, { expiresInDays: 30 });
    const body = (await res.json()) as { report: ReportBody };
    expect(new Date(body.report.share.expiresAt!).getTime()).toBe(expiry.getTime());
  });

  test("need a write role and a sensible lifetime", async () => {
    const viewer = await readyReport("VIEWER");
    expect((await share(viewer.session, viewer.report.id)).status).toBe(403);

    const { session, report } = await readyReport();
    expect((await share(session, report.id, { expiresInDays: 31 })).status).toBe(400);
    expect((await share(session, report.id, { expiresInDays: 0 })).status).toBe(400);
  });

  test("an unknown token is simply not found", async () => {
    const res = await fetch(`${api.baseUrl}/api/reports/shared/not-a-real-token`);
    expect(res.status).toBe(404);
  });
});
