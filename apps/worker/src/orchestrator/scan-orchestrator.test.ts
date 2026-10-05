// @ts-ignore
import { describe, expect, test, beforeEach } from "bun:test";
import { ScanOrchestrator, type Detector } from "./scan-orchestrator.js";
import { MockDetector, type RawFinding } from "../detectors/mock-detector.js";
import { MockPrisma, MockRedisPublisher } from "../test-support/mock-prisma.js";

const SCAN_ID = "scan-123";
const PAYLOAD = { scanJobId: SCAN_ID, organizationId: "org-789", attempt: 1 };

const customFinding: RawFinding = {
  detectorId: "CUSTOM-01",
  name: "Custom Test Finding",
  description: "Test description",
  remediation: "Test remediation",
  severity: "HIGH",
  confidence: "CONFIRMED",
  affectedUrl: "https://test-target.com/custom",
  affectedParameter: "param",
};

describe("ScanOrchestrator", () => {
  let mockPrisma: MockPrisma;
  let mockRedis: MockRedisPublisher;

  beforeEach(() => {
    mockPrisma = new MockPrisma();
    mockRedis = new MockRedisPublisher();

    mockPrisma.scanJobs.set(SCAN_ID, {
      id: SCAN_ID,
      targetId: "target-456",
      organizationId: "org-789",
      profile: "STANDARD",
      status: "QUEUED",
      phase: "DISCOVERY",
      attempt: 1,
      startedAt: null,
    });
  });

  function orchestrator(detector: Detector) {
    return new ScanOrchestrator({ prisma: mockPrisma.asClient(), redis: mockRedis, detector });
  }

  const scan = () => mockPrisma.scanJobs.get(SCAN_ID);
  const statuses = () =>
    mockRedis.events.filter((e) => e.type === "scan.status").map((e) => e.status);

  test("successfully orchestrates a scan job through status transitions", async () => {
    mockPrisma.seedPage(SCAN_ID, "https://test-target.com/search?q=test");

    await orchestrator(MockDetector.analyze).processScanJob(PAYLOAD);

    expect(scan().status).toBe("COMPLETED");
    expect(scan().phase).toBe("COMPLETED");
    expect(scan().progressPercentage).toBe(100.0);
    expect(scan().completedAt).toBeDefined();
    expect(scan().findingsCount).toBe(mockPrisma.findings.size);
    expect(statuses()).toEqual(["RUNNING", "COMPLETED"]);
    expect(mockPrisma.findings.size).toBeGreaterThan(0);
    expect(mockPrisma.scanFindingDiffs.every((d) => d.status === "NEW")).toBe(true);
  });

  test("invokes custom detector and persists normalized findings", async () => {
    await orchestrator(() => [customFinding]).processScanJob(PAYLOAD);

    const findingsArray = Array.from(mockPrisma.findings.values());
    expect(findingsArray.length).toBe(1);
    expect(findingsArray[0].detectorId).toBe("CUSTOM-01");
    expect(findingsArray[0].severity).toBe("HIGH");
  });

  test("keeps zero scores instead of dropping them", async () => {
    await orchestrator(() => [{ ...customFinding, cvssScore: 0, epssScore: 0 }]).processScanJob(PAYLOAD);

    const [finding] = Array.from(mockPrisma.findings.values());
    expect(finding.cvssScore).toBe(0);
    expect(finding.epssScore).toBe(0);
  });

  test("does not invent pages when the crawler found none", async () => {
    await orchestrator(MockDetector.analyze).processScanJob(PAYLOAD);

    expect(scan().status).toBe("COMPLETED");
    expect(scan().pagesCrawled).toBe(0);
    expect(mockPrisma.crawledPages.size).toBe(0);
    expect(mockPrisma.findings.size).toBe(0);
  });

  test("a scan cancelled mid-run stays CANCELLED and keeps no findings", async () => {
    const cancellingDetector = () => {
      mockPrisma.scanJobs.set(SCAN_ID, { ...scan(), status: "CANCELLED" });
      return [customFinding];
    };

    await orchestrator(cancellingDetector).processScanJob(PAYLOAD);

    expect(scan().status).toBe("CANCELLED");
    expect(mockPrisma.findings.size).toBe(0);
    expect(statuses()).toEqual(["RUNNING"]);
  });

  test("a scan paused before detection stops at that checkpoint", async () => {
    let detectorCalled = false;
    mockPrisma.onScanJobUpdate = (_where, data) => {
      if (data.phase === "DETECTION") mockPrisma.scanJobs.set(SCAN_ID, { ...scan(), status: "PAUSED" });
    };

    await orchestrator(() => {
      detectorCalled = true;
      return [];
    }).processScanJob(PAYLOAD);

    expect(scan().status).toBe("PAUSED");
    expect(detectorCalled).toBe(false);
  });

  test("ignores a job from an earlier attempt and a scan that is not runnable", async () => {
    let detectorCalls = 0;
    const detector = () => {
      detectorCalls++;
      return [];
    };

    mockPrisma.scanJobs.set(SCAN_ID, { ...scan(), status: "RUNNING", attempt: 2 });
    await orchestrator(detector).processScanJob(PAYLOAD);

    mockPrisma.scanJobs.set(SCAN_ID, { ...scan(), status: "PAUSED", attempt: 1 });
    await orchestrator(detector).processScanJob(PAYLOAD);

    expect(detectorCalls).toBe(0);
    expect(scan().status).toBe("PAUSED");
    expect(mockRedis.events).toEqual([]);
  });

  test("a resumed scan is processed for its current attempt", async () => {
    mockPrisma.scanJobs.set(SCAN_ID, { ...scan(), status: "RUNNING", attempt: 2 });

    await orchestrator(() => [customFinding]).processScanJob({ ...PAYLOAD, attempt: 2 });

    expect(scan().status).toBe("COMPLETED");
    expect(mockPrisma.findings.size).toBe(1);
  });

  test("a failed persist rolls back the findings and marks the scan FAILED", async () => {
    mockPrisma.failDiffInsert = true;

    await expect(orchestrator(() => [customFinding]).processScanJob(PAYLOAD)).rejects.toThrow(
      "diff insert failed"
    );

    expect(scan().status).toBe("FAILED");
    expect(mockPrisma.findings.size).toBe(0);
  });

  test("handles failure gracefully and updates job status to FAILED", async () => {
    const failingDetector = () => {
      throw new Error("Detector network crash");
    };

    await expect(orchestrator(failingDetector).processScanJob(PAYLOAD)).rejects.toThrow(
      "Detector network crash"
    );

    expect(scan().status).toBe("FAILED");
    expect(scan().failureReason).toBe("Detector network crash");
    expect(statuses()).toEqual(["RUNNING", "FAILED"]);
  });

  test("a failure after a cancel leaves the scan CANCELLED", async () => {
    const detector = () => {
      mockPrisma.scanJobs.set(SCAN_ID, { ...scan(), status: "CANCELLED" });
      throw new Error("Detector network crash");
    };

    await expect(orchestrator(detector).processScanJob(PAYLOAD)).rejects.toThrow();

    expect(scan().status).toBe("CANCELLED");
    expect(statuses()).toEqual(["RUNNING"]);
  });
});
