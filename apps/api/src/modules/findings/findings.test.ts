import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
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

/**
 * F.6 findings, exercised through the running API against real Postgres.
 *
 * The projection trigger, the append-only history and the organisation
 * boundary are the things most worth catching here, and all three live in the
 * database, so nothing below mocks it.
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
  id: string;
  fingerprint: string;
  scanJobId: string;
  name: string;
  severity: string;
  cvssScore: number | null;
  diffStatus: string | null;
  triage: { state: string; justification: string | null };
}

interface ListBody {
  findings: Summary[];
  nextCursor: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

async function world(role: TestSession["role"] = "ANALYST") {
  const session = await createSession(role);
  const target = await createVerifiedTarget(session.organizationId);
  return { session, target };
}

function scanOf(session: TestSession, target: TestTarget, daysAgo = 0) {
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

async function list(session: TestSession, query = ""): Promise<ListBody> {
  const res = await request(api, session, `/api/findings${query}`);
  expect(res.status).toBe(200);
  return (await res.json()) as ListBody;
}

function triage(
  session: TestSession,
  findingId: string,
  body: Record<string, unknown>,
) {
  return request(api, session, `/api/findings/${findingId}/triage`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

describe("current posture", () => {
  test("shows only the most recent completed scan of each target", async () => {
    const { session, target } = await world();
    const older = await scanOf(session, target, 5);
    const latest = await scanOf(session, target, 1);
    await findingIn(older, "fp-old");
    await findingIn(latest, "fp-new");

    // A scan still running is not the posture, however recent.
    const running = await prisma.scanJob.create({
      data: {
        organizationId: session.organizationId,
        targetId: target.id,
        status: "RUNNING",
      },
    });
    await findingIn({ id: running.id, targetId: target.id }, "fp-running");

    const body = await list(session);
    expect(body.findings.map((f) => f.fingerprint)).toEqual(["fp-new"]);
  });

  test("covers every target, and leaves archived targets out", async () => {
    const { session, target } = await world();
    const second = await createVerifiedTarget(session.organizationId);
    const archived = await createVerifiedTarget(session.organizationId);
    await prisma.target.update({
      where: { id: archived.id },
      data: { isArchived: true, archivedAt: new Date() },
    });
    await findingIn(await scanOf(session, target), "fp-a");
    await findingIn(await scanOf(session, second), "fp-b");
    await findingIn(await scanOf(session, archived), "fp-archived");

    const body = await list(session);
    expect(body.findings.map((f) => f.fingerprint).sort()).toEqual([
      "fp-a",
      "fp-b",
    ]);

    // Asked for by name, an archived target's posture is still readable.
    const named = await list(session, `?targetId=${archived.id}`);
    expect(named.findings.map((f) => f.fingerprint)).toEqual(["fp-archived"]);
  });

  test("hides findings judged false positive or accepted, until asked", async () => {
    const { session, target } = await world();
    const scan = await scanOf(session, target);
    await findingIn(scan, "fp-open");
    await findingIn(scan, "fp-confirmed");
    await findingIn(scan, "fp-false");
    await findingIn(scan, "fp-accepted");
    await findingIn(scan, "fp-resolved");
    await recordTriage(prisma, { targetId: target.id, fingerprint: "fp-confirmed", state: "CONFIRMED" });
    await recordTriage(prisma, { targetId: target.id, fingerprint: "fp-false", state: "FALSE_POSITIVE", justification: "Static asset" });
    await recordTriage(prisma, { targetId: target.id, fingerprint: "fp-accepted", state: "ACCEPTED_RISK", justification: "Legacy" });
    await recordTriage(prisma, { targetId: target.id, fingerprint: "fp-resolved", state: "RESOLVED" });

    const actionable = await list(session);
    expect(actionable.findings.map((f) => f.fingerprint).sort()).toEqual([
      "fp-confirmed",
      "fp-open",
    ]);

    const all = await list(session, "?triage=all");
    expect(all.findings).toHaveLength(5);

    const hidden = await list(session, "?triage=FALSE_POSITIVE,ACCEPTED_RISK");
    expect(hidden.findings.map((f) => f.fingerprint).sort()).toEqual([
      "fp-accepted",
      "fp-false",
    ]);
  });

  test("reports an untriaged finding as OPEN", async () => {
    const { session, target } = await world();
    await findingIn(await scanOf(session, target), "fp-1");

    const body = await list(session);
    expect(body.findings[0]!.triage).toMatchObject({
      state: "OPEN",
      justification: null,
    });
  });

  test("never includes another organisation's findings", async () => {
    const { session } = await world();
    const other = await world();
    await findingIn(await scanOf(other.session, other.target), "fp-theirs");

    const body = await list(session);
    expect(body.findings).toEqual([]);
  });
});

describe("one scan's findings", () => {
  test("lists that scan whole, with diff status", async () => {
    const { session, target } = await world();
    const scan = await scanOf(session, target);
    await findingIn(scan, "fp-new");
    await findingIn(scan, "fp-kept");
    await createDiff(prisma, { scanJobId: scan.id, targetId: target.id, fingerprint: "fp-new", status: "NEW" });
    await createDiff(prisma, { scanJobId: scan.id, targetId: target.id, fingerprint: "fp-kept", status: "PERSISTING" });
    // A false positive is still part of the scan's record.
    await recordTriage(prisma, { targetId: target.id, fingerprint: "fp-kept", state: "FALSE_POSITIVE", justification: "Known" });

    const body = await list(session, `?scanId=${scan.id}&sort=name&direction=asc`);
    expect(
      body.findings.map((f) => [f.fingerprint, f.diffStatus, f.triage.state]),
    ).toEqual([
      ["fp-kept", "PERSISTING", "FALSE_POSITIVE"],
      ["fp-new", "NEW", "OPEN"],
    ]);

    const onlyNew = await list(session, `?scanId=${scan.id}&diff=NEW`);
    expect(onlyNew.findings.map((f) => f.fingerprint)).toEqual(["fp-new"]);
  });

  test("does not find another organisation's scan", async () => {
    const { session } = await world();
    const other = await world();
    const theirs = await scanOf(other.session, other.target);

    const res = await request(api, session, `/api/findings?scanId=${theirs.id}`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("application/problem+json");
  });

  test("lists what was resolved since the previous scan", async () => {
    const { session, target } = await world();
    const previous = await scanOf(session, target, 3);
    const current = await scanOf(session, target, 1);
    const gone = await findingIn(previous, "fp-gone", { severity: "HIGH" });
    await findingIn(previous, "fp-still");
    await findingIn(current, "fp-still");
    await createDiff(prisma, { scanJobId: current.id, targetId: target.id, fingerprint: "fp-gone", status: "RESOLVED" });
    await createDiff(prisma, { scanJobId: current.id, targetId: target.id, fingerprint: "fp-still", status: "PERSISTING" });

    const res = await request(api, session, `/api/findings/resolved?scanId=${current.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { findings: Summary[] };
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]).toMatchObject({
      id: gone.id,
      fingerprint: "fp-gone",
      diffStatus: "RESOLVED",
    });
  });
});

describe("filtering and sorting", () => {
  test("filters by severity, confidence and text", async () => {
    const { session, target } = await world();
    const scan = await scanOf(session, target);
    await findingIn(scan, "fp-xss", { name: "Reflected Cross-Site Scripting", severity: "HIGH", affectedUrl: "https://app.example.test/search?q=1" });
    await findingIn(scan, "fp-sqli", { name: "SQL Injection (error-based)", severity: "CRITICAL", confidence: "FIRM" });
    await findingIn(scan, "fp-hsts", { name: "Missing HSTS", severity: "LOW" });

    const severe = await list(session, "?severity=HIGH,CRITICAL");
    expect(severe.findings.map((f) => f.fingerprint).sort()).toEqual(["fp-sqli", "fp-xss"]);

    const firm = await list(session, "?confidence=FIRM");
    expect(firm.findings.map((f) => f.fingerprint)).toEqual(["fp-sqli"]);

    const byUrl = await list(session, "?q=SEARCH");
    expect(byUrl.findings.map((f) => f.fingerprint)).toEqual(["fp-xss"]);
  });

  test("pages through a sort with unscored findings exactly once, in order", async () => {
    const { session, target } = await world();
    const scan = await scanOf(session, target);
    const rows: [string, "CRITICAL" | "HIGH" | "MEDIUM" | "LOW", number | null][] = [
      ["a", "HIGH", 7.5],
      ["b", "HIGH", null],
      ["c", "CRITICAL", 9.8],
      ["d", "MEDIUM", 5.3],
      ["e", "HIGH", 8.1],
      ["f", "LOW", null],
      ["g", "MEDIUM", null],
    ];
    for (const [fingerprint, severity, cvssScore] of rows) {
      await findingIn(scan, fingerprint, { severity, cvssScore });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${cursor}` : ""}`;
      const page: ListBody = await list(session, query);
      seen.push(...page.findings.map((f) => f.fingerprint));
      cursor = page.nextCursor;
    } while (cursor);

    // Severity descending, then CVSS descending with unscored last.
    expect(seen).toEqual(["c", "e", "a", "b", "d", "g", "f"]);

    const byCvss: string[] = [];
    cursor = null;
    do {
      const query: string = `?sort=cvss&direction=asc&limit=3${cursor ? `&cursor=${cursor}` : ""}`;
      const page: ListBody = await list(session, query);
      byCvss.push(...page.findings.map((f) => f.fingerprint));
      cursor = page.nextCursor;
    } while (cursor);
    expect(byCvss.slice(0, 4)).toEqual(["d", "a", "e", "c"]);
    expect(byCvss.slice(4).sort()).toEqual(["b", "f", "g"]);
  });

  test("refuses a cursor issued for a different sort", async () => {
    const { session, target } = await world();
    const scan = await scanOf(session, target);
    await findingIn(scan, "fp-1");
    await findingIn(scan, "fp-2");

    const first = await list(session, "?limit=1");
    const res = await request(api, session, `/api/findings?sort=name&cursor=${first.nextCursor}`);
    expect(res.status).toBe(400);
  });

  test("reports every invalid parameter at once", async () => {
    const { session } = await world();
    const res = await request(api, session, "/api/findings?severity=SEVERE&limit=0&sort=colour");
    expect(res.status).toBe(400);
    const body = (await res.json()) as { errors: { pointer: string }[] };
    expect(body.errors.map((e) => e.pointer).sort()).toEqual(["/limit", "/severity", "/sort"]);
  });
});

interface DetailBody {
  finding: Summary & {
    description: string;
    remediation: string;
    seen: { scans: number };
    evidence: { status: string; responseBody?: string };
    triageHistory: { state: string; justification: string | null; user: { id: string } | null }[];
  };
}

async function detail(session: TestSession, id: string): Promise<DetailBody["finding"]> {
  const res = await request(api, session, `/api/findings/${id}`);
  expect(res.status).toBe(200);
  return ((await res.json()) as DetailBody).finding;
}

describe("finding detail and evidence", () => {
  test("returns the full finding with evidence confirmed redacted", async () => {
    const { session, target } = await world();
    const earlier = await scanOf(session, target, 4);
    const scan = await scanOf(session, target, 1);
    await findingIn(earlier, "fp-1");
    const finding = await findingIn(scan, "fp-1");
    await createEvidence(prisma, finding.id, { responseBody: "<p>body</p>" });

    const body = await detail(session, finding.id);
    expect(body.description).toContain("Content-Security-Policy");
    expect(body.remediation).toContain("default-src");
    expect(body.seen.scans).toBe(2);
    expect(body.evidence).toMatchObject({ status: "AVAILABLE", responseBody: "<p>body</p>" });
  });

  test("withholds evidence whose redaction is not confirmed", async () => {
    const { session, target } = await world();
    const finding = await findingIn(await scanOf(session, target), "fp-1");
    await createEvidence(prisma, finding.id, { isRedacted: false, responseBody: "Set-Cookie: live" });

    const body = await detail(session, finding.id);
    expect(body.evidence.status).toBe("WITHHELD_UNREDACTED");
    expect(JSON.stringify(body)).not.toContain("Set-Cookie: live");
  });

  test("reports purged evidence as purged", async () => {
    const { session, target } = await world();
    const finding = await findingIn(await scanOf(session, target), "fp-1");
    await createEvidence(prisma, finding.id, { isPurged: true });

    expect((await detail(session, finding.id)).evidence.status).toBe("PURGED");
  });

  test("withholds raw evidence from a viewer", async () => {
    const { session, target } = await world("VIEWER");
    const finding = await findingIn(await scanOf(session, target), "fp-1");
    await createEvidence(prisma, finding.id, { responseBody: "<p>body</p>" });

    const body = await detail(session, finding.id);
    expect(body.evidence.status).toBe("WITHHELD_ROLE");
    expect(JSON.stringify(body)).not.toContain("<p>body</p>");
    expect(body.description).toContain("Content-Security-Policy");
  });

  test("does not find another organisation's finding", async () => {
    const { session } = await world();
    const other = await world();
    const theirs = await findingIn(await scanOf(other.session, other.target), "fp-1");

    const res = await request(api, session, `/api/findings/${theirs.id}`);
    expect(res.status).toBe(404);
  });
});

describe("triage", () => {
  test("records the decision in history, the projection and the audit log", async () => {
    const { session, target } = await world();
    const finding = await findingIn(await scanOf(session, target), "fp-1");

    const res = await triage(session, finding.id, { state: "CONFIRMED" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { changed: boolean; finding: DetailBody["finding"] };
    expect(body.changed).toBe(true);
    expect(body.finding.triage.state).toBe("CONFIRMED");
    expect(body.finding.triageHistory).toHaveLength(1);
    expect(body.finding.triageHistory[0]!.user?.id).toBe(session.userId);

    const projection = await prisma.targetFindingTriage.findUniqueOrThrow({
      where: { targetId_findingFingerprint: { targetId: target.id, findingFingerprint: "fp-1" } },
    });
    expect(projection.state).toBe("CONFIRMED");

    const audit = await prisma.auditLog.findMany({ where: { action: "FINDING_TRIAGED" } });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ userId: session.userId, resourceId: finding.id });
    expect(audit[0]!.metadata).toMatchObject({ from: "OPEN", to: "CONFIRMED", fingerprint: "fp-1" });
  });

  test("writes nothing when the state and justification are unchanged", async () => {
    const { session, target } = await world();
    const finding = await findingIn(await scanOf(session, target), "fp-1");
    const decision = { state: "ACCEPTED_RISK", justification: "Behind VPN" };

    await triage(session, finding.id, decision);
    const again = await triage(session, finding.id, decision);
    expect(((await again.json()) as { changed: boolean }).changed).toBe(false);

    expect(await prisma.findingTriageHistory.count()).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: "FINDING_TRIAGED" } })).toBe(1);
  });

  test("requires a justification to hide risk", async () => {
    const { session, target } = await world();
    const finding = await findingIn(await scanOf(session, target), "fp-1");

    for (const state of ["FALSE_POSITIVE", "ACCEPTED_RISK"]) {
      const res = await triage(session, finding.id, { state, justification: "   " });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { errors: { pointer: string }[] };
      expect(body.errors[0]!.pointer).toBe("/justification");
    }
    expect(await prisma.findingTriageHistory.count()).toBe(0);

    const reopened = await triage(session, finding.id, { state: "RESOLVED" });
    expect(reopened.status).toBe(200);
  });

  test("carries a decision to the same finding in other scans of the target", async () => {
    const { session, target } = await world();
    const old = await findingIn(await scanOf(session, target, 3), "fp-1");
    const latest = await findingIn(await scanOf(session, target, 1), "fp-1");

    await triage(session, old.id, { state: "FALSE_POSITIVE", justification: "Static page" });

    expect((await detail(session, latest.id)).triage).toMatchObject({
      state: "FALSE_POSITIVE",
      justification: "Static page",
    });
  });

  test("is refused to a viewer", async () => {
    const { session, target } = await world("VIEWER");
    const finding = await findingIn(await scanOf(session, target), "fp-1");

    const res = await triage(session, finding.id, { state: "CONFIRMED" });
    expect(res.status).toBe(403);
    expect(await prisma.findingTriageHistory.count()).toBe(0);
  });

  test("does not reach another organisation's finding", async () => {
    const { session } = await world();
    const other = await world();
    const theirs = await findingIn(await scanOf(other.session, other.target), "fp-1");

    const res = await triage(session, theirs.id, { state: "CONFIRMED" });
    expect(res.status).toBe(404);
    expect(await prisma.findingTriageHistory.count()).toBe(0);
  });
});

describe("bulk triage", () => {
  function bulk(session: TestSession, body: Record<string, unknown>) {
    return request(api, session, "/api/findings/triage", {
      method: "POST",
      body: JSON.stringify(body),
    });
  }

  test("triages many findings, counting one fingerprint once", async () => {
    const { session, target } = await world();
    const old = await findingIn(await scanOf(session, target, 3), "fp-1");
    const scan = await scanOf(session, target, 1);
    const a = await findingIn(scan, "fp-1");
    const b = await findingIn(scan, "fp-2");

    const res = await bulk(session, { findingIds: [old.id, a.id, b.id], state: "CONFIRMED" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ updated: 2, unchanged: 0 });
    expect(await prisma.findingTriageHistory.count()).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: "FINDING_TRIAGED" } })).toBe(2);
  });

  test("writes nothing if any finding is not the organisation's", async () => {
    const { session, target } = await world();
    const other = await world();
    const mine = await findingIn(await scanOf(session, target), "fp-1");
    const theirs = await findingIn(await scanOf(other.session, other.target), "fp-2");

    const res = await bulk(session, { findingIds: [mine.id, theirs.id], state: "CONFIRMED" });
    expect(res.status).toBe(404);
    expect(await prisma.findingTriageHistory.count()).toBe(0);
  });

  test("refuses more than a hundred findings", async () => {
    const { session } = await world();
    const ids = Array.from({ length: 101 }, (_, i) => `id-${i}`);

    const res = await bulk(session, { findingIds: ids, state: "CONFIRMED" });
    expect(res.status).toBe(400);
  });
});
