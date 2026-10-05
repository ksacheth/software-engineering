// @ts-ignore
import { describe, expect, test, beforeEach } from "bun:test";
import { ScanOrchestrator } from "./orchestrator/scan-orchestrator.js";
import { AdvisoryEnricher } from "./enrichers/advisory-enricher.js";
import type { RawFinding } from "./detectors/mock-detector.js";
import { MockPrisma, MockRedisPublisher } from "./test-support/mock-prisma.js";

describe("Jasmine Worker Pipeline Integration Test", () => {
  let db: MockPrisma;
  let redis: MockRedisPublisher;

  beforeEach(() => {
    db = new MockPrisma();
    redis = new MockRedisPublisher();

    db.scanJobs.set("scan-pipeline-1", {
      id: "scan-pipeline-1",
      targetId: "target-juice-shop",
      organizationId: "org-1",
      profile: "STANDARD",
      status: "QUEUED",
      phase: "DISCOVERY",
      attempt: 1,
      startedAt: null,
    });
  });

  test("executes complete vertical worker pipeline: Queue Job -> Crawl -> Detector -> Dedup -> Advisory Enrich -> Triage -> DB Persistence", async () => {
    const mockOsv = {
      queryPackage: async () => [
        {
          id: "GHSA-juice-01",
          summary: "Juice Shop Dependency Vulnerability",
          aliases: ["CVE-2023-5555"],
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
        },
      ],
    };

    const mockEpss = {
      getScore: async (cve: string) => ({
        cve,
        epss: 0.941,
        percentile: 0.985,
      }),
    };

    const enricher = new AdvisoryEnricher(mockOsv as any, mockEpss as any);

    // Custom detector returning multiple duplicate raw findings + 1 vulnerable component
    const integratedDetector = (): RawFinding[] => [
      // Duplicate XSS findings on same page/param
      {
        detectorId: "A-01",
        name: "Reflected XSS",
        description: "XSS on search",
        remediation: "Encode output",
        severity: "HIGH",
        confidence: "FIRM",
        affectedUrl: "http://localhost:3000/search",
        affectedParameter: "q",
      },
      {
        detectorId: "A-01",
        name: "Reflected XSS",
        description: "XSS on search duplicate",
        remediation: "Encode output",
        severity: "HIGH",
        confidence: "FIRM",
        affectedUrl: "http://localhost:3000/search",
        affectedParameter: "q",
      },
      // Component finding requiring enrichment
      {
        detectorId: "P-18",
        name: "Vulnerable Component",
        description: "Vulnerable node module",
        remediation: "Upgrade",
        severity: "HIGH",
        confidence: "CONFIRMED",
        affectedUrl: "http://localhost:3000/package.json",
        affectedParameter: null,
        evidence: { component: "express@4.17.1" } as any,
      },
    ];

    const orchestrator = new ScanOrchestrator({
      prisma: db.asClient(),
      redis,
      detector: integratedDetector,
      enricher,
    });

    await orchestrator.processScanJob({
      scanJobId: "scan-pipeline-1",
      organizationId: "org-1",
      attempt: 1,
    });

    // 1. Verify ScanJob status and progress
    const finishedJob = db.scanJobs.get("scan-pipeline-1");
    expect(finishedJob.status).toBe("COMPLETED");
    expect(finishedJob.phase).toBe("COMPLETED");
    expect(finishedJob.progressPercentage).toBe(100.0);
    expect(finishedJob.completedAt).toBeDefined();

    // 2. Verify Deduplication (2 XSS findings collapsed into 1 master finding with occurrenceCount 2)
    const persistedFindings = Array.from(db.findings.values());
    expect(persistedFindings.length).toBe(2);

    const xssFinding = persistedFindings.find((f) => f.detectorId === "A-01");
    expect(xssFinding).toBeDefined();
    expect(xssFinding.occurrenceCount).toBe(2);

    // 3. Verify Intelligence Enrichment (P-18 enriched with CVE-2023-5555 and EPSS score 0.941)
    const componentFinding = persistedFindings.find((f) => f.detectorId === "P-18");
    expect(componentFinding).toBeDefined();
    expect(componentFinding.cveId).toBe("CVE-2023-5555");
    expect(componentFinding.epssScore).toBe(0.941);
    expect(componentFinding.epssPercentile).toBe(0.985);
    expect(componentFinding.cvssVector).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H");

    // 4. Verify Redis Events
    const statusEvents = redis.events.filter((e) => e.type === "scan.status");
    const progressEvents = redis.events.filter((e) => e.type === "scan.progress");
    const findingEvents = redis.events.filter((e) => e.type === "scan.finding");

    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(findingEvents.length).toBe(2);

    // 5. Verify diff records against the (empty) history: both findings are NEW
    expect(db.scanFindingDiffs.map((d) => d.status)).toEqual(["NEW", "NEW"]);
    expect(finishedJob.findingsCount).toBe(2);
  });

  test("a rescan marks repeated findings PERSISTING and missing ones RESOLVED", async () => {
    const xss = (url: string): RawFinding => ({
      detectorId: "A-01",
      name: "Reflected XSS",
      description: "XSS",
      remediation: "Encode output",
      severity: "HIGH",
      confidence: "FIRM",
      affectedUrl: url,
      affectedParameter: "q",
    });
    const run = (id: string, findings: RawFinding[]) => {
      db.scanJobs.set(id, { ...db.scanJobs.get("scan-pipeline-1"), id, status: "QUEUED" });
      return new ScanOrchestrator({
        prisma: db.asClient(),
        detector: () => findings,
        enricher: new AdvisoryEnricher({ queryPackage: async () => [] } as any, { getScore: async () => null } as any),
      }).processScanJob({ scanJobId: id, organizationId: "org-1", attempt: 1 });
    };

    await run("scan-first", [xss("http://localhost:3000/a"), xss("http://localhost:3000/b")]);
    await run("scan-second", [xss("http://localhost:3000/a")]);

    const second = db.scanFindingDiffs.filter((d) => d.scanJobId === "scan-second");
    expect(second.map((d) => d.status).sort()).toEqual(["PERSISTING", "RESOLVED"]);
  });
});
