// @ts-ignore
import { describe, expect, test, beforeEach } from "bun:test";
import { ScanOrchestrator } from "./orchestrator/scan-orchestrator.js";
import { AdvisoryEnricher } from "./enrichers/advisory-enricher.js";
import type { RawFinding } from "./detectors/mock-detector.js";

class IntegrationMockPrisma {
  scanJobs = new Map<string, any>();
  crawledPages = new Map<string, any>();
  findings = new Map<string, any>();
  targetFindingTriage = new Map<string, any>();
  scanFindingDiffs: any[] = [];

  scanJob = {
    findUnique: async ({ where }: any) => this.scanJobs.get(where.id) || null,
    findFirst: async ({ where }: any) => {
      return (
        Array.from(this.scanJobs.values()).find(
          (j) =>
            j.targetId === where.targetId &&
            j.status === where.status &&
            (!where.id || j.id !== where.id.not)
        ) || null
      );
    },
    update: async ({ where, data }: any) => {
      const existing = this.scanJobs.get(where.id);
      if (!existing) throw new Error("ScanJob not found");
      const updated = { ...existing, ...data };
      this.scanJobs.set(where.id, updated);
      return updated;
    },
  };

  crawledPage = {
    findMany: async ({ where }: any) =>
      Array.from(this.crawledPages.values()).filter(
        (p) => p.scanJobId === where.scanJobId
      ),
    create: async ({ data }: any) => {
      const id = `page-${Math.random()}`;
      const page = { id, ...data };
      this.crawledPages.set(id, page);
      return page;
    },
  };

  finding = {
    findMany: async ({ where }: any) =>
      Array.from(this.findings.values()).filter(
        (f) => f.scanJobId === where.scanJobId
      ),
    findFirst: async ({ where }: any) =>
      Array.from(this.findings.values()).find(
        (f) =>
          f.scanJobId === where.scanJobId && f.fingerprint === where.fingerprint
      ) || null,
    create: async ({ data }: any) => {
      const id = `finding-${Math.random()}`;
      const finding = { id, ...data };
      this.findings.set(id, finding);
      return finding;
    },
  };

  targetFindingTriageRef = {
    findMany: async ({ where }: any) =>
      Array.from(this.targetFindingTriage.values()).filter(
        (t) => t.targetId === where.targetId
      ),
  };

  scanFindingDiff = {
    createMany: async ({ data }: any) => {
      this.scanFindingDiffs.push(...data);
      return { count: data.length };
    },
  };
}

class IntegrationMockRedis {
  events: any[] = [];
  async publish(channel: string, message: string) {
    this.events.push({ channel, event: JSON.parse(message) });
  }
}

describe("Jasmine Worker Pipeline Integration Test", () => {
  let db: IntegrationMockPrisma;
  let redis: IntegrationMockRedis;

  beforeEach(() => {
    db = new IntegrationMockPrisma();
    redis = new IntegrationMockRedis();

    db.scanJobs.set("scan-pipeline-1", {
      id: "scan-pipeline-1",
      targetId: "target-juice-shop",
      organizationId: "org-1",
      profile: "STANDARD",
      status: "QUEUED",
      phase: "DISCOVERY",
      target: { id: "target-juice-shop", origin: "http://localhost:3000" },
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
      prisma: db as any,
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
    const statusEvents = redis.events.filter((e) => e.event.type === "scan.status");
    const progressEvents = redis.events.filter((e) => e.event.type === "scan.progress");
    const findingEvents = redis.events.filter((e) => e.event.type === "scan.finding");

    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(progressEvents.length).toBeGreaterThanOrEqual(2);
    expect(findingEvents.length).toBe(2);
  });
});
