-- F.7 reporting and export.
--
-- Nothing has written scan_report yet, so its columns are reshaped in place
-- rather than migrated.

-- DC-4: generation runs on a queue worker, so a report row exists before its
-- file does and needs a lifecycle of its own.
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'GENERATING', 'READY', 'FAILED');

ALTER TABLE "scan_report"
  ADD COLUMN "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
  ADD COLUMN "failureReason" TEXT,
  ADD COLUMN "includesEvidence" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "expiresAt" TIMESTAMPTZ(3),
  ADD COLUMN "completedAt" TIMESTAMPTZ(3);

-- The limitations statement is worked out by the generator, not the request.
ALTER TABLE "scan_report" ALTER COLUMN "coverageLimitations" DROP NOT NULL;

-- F.7 filters by triage status, and a reader asking for "open and confirmed"
-- is the common case, so one state was not enough.
ALTER TABLE "scan_report" DROP COLUMN "triageStatusFilter";
ALTER TABLE "scan_report"
  ADD COLUMN "triageStateFilter" "TriageState"[] DEFAULT ARRAY[]::"TriageState"[];

-- A share token is a credential, so only its hash is stored (ADR-0011).
DROP INDEX "scan_report_shareToken_key";
ALTER TABLE "scan_report" DROP COLUMN "shareToken";
ALTER TABLE "scan_report" ADD COLUMN "shareTokenHash" TEXT;
CREATE UNIQUE INDEX "scan_report_shareTokenHash_key" ON "scan_report"("shareTokenHash");

-- F.8 audits export events. Creating and revoking a link that anyone holding
-- it can use is one.
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_SHARED' AFTER 'REPORT_EXPORTED';
ALTER TYPE "AuditAction" ADD VALUE 'REPORT_SHARE_REVOKED' AFTER 'REPORT_SHARED';
