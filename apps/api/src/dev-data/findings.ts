import type {
  ComparisonStatus,
  FindingConfidence,
  FindingSeverity,
  Prisma,
  PrismaClient,
  TriageState,
} from "@wvs/database";

/**
 * F.6 finding builders, standing in for what the orchestrator and detectors
 * will write.
 *
 * Shared by the API tests and the dev seed script, so both exercise the same
 * shapes. Every function takes the client explicitly: the test harness and the
 * seed script point at different databases.
 *
 * Triage is always written by appending history, never by touching the
 * projection, because that is the only path the application role has
 * (ADR-0003) and the trigger is part of what is being exercised.
 */

type Db = Pick<
  PrismaClient,
  | "scanJob"
  | "finding"
  | "findingEvidence"
  | "scanFindingDiff"
  | "findingTriageHistory"
>;

export interface CompletedScanInput {
  organizationId: string;
  targetId: string;
  createdById?: string | null;
  completedAt?: Date;
}

export function createCompletedScan(db: Db, input: CompletedScanInput) {
  const completedAt = input.completedAt ?? new Date();
  const startedAt = new Date(completedAt.getTime() - 12 * 60 * 1000);
  return db.scanJob.create({
    data: {
      organizationId: input.organizationId,
      targetId: input.targetId,
      createdById: input.createdById ?? null,
      status: "COMPLETED",
      phase: "COMPLETED",
      progressPercentage: 100,
      queuedAt: startedAt,
      startedAt,
      completedAt,
      createdAt: startedAt,
    },
  });
}

export interface FindingInput {
  scanJobId: string;
  targetId: string;
  fingerprint: string;
  detectorId?: string;
  name?: string;
  description?: string;
  remediation?: string;
  severity?: FindingSeverity;
  confidence?: FindingConfidence;
  cwe?: string | null;
  owaspCategory?: string | null;
  affectedUrl?: string;
  affectedParameter?: string | null;
  cvssScore?: number | null;
  cvssVector?: string | null;
  cveId?: string | null;
  epssScore?: number | null;
  epssPercentile?: number | null;
  occurrenceCount?: number;
  occurrences?: Prisma.InputJsonValue;
  createdAt?: Date;
}

export function createFinding(db: Db, input: FindingInput) {
  return db.finding.create({
    data: {
      scanJobId: input.scanJobId,
      targetId: input.targetId,
      fingerprint: input.fingerprint,
      detectorId: input.detectorId ?? "P-01",
      name: input.name ?? "Missing Content-Security-Policy",
      description:
        input.description ??
        "The page does not send a Content-Security-Policy header, so the browser has no second line of defence if an attacker manages to inject script.",
      remediation:
        input.remediation ??
        "Send a restrictive Content-Security-Policy header, starting from default-src 'self'.",
      severity: input.severity ?? "MEDIUM",
      confidence: input.confidence ?? "CONFIRMED",
      cwe: input.cwe === undefined ? "CWE-693" : input.cwe,
      owaspCategory:
        input.owaspCategory === undefined ? "A05:2021" : input.owaspCategory,
      affectedUrl: input.affectedUrl ?? "https://app.example.test/",
      affectedParameter: input.affectedParameter ?? null,
      cvssScore: input.cvssScore ?? null,
      cvssVector: input.cvssVector ?? null,
      cveId: input.cveId ?? null,
      epssScore: input.epssScore ?? null,
      epssPercentile: input.epssPercentile ?? null,
      occurrenceCount: input.occurrenceCount ?? 1,
      occurrences: input.occurrences,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

export interface EvidenceInput {
  isRedacted?: boolean;
  isPurged?: boolean;
  expiresAt?: Date;
  requestBody?: string;
  responseBody?: string;
}

const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

export function createEvidence(db: Db, findingId: string, input: EvidenceInput = {}) {
  const purged = input.isPurged ?? false;
  return db.findingEvidence.create({
    data: {
      findingId,
      isRedacted: input.isRedacted ?? true,
      isPurged: purged,
      purgedAt: purged ? new Date() : null,
      expiresAt: input.expiresAt ?? new Date(Date.now() + NINETY_DAYS_MS),
      requestHeaders: purged
        ? undefined
        : { Host: "app.example.test", Cookie: "session=[REDACTED]" },
      requestBody: purged ? null : (input.requestBody ?? null),
      responseHeaders: purged
        ? undefined
        : { "Content-Type": "text/html; charset=utf-8", Server: "nginx" },
      responseBody: purged
        ? null
        : (input.responseBody ?? "<!doctype html><html>…</html>"),
      curlCommand: purged
        ? null
        : "curl -i 'https://app.example.test/' -H 'Cookie: session=[REDACTED]'",
      extractedSnippet: purged ? null : "<html>",
    },
  });
}

export function createDiff(
  db: Db,
  input: {
    scanJobId: string;
    targetId: string;
    fingerprint: string;
    status: ComparisonStatus;
  },
) {
  return db.scanFindingDiff.create({ data: input });
}

export function recordTriage(
  db: Db,
  input: {
    targetId: string;
    fingerprint: string;
    state: TriageState;
    justification?: string | null;
    userId?: string | null;
  },
) {
  return db.findingTriageHistory.create({
    data: {
      targetId: input.targetId,
      findingFingerprint: input.fingerprint,
      state: input.state,
      justification: input.justification ?? null,
      userId: input.userId ?? null,
    },
  });
}
