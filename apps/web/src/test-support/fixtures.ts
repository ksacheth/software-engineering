import type { Scan } from "@/services/scans";
import type {
  Target,
  TargetWithScannable,
  VerificationInstructions,
} from "@/services/targets";

/**
 * Wire-shaped fixtures, shared so each test file does not carry its own copy.
 *
 * Both types have far more fields than any one test cares about, and a per-file
 * literal means a field added to the API is added in six places or, worse, in
 * five. Overrides carry what the test is actually about; everything else is a
 * plausible default and should be ignored when reading the test.
 */

const ISO = "2026-09-21T10:00:00.000Z";

export function aTarget(overrides: Partial<Target> = {}): Target {
  return {
    id: "target-1",
    organizationId: "org-1",
    origin: "https://a.test",
    label: "Corporate site",
    verificationMethod: "DNS_TXT",
    verificationStatus: "VERIFIED",
    verifiedAt: ISO,
    verificationExpiresAt: "2026-12-20T10:00:00.000Z",
    authorisationAck: true,
    authorisationAckAt: ISO,
    authorisationAckById: "user-1",
    verifiedIpRanges: ["93.184.216.34/32"],
    includedPaths: [],
    excludedPaths: [],
    maxDepth: 3,
    maxPages: 100,
    maxRequests: 1000,
    rateLimit: 5,
    isArchived: false,
    archivedAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    createdById: "user-1",
    ...overrides,
  };
}

export function aScan(overrides: Partial<Scan> = {}): Scan {
  return {
    id: "scan-1",
    organizationId: "org-1",
    targetId: "target-1",
    target: {
      id: "target-1",
      label: "Corporate site",
      origin: "https://a.test",
    },
    startedBy: { id: "user-1", name: "Sam" },
    scheduleId: null,
    profile: "STANDARD",
    status: "RUNNING",
    phase: "DISCOVERY",
    configuration: {
      rateLimit: 10,
      concurrency: 5,
      maxDepth: 5,
      maxPages: 200,
      maxRequests: 2000,
    },
    includedPaths: [],
    excludedPaths: [],
    detectorVersions: null,
    workerId: null,
    pagesCrawled: 0,
    requestsMade: 0,
    findingsCount: 0,
    progressPercentage: 0,
    isDegraded: false,
    blockingDetected: false,
    bindingLimit: null,
    failureReason: null,
    warnings: [],
    queuedAt: ISO,
    startedAt: ISO,
    completedAt: null,
    pausedAt: null,
    cancelledAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    createdById: "user-1",
    ...overrides,
  };
}

/**
 * A target as the list endpoint returns it, with the verdict attached.
 *
 * The verdict is computed by the API rather than the row, so a fixture that
 * derived it here would be asserting the dashboard's guess instead of the
 * answer C.2 actually turns on.
 */
export function aListedTarget(
  overrides: Partial<TargetWithScannable> = {},
): TargetWithScannable {
  return {
    ...aTarget(),
    scannable: { scannable: true },
    ...overrides,
  };
}

export function dnsInstructions(
  overrides: Partial<Extract<VerificationInstructions, { method: "DNS_TXT" }>> = {},
): VerificationInstructions {
  return {
    method: "DNS_TXT",
    recordName: "_wvs-challenge.a.test",
    recordType: "TXT",
    recordValue: "wvs-verify-0123456789abcdef",
    ...overrides,
  };
}

export function wellKnownInstructions(
  overrides: Partial<Extract<VerificationInstructions, { method: "WELL_KNOWN" }>> = {},
): VerificationInstructions {
  return {
    method: "WELL_KNOWN",
    url: "https://a.test/.well-known/wvs-verify.txt",
    content: "wvs-verify-0123456789abcdef",
    ...overrides,
  };
}
