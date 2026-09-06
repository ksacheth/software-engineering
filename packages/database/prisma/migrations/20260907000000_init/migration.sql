-- =============================================================================
-- Website Vulnerability Scanner (WVS) - Initial Migration (20260907000000_init)
-- Conforms to SRS v1.2, DC-9 (immutability), NFR-PERF-1, and NFR-MAINT-1
-- =============================================================================

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ADMIN', 'ANALYST', 'DEVELOPER', 'VIEWER');

-- CreateEnum
CREATE TYPE "VerificationMethod" AS ENUM ('DNS_TXT', 'WELL_KNOWN');

-- CreateEnum
CREATE TYPE "TargetVerificationStatus" AS ENUM ('UNVERIFIED', 'PENDING', 'VERIFIED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "NetworkBlocklistType" AS ENUM ('CIDR', 'HOST_SUFFIX', 'IP_RANGE', 'REGEX');

-- CreateEnum
CREATE TYPE "ScanProfile" AS ENUM ('PASSIVE', 'STANDARD', 'THOROUGH');

-- CreateEnum
CREATE TYPE "ScanStatus" AS ENUM ('QUEUED', 'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED', 'ABORTED_SAFETY');

-- CreateEnum
CREATE TYPE "ScanPhase" AS ENUM ('DISCOVERY', 'DETECTION', 'REPORTING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CrawlLimitType" AS ENUM ('DEPTH_REACHED', 'PAGE_CEILING_REACHED', 'REQUEST_CEILING_REACHED', 'QUEUE_EXHAUSTED', 'CANCELLED', 'TIMEOUT', 'SAFETY_ABORT');

-- CreateEnum
CREATE TYPE "FindingSeverity" AS ENUM ('INFO', 'LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FindingConfidence" AS ENUM ('CONFIRMED', 'FIRM', 'TENTATIVE');

-- CreateEnum
CREATE TYPE "ComparisonStatus" AS ENUM ('NEW', 'PERSISTING', 'RESOLVED');

-- CreateEnum
CREATE TYPE "TriageState" AS ENUM ('OPEN', 'CONFIRMED', 'FALSE_POSITIVE', 'ACCEPTED_RISK', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DetectorErrorType" AS ENUM ('TIMEOUT', 'UNEXPECTED_RESPONSE', 'PARSE_FAILURE', 'TEMPLATE_ERROR', 'INTERNAL');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('AUTH_REGISTER', 'AUTH_LOGIN', 'AUTH_LOGOUT', 'AUTH_FAILED', 'AUTH_LOCKOUT', 'AUTH_MFA_ENABLED', 'TARGET_CREATED', 'TARGET_VERIFIED', 'TARGET_ARCHIVED', 'TARGET_DELETED', 'SCAN_QUEUED', 'SCAN_STARTED', 'SCAN_PAUSED', 'SCAN_RESUMED', 'SCAN_CANCELLED', 'SCAN_ABORTED_SAFETY', 'FINDING_TRIAGED', 'EVIDENCE_PURGED', 'REPORT_EXPORTED', 'ADMIN_KILL_SWITCH_ENGAGED', 'ADMIN_KILL_SWITCH_DISENGAGED', 'ADMIN_BLOCKLIST_CREATED', 'ADMIN_BLOCKLIST_UPDATED', 'ADMIN_BLOCKLIST_DELETED', 'ADMIN_QUOTA_CHANGED');

-- CreateEnum
CREATE TYPE "ScopeDecision" AS ENUM ('ALLOWED', 'BLOCKED_VERIFICATION', 'BLOCKED_SCOPE', 'BLOCKED_BLOCKLIST', 'BLOCKED_RATE_LIMIT', 'BLOCKED_CEILING', 'BLOCKED_DNS_REBINDING', 'BLOCKED_KILL_SWITCH', 'ERROR');

-- CreateEnum
CREATE TYPE "ReportTemplate" AS ENUM ('EXECUTIVE_SUMMARY', 'TECHNICAL_REPORT');

-- CreateEnum
CREATE TYPE "ReportFormat" AS ENUM ('PDF', 'HTML', 'JSON', 'CSV', 'SARIF');

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    "image" TEXT,
    "role" "Role" NOT NULL DEFAULT 'ANALYST',
    "failedLoginCount" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMPTZ(3),
    "twoFactorEnabled" BOOLEAN DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "token" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "userId" TEXT NOT NULL,
    "activeOrganizationId" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "accessToken" TEXT,
    "refreshToken" TEXT,
    "idToken" TEXT,
    "accessTokenExpiresAt" TIMESTAMPTZ(3),
    "refreshTokenExpiresAt" TIMESTAMPTZ(3),
    "scope" TEXT,
    "password" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "verification" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3),

    CONSTRAINT "verification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor" (
    "id" TEXT NOT NULL,
    "secret" TEXT NOT NULL,
    "backupCodes" TEXT NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "two_factor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT,
    "logo" TEXT,
    "metadata" TEXT,
    "maxConcurrentScans" INTEGER NOT NULL DEFAULT 2,
    "scanRateLimit" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "member" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "member_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invitation" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" TEXT DEFAULT 'member',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "inviterId" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "origin" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "verified" BOOLEAN NOT NULL DEFAULT false,
    "verificationToken" TEXT NOT NULL,
    "verificationMethod" "VerificationMethod" NOT NULL DEFAULT 'DNS_TXT',
    "verificationStatus" "TargetVerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "verifiedAt" TIMESTAMPTZ(3),
    "verificationExpiresAt" TIMESTAMPTZ(3),
    "authorisationAck" BOOLEAN NOT NULL DEFAULT false,
    "authorisationAckAt" TIMESTAMPTZ(3),
    "authorisationAckById" TEXT,
    "verifiedIpRanges" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "includedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "excludedPaths" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "maxDepth" INTEGER NOT NULL DEFAULT 5,
    "maxPages" INTEGER NOT NULL DEFAULT 200,
    "maxRequests" INTEGER NOT NULL DEFAULT 2000,
    "rateLimit" INTEGER NOT NULL DEFAULT 10,
    "isArchived" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMPTZ(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "target_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "network_blocklist" (
    "id" TEXT NOT NULL,
    "pattern" TEXT NOT NULL,
    "patternType" "NetworkBlocklistType" NOT NULL DEFAULT 'HOST_SUFFIX',
    "reason" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "network_blocklist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_schedule" (
    "id" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "cronSchedule" TEXT NOT NULL,
    "profile" "ScanProfile" NOT NULL DEFAULT 'STANDARD',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "nextRunAt" TIMESTAMPTZ(3),
    "lastRunAt" TIMESTAMPTZ(3),
    "rateLimit" INTEGER NOT NULL DEFAULT 10,
    "concurrency" INTEGER NOT NULL DEFAULT 5,
    "maxDepth" INTEGER NOT NULL DEFAULT 5,
    "maxPages" INTEGER NOT NULL DEFAULT 200,
    "maxRequests" INTEGER NOT NULL DEFAULT 2000,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scan_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_job" (
    "id" TEXT NOT NULL,
    "scheduleId" TEXT,
    "targetId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "profile" "ScanProfile" NOT NULL DEFAULT 'STANDARD',
    "status" "ScanStatus" NOT NULL DEFAULT 'QUEUED',
    "phase" "ScanPhase" NOT NULL DEFAULT 'DISCOVERY',
    "workerId" TEXT,
    "rateLimit" INTEGER NOT NULL DEFAULT 10,
    "concurrency" INTEGER NOT NULL DEFAULT 5,
    "maxDepth" INTEGER NOT NULL DEFAULT 5,
    "maxPages" INTEGER NOT NULL DEFAULT 200,
    "maxRequests" INTEGER NOT NULL DEFAULT 2000,
    "detectorVersions" JSONB,
    "pagesCrawled" INTEGER NOT NULL DEFAULT 0,
    "requestsMade" INTEGER NOT NULL DEFAULT 0,
    "findingsCount" INTEGER NOT NULL DEFAULT 0,
    "progressPercentage" DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    "isDegraded" BOOLEAN NOT NULL DEFAULT false,
    "degradations" JSONB NOT NULL DEFAULT '[]',
    "blockingDetected" BOOLEAN NOT NULL DEFAULT false,
    "blockingDetectedAt" TIMESTAMPTZ(3),
    "queuedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMPTZ(3),
    "completedAt" TIMESTAMPTZ(3),
    "pausedAt" TIMESTAMPTZ(3),
    "cancelledAt" TIMESTAMPTZ(3),
    "failureReason" TEXT,
    "bindingLimit" "CrawlLimitType",
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scan_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_checkpoint" (
    "id" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "phase" "ScanPhase" NOT NULL,
    "crawlFrontier" JSONB NOT NULL,
    "crawledUrls" JSONB NOT NULL,
    "completedDetectors" JSONB NOT NULL,
    "pendingDetectors" JSONB NOT NULL,
    "checkpointedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,

    CONSTRAINT "scan_checkpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "crawled_page" (
    "id" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "normalizedUrl" TEXT NOT NULL,
    "method" TEXT NOT NULL DEFAULT 'GET',
    "statusCode" INTEGER NOT NULL,
    "contentType" TEXT,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "responseTimeMs" INTEGER,
    "requestHeaders" JSONB,
    "responseHeaders" JSONB,
    "forms" JSONB,
    "parameters" JSONB,
    "linksFound" JSONB,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "reducedConfidence" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "crawled_page_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding" (
    "id" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "detectorId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "remediation" TEXT NOT NULL,
    "severity" "FindingSeverity" NOT NULL,
    "confidence" "FindingConfidence" NOT NULL,
    "cwe" TEXT,
    "owaspCategory" TEXT,
    "affectedUrl" TEXT NOT NULL,
    "affectedParameter" TEXT,
    "cvssScore" DOUBLE PRECISION,
    "cvssVector" TEXT,
    "cveId" TEXT,
    "epssScore" DOUBLE PRECISION,
    "epssPercentile" DOUBLE PRECISION,
    "advisoryData" JSONB,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "occurrences" JSONB,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scan_finding_diff" (
    "id" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" "ComparisonStatus" NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_finding_diff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "finding_evidence" (
    "id" TEXT NOT NULL,
    "findingId" TEXT NOT NULL,
    "requestHeaders" JSONB,
    "requestBody" TEXT,
    "responseHeaders" JSONB,
    "responseBody" TEXT,
    "curlCommand" TEXT,
    "extractedSnippet" TEXT,
    "isRedacted" BOOLEAN NOT NULL DEFAULT false,
    "redactionVersion" INTEGER NOT NULL DEFAULT 1,
    "isPurged" BOOLEAN NOT NULL DEFAULT false,
    "purgedAt" TIMESTAMPTZ(3),
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "target_finding_triage" (
    "targetId" TEXT NOT NULL,
    "findingFingerprint" TEXT NOT NULL,
    "state" "TriageState" NOT NULL DEFAULT 'OPEN',
    "justification" TEXT,
    "updatedById" TEXT,
    "lastHistoryId" TEXT,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "target_finding_triage_pkey" PRIMARY KEY ("targetId","findingFingerprint")
);

-- CreateTable
CREATE TABLE "finding_triage_history" (
    "id" TEXT NOT NULL,
    "findingFingerprint" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "state" "TriageState" NOT NULL DEFAULT 'OPEN',
    "justification" TEXT,
    "userId" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "finding_triage_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "detector_execution_error" (
    "id" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "detectorId" TEXT NOT NULL,
    "url" TEXT,
    "parameter" TEXT,
    "errorType" "DetectorErrorType" NOT NULL,
    "message" TEXT NOT NULL,
    "occurrenceCount" INTEGER NOT NULL DEFAULT 1,
    "occurredAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "detector_execution_error_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" "AuditAction" NOT NULL,
    "organizationId" TEXT,
    "userId" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "resourceType" TEXT,
    "resourceId" TEXT,
    "metadata" JSONB,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "url_ledger" (
    "id" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "url" TEXT NOT NULL,
    "resolvedIp" TEXT NOT NULL,
    "httpMethod" TEXT NOT NULL DEFAULT 'GET',
    "statusCode" INTEGER,
    "decision" "ScopeDecision" NOT NULL,
    "decisionReason" TEXT,
    "responseTimeMs" INTEGER,
    "bytesSent" INTEGER,
    "bytesReceived" INTEGER,

    CONSTRAINT "url_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "system_setting" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "description" TEXT,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "system_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "scan_report" (
    "id" TEXT NOT NULL,
    "scanJobId" TEXT NOT NULL,
    "template" "ReportTemplate" NOT NULL,
    "format" "ReportFormat" NOT NULL,
    "filePath" TEXT,
    "fileSize" INTEGER,
    "shareToken" TEXT,
    "shareExpiresAt" TIMESTAMPTZ(3),
    "minSeverityFilter" "FindingSeverity",
    "triageStatusFilter" "TriageState",
    "coverageLimitations" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scan_report_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "session_token_key" ON "session"("token");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "account_userId_idx" ON "account"("userId");

-- CreateIndex
CREATE INDEX "two_factor_userId_idx" ON "two_factor"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "organization_slug_key" ON "organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "member_userId_key" ON "member"("userId");

-- CreateIndex
CREATE INDEX "member_organizationId_idx" ON "member"("organizationId");

-- CreateIndex
CREATE INDEX "invitation_organizationId_idx" ON "invitation"("organizationId");

-- CreateIndex
CREATE INDEX "invitation_inviterId_idx" ON "invitation"("inviterId");

-- CreateIndex
CREATE INDEX "invitation_email_idx" ON "invitation"("email");

-- CreateIndex
CREATE UNIQUE INDEX "target_verificationToken_key" ON "target"("verificationToken");

-- CreateIndex
CREATE INDEX "target_origin_idx" ON "target"("origin");

-- CreateIndex
CREATE INDEX "target_createdById_idx" ON "target"("createdById");

-- CreateIndex
CREATE INDEX "target_authorisationAckById_idx" ON "target"("authorisationAckById");

-- CreateIndex
CREATE UNIQUE INDEX "target_organizationId_origin_key" ON "target"("organizationId", "origin");

-- CreateIndex
CREATE INDEX "network_blocklist_pattern_idx" ON "network_blocklist"("pattern");

-- CreateIndex
CREATE INDEX "network_blocklist_createdById_idx" ON "network_blocklist"("createdById");

-- CreateIndex
CREATE INDEX "scan_schedule_targetId_idx" ON "scan_schedule"("targetId");

-- CreateIndex
CREATE INDEX "scan_schedule_organizationId_idx" ON "scan_schedule"("organizationId");

-- CreateIndex
CREATE INDEX "scan_schedule_isActive_nextRunAt_idx" ON "scan_schedule"("isActive", "nextRunAt");

-- CreateIndex
CREATE INDEX "scan_schedule_createdById_idx" ON "scan_schedule"("createdById");

-- CreateIndex
CREATE INDEX "scan_job_targetId_idx" ON "scan_job"("targetId");

-- CreateIndex
CREATE INDEX "scan_job_organizationId_status_idx" ON "scan_job"("organizationId", "status");

-- CreateIndex
CREATE INDEX "scan_job_status_idx" ON "scan_job"("status");

-- CreateIndex
CREATE INDEX "scan_job_scheduleId_idx" ON "scan_job"("scheduleId");

-- CreateIndex
CREATE INDEX "scan_job_createdById_idx" ON "scan_job"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "scan_checkpoint_scanJobId_key" ON "scan_checkpoint"("scanJobId");

-- CreateIndex
CREATE UNIQUE INDEX "crawled_page_scanJobId_normalizedUrl_method_key" ON "crawled_page"("scanJobId", "normalizedUrl", "method");

-- CreateIndex
CREATE INDEX "finding_targetId_fingerprint_createdAt_idx" ON "finding"("targetId", "fingerprint", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "finding_fingerprint_idx" ON "finding"("fingerprint");

-- CreateIndex
CREATE INDEX "finding_severity_idx" ON "finding"("severity");

-- CreateIndex
CREATE UNIQUE INDEX "finding_scanJobId_fingerprint_key" ON "finding"("scanJobId", "fingerprint");

-- CreateIndex
CREATE INDEX "scan_finding_diff_targetId_status_idx" ON "scan_finding_diff"("targetId", "status");

-- CreateIndex
CREATE INDEX "scan_finding_diff_targetId_fingerprint_idx" ON "scan_finding_diff"("targetId", "fingerprint");

-- CreateIndex
CREATE INDEX "scan_finding_diff_scanJobId_status_idx" ON "scan_finding_diff"("scanJobId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "scan_finding_diff_scanJobId_fingerprint_key" ON "scan_finding_diff"("scanJobId", "fingerprint");

-- CreateIndex
CREATE UNIQUE INDEX "finding_evidence_findingId_key" ON "finding_evidence"("findingId");

-- CreateIndex
CREATE INDEX "finding_evidence_expiresAt_isPurged_idx" ON "finding_evidence"("expiresAt", "isPurged");

-- CreateIndex
CREATE INDEX "target_finding_triage_targetId_state_idx" ON "target_finding_triage"("targetId", "state");

-- CreateIndex
CREATE INDEX "target_finding_triage_updatedById_idx" ON "target_finding_triage"("updatedById");

-- CreateIndex
CREATE INDEX "finding_triage_history_targetId_findingFingerprint_createdA_idx" ON "finding_triage_history"("targetId", "findingFingerprint", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "finding_triage_history_findingFingerprint_idx" ON "finding_triage_history"("findingFingerprint");

-- CreateIndex
CREATE INDEX "finding_triage_history_userId_idx" ON "finding_triage_history"("userId");

-- CreateIndex
CREATE INDEX "detector_execution_error_detectorId_errorType_idx" ON "detector_execution_error"("detectorId", "errorType");

-- CreateIndex
CREATE UNIQUE INDEX "detector_execution_error_scanJobId_detectorId_errorType_key" ON "detector_execution_error"("scanJobId", "detectorId", "errorType");

-- CreateIndex
CREATE INDEX "audit_log_organizationId_timestamp_idx" ON "audit_log"("organizationId", "timestamp");

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action");

-- CreateIndex
CREATE INDEX "audit_log_timestamp_idx" ON "audit_log"("timestamp");

-- CreateIndex
CREATE INDEX "url_ledger_scanJobId_timestamp_idx" ON "url_ledger"("scanJobId", "timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "scan_report_shareToken_key" ON "scan_report"("shareToken");

-- CreateIndex
CREATE INDEX "scan_report_scanJobId_idx" ON "scan_report"("scanJobId");

-- CreateIndex
CREATE INDEX "scan_report_createdById_idx" ON "scan_report"("createdById");

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor" ADD CONSTRAINT "two_factor_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "member" ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target" ADD CONSTRAINT "target_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target" ADD CONSTRAINT "target_authorisationAckById_fkey" FOREIGN KEY ("authorisationAckById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target" ADD CONSTRAINT "target_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "network_blocklist" ADD CONSTRAINT "network_blocklist_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_schedule" ADD CONSTRAINT "scan_schedule_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_schedule" ADD CONSTRAINT "scan_schedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_schedule" ADD CONSTRAINT "scan_schedule_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_job" ADD CONSTRAINT "scan_job_scheduleId_fkey" FOREIGN KEY ("scheduleId") REFERENCES "scan_schedule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_job" ADD CONSTRAINT "scan_job_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_job" ADD CONSTRAINT "scan_job_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_job" ADD CONSTRAINT "scan_job_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_checkpoint" ADD CONSTRAINT "scan_checkpoint_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "crawled_page" ADD CONSTRAINT "crawled_page_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding" ADD CONSTRAINT "finding_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding_diff" ADD CONSTRAINT "scan_finding_diff_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_finding_diff" ADD CONSTRAINT "scan_finding_diff_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "finding_evidence" ADD CONSTRAINT "finding_evidence_findingId_fkey" FOREIGN KEY ("findingId") REFERENCES "finding"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_finding_triage" ADD CONSTRAINT "target_finding_triage_targetId_fkey" FOREIGN KEY ("targetId") REFERENCES "target"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "target_finding_triage" ADD CONSTRAINT "target_finding_triage_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "detector_execution_error" ADD CONSTRAINT "detector_execution_error_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_report" ADD CONSTRAINT "scan_report_scanJobId_fkey" FOREIGN KEY ("scanJobId") REFERENCES "scan_job"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scan_report" ADD CONSTRAINT "scan_report_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- =============================================================================
-- Custom Database Triggers & Policies (SRS DC-9 & NFR-PERF-1)
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. DC-9: Append-only Enforcement for Audit Log, URL Ledger & Triage History
-- Prevents UPDATE, DELETE, and TRUNCATE at trigger level.
-- Hardened with explicit pg_catalog search_path to prevent function shadowing.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION prevent_update_or_delete()
RETURNS TRIGGER
SET search_path = pg_catalog, public
AS $$
BEGIN
    RAISE EXCEPTION 'Table % is append-only under SRS DC-9; mutations and truncations are prohibited.', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- Triggers on audit_log (Row-level + Statement-level TRUNCATE)
DROP TRIGGER IF EXISTS trg_audit_log_append_only ON "audit_log";
CREATE TRIGGER trg_audit_log_append_only
BEFORE UPDATE OR DELETE ON "audit_log"
FOR EACH ROW
EXECUTE FUNCTION prevent_update_or_delete();

DROP TRIGGER IF EXISTS trg_audit_log_no_truncate ON "audit_log";
CREATE TRIGGER trg_audit_log_no_truncate
BEFORE TRUNCATE ON "audit_log"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_update_or_delete();

-- Triggers on url_ledger (Row-level + Statement-level TRUNCATE)
DROP TRIGGER IF EXISTS trg_url_ledger_append_only ON "url_ledger";
CREATE TRIGGER trg_url_ledger_append_only
BEFORE UPDATE OR DELETE ON "url_ledger"
FOR EACH ROW
EXECUTE FUNCTION prevent_update_or_delete();

DROP TRIGGER IF EXISTS trg_url_ledger_no_truncate ON "url_ledger";
CREATE TRIGGER trg_url_ledger_no_truncate
BEFORE TRUNCATE ON "url_ledger"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_update_or_delete();

-- Triggers on finding_triage_history (Row-level + Statement-level TRUNCATE)
DROP TRIGGER IF EXISTS trg_finding_triage_history_append_only ON "finding_triage_history";
CREATE TRIGGER trg_finding_triage_history_append_only
BEFORE UPDATE OR DELETE ON "finding_triage_history"
FOR EACH ROW
EXECUTE FUNCTION prevent_update_or_delete();

DROP TRIGGER IF EXISTS trg_finding_triage_history_no_truncate ON "finding_triage_history";
CREATE TRIGGER trg_finding_triage_history_no_truncate
BEFORE TRUNCATE ON "finding_triage_history"
FOR EACH STATEMENT
EXECUTE FUNCTION prevent_update_or_delete();


-- -----------------------------------------------------------------------------
-- 2. NFR-PERF-1 & SRS F.6: Automatic Triage State Projection
-- Keeps target_finding_triage in sync with finding_triage_history via AFTER INSERT.
-- SECURITY DEFINER ensures the trigger writes target_finding_triage even though
-- the runtime application role (wvs_app) has SELECT only.
-- Guarded against out-of-order replay via clock_timestamp() at microsecond precision.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION sync_target_finding_triage()
RETURNS TRIGGER
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
    INSERT INTO "target_finding_triage" (
        "targetId",
        "findingFingerprint",
        "state",
        "justification",
        "updatedById",
        "lastHistoryId",
        "updatedAt"
    )
    VALUES (
        NEW."targetId",
        NEW."findingFingerprint",
        NEW."state",
        NEW."justification",
        NEW."userId",
        NEW."id",
        clock_timestamp()
    )
    ON CONFLICT ("targetId", "findingFingerprint")
    DO UPDATE SET
        "state" = EXCLUDED."state",
        "justification" = EXCLUDED."justification",
        "updatedById" = EXCLUDED."updatedById",
        "lastHistoryId" = EXCLUDED."lastHistoryId",
        "updatedAt" = EXCLUDED."updatedAt"
    WHERE "target_finding_triage"."updatedAt" < EXCLUDED."updatedAt"
       OR ("target_finding_triage"."updatedAt" = EXCLUDED."updatedAt" AND "target_finding_triage"."lastHistoryId" <= EXCLUDED."lastHistoryId");

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_target_finding_triage ON "finding_triage_history";
CREATE TRIGGER trg_sync_target_finding_triage
AFTER INSERT ON "finding_triage_history"
FOR EACH ROW
EXECUTE FUNCTION sync_target_finding_triage();


-- -----------------------------------------------------------------------------
-- 3. SRS DC-9: Privilege Revocation & Dedicated Projection Role
-- -----------------------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wvs_projection') THEN
        CREATE ROLE wvs_projection NOLOGIN;
    END IF;
END $$;

GRANT USAGE ON SCHEMA public TO wvs_projection;
GRANT SELECT, INSERT, UPDATE ON "target_finding_triage" TO wvs_projection;
ALTER FUNCTION sync_target_finding_triage() OWNER TO wvs_projection;
REVOKE EXECUTE ON FUNCTION sync_target_finding_triage() FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'wvs_app') THEN
        -- Strictly append-only on audit stores
        EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE ON "audit_log", "url_ledger", "finding_triage_history" FROM wvs_app';
        -- Read-only on triage projection (writes only occur via SECURITY DEFINER trigger)
        EXECUTE 'REVOKE INSERT, UPDATE, DELETE ON "target_finding_triage" FROM wvs_app';
        -- Allow wvs_app to execute the projection trigger
        EXECUTE 'GRANT EXECUTE ON FUNCTION sync_target_finding_triage() TO wvs_app';
    END IF;
END $$;
