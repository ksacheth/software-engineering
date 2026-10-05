// @ts-ignore
import { describe, expect, test, beforeEach } from "bun:test";
import { ScanOrchestrator } from "./scan-orchestrator.js";
import type { RawFinding } from "../detectors/mock-detector.js";

// In-memory Prisma mock for orchestrator unit testing
class MockPrisma {
  scanJobs = new Map<string, any>();
  crawledPages = new Map<string, any>();
  findings = new Map<string, any>();

  scanJob = {
    findUnique: async ({ where }: any) => {
      return this.scanJobs.get(where.id) || null;
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
    findMany: async ({ where }: any) => {
      return Array.from(this.crawledPages.values()).filter(
        (p) => p.scanJobId === where.scanJobId
      );
    },
    create: async ({ data }: any) => {
      const id = `page-${Math.random()}`;
      const page = { id, ...data };
      this.crawledPages.set(id, page);
      return page;
    },
  };

  finding = {
    findFirst: async ({ where }: any) => {
      return (
        Array.from(this.findings.values()).find(
          (f) =>
            f.scanJobId === where.scanJobId &&
            f.fingerprint === where.fingerprint
        ) || null
      );
    },
    create: async ({ data }: any) => {
      const id = `finding-${Math.random()}`;
      const finding = { id, ...data };
      this.findings.set(id, finding);
      return finding;
    },
  };
}

class MockRedisPublisher {
  events: any[] = [];
  async publish(channel: string, message: string) {
    this.events.push({ channel, message: JSON.parse(message) });
  }
}

describe("ScanOrchestrator", () => {
  let mockPrisma: MockPrisma;
  let mockRedis: MockRedisPublisher;

  beforeEach(() => {
    mockPrisma = new MockPrisma();
    mockRedis = new MockRedisPublisher();

    // Seed a scan job
    mockPrisma.scanJobs.set("scan-123", {
      id: "scan-123",
      targetId: "target-456",
      organizationId: "org-789",
      profile: "STANDARD",
      status: "QUEUED",
      phase: "DISCOVERY",
      target: { id: "target-456", origin: "https://test-target.com" },
    });
  });

  test("successfully orchestrates a scan job through status transitions", async () => {
    const orchestrator = new ScanOrchestrator({
      prisma: mockPrisma,
      redis: mockRedis,
    });

    await orchestrator.processScanJob({
      scanJobId: "scan-123",
      organizationId: "org-789",
      attempt: 1,
    });

    const updatedJob = mockPrisma.scanJobs.get("scan-123");
    expect(updatedJob.status).toBe("COMPLETED");
    expect(updatedJob.phase).toBe("COMPLETED");
    expect(updatedJob.progressPercentage).toBe(100.0);
    expect(updatedJob.completedAt).toBeDefined();

    // Verify events emitted
    const statusEvents = mockRedis.events.filter(
      (e) => e.message.type === "scan.status"
    );
    expect(statusEvents.length).toBeGreaterThanOrEqual(2);
    expect(statusEvents[0].message.status).toBe("RUNNING");
    expect(statusEvents[statusEvents.length - 1].message.status).toBe(
      "COMPLETED"
    );

    // Verify findings created
    expect(mockPrisma.findings.size).toBeGreaterThan(0);
  });

  test("invokes custom detector and persists normalized findings", async () => {
    const customDetector = (): RawFinding[] => [
      {
        detectorId: "CUSTOM-01",
        name: "Custom Test Finding",
        description: "Test description",
        remediation: "Test remediation",
        severity: "HIGH",
        confidence: "CONFIRMED",
        affectedUrl: "https://test-target.com/custom",
        affectedParameter: "param",
      },
    ];

    const orchestrator = new ScanOrchestrator({
      prisma: mockPrisma,
      redis: mockRedis,
      detector: customDetector,
    });

    await orchestrator.processScanJob({
      scanJobId: "scan-123",
      organizationId: "org-789",
      attempt: 1,
    });

    const findingsArray = Array.from(mockPrisma.findings.values());
    expect(findingsArray.length).toBe(1);
    expect(findingsArray[0].detectorId).toBe("CUSTOM-01");
    expect(findingsArray[0].severity).toBe("HIGH");
  });

  test("handles failure gracefully and updates job status to FAILED", async () => {
    const failingDetector = () => {
      throw new Error("Detector network crash");
    };

    const orchestrator = new ScanOrchestrator({
      prisma: mockPrisma,
      redis: mockRedis,
      detector: failingDetector,
    });

    await expect(
      orchestrator.processScanJob({
        scanJobId: "scan-123",
        organizationId: "org-789",
        attempt: 1,
      })
    ).rejects.toThrow("Detector network crash");

    const failedJob = mockPrisma.scanJobs.get("scan-123");
    expect(failedJob.status).toBe("FAILED");
    expect(failedJob.failureReason).toBe("Detector network crash");

    const failedStatusEvents = mockRedis.events.filter(
      (e) =>
        e.message.type === "scan.status" && e.message.status === "FAILED"
    );
    expect(failedStatusEvents.length).toBe(1);
  });
});
