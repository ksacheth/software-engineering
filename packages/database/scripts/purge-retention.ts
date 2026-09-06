import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';

// Must connect as cluster administrator (wvs_owner / postgres)
const url = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;

const prisma = new PrismaClient({
  datasources: {
    db: {
      url,
    },
  },
});

interface RetentionOptions {
  retentionDays?: number;
  dryRun?: boolean;
}

/**
 * Privileged data retention maintenance routine conforming to SRS DC-9, F.6, and C.7.
 * Purges url_ledger and expired finding_evidence beyond the retention window.
 *
 * Requirements:
 * 1. Must run under migration/owner credentials (wvs_owner / postgres).
 * 2. Entire operation is wrapped in a transaction.
 * 3. Disables trg_url_ledger_append_only strictly within the transaction scope.
 * 4. Records an immutable audit_log entry with action 'EVIDENCE_PURGED'.
 * 5. Re-enables trg_url_ledger_append_only prior to committing.
 */
export async function purgeRetention({
  retentionDays = 90,
  dryRun = false,
}: RetentionOptions = {}) {
  const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  console.log(`[Retention Purge] Threshold date: ${cutoffDate.toISOString()} (${retentionDays} days)`);

  if (dryRun) {
    const ledgerCount = await prisma.urlLedger.count({
      where: { timestamp: { lt: cutoffDate } },
    });
    const evidenceCount = await prisma.findingEvidence.count({
      where: {
        OR: [
          { expiresAt: { lt: cutoffDate } },
          { isPurged: true },
        ],
      },
    });
    console.log(`[Dry Run] Candidates for purge:`);
    console.log(`  - url_ledger records: ${ledgerCount}`);
    console.log(`  - finding_evidence records: ${evidenceCount}`);
    return { ledgerCount, evidenceCount };
  }

  const auditLogId = randomUUID();

  return await prisma.$transaction(async (tx) => {
    // 1. Audit the initiation of the purge operation under DC-9
    await tx.$executeRawUnsafe(
      `INSERT INTO "audit_log" ("id", "timestamp", "action", "resourceType", "metadata")
       VALUES ($1, CURRENT_TIMESTAMP, 'EVIDENCE_PURGED'::"AuditAction", 'url_ledger', $2::jsonb)`,
      auditLogId,
      JSON.stringify({
        retentionDays,
        cutoffDate: cutoffDate.toISOString(),
        initiatedBy: 'automated_retention_job',
      })
    );

    // 2. Temporarily disable the row-level append-only trigger within transaction
    await tx.$executeRawUnsafe(`ALTER TABLE "url_ledger" DISABLE TRIGGER trg_url_ledger_append_only;`);

    // 3. Purge url_ledger records older than retention threshold
    const deletedLedgerCount = await tx.$executeRawUnsafe(
      `DELETE FROM "url_ledger" WHERE "timestamp" < $1;`,
      cutoffDate
    );

    // 4. Re-enable append-only trigger immediately
    await tx.$executeRawUnsafe(`ALTER TABLE "url_ledger" ENABLE TRIGGER trg_url_ledger_append_only;`);

    // 5. Purge expired finding evidence (soft-delete / nullify raw payloads per SRS F.6)
    const purgedEvidenceCount = await tx.$executeRawUnsafe(
      `UPDATE "finding_evidence"
       SET "requestBody" = NULL,
           "responseBody" = NULL,
           "curlCommand" = NULL,
           "extractedSnippet" = NULL,
           "isPurged" = true,
           "purgedAt" = CURRENT_TIMESTAMP
       WHERE "expiresAt" < $1 AND "isPurged" = false;`,
      cutoffDate
    );

    console.log(`[Retention Purge Complete]`);
    console.log(`  - Purged url_ledger rows: ${deletedLedgerCount}`);
    console.log(`  - Redacted finding_evidence payloads: ${purgedEvidenceCount}`);
    console.log(`  - Logged audit event: ${auditLogId}`);

    return { deletedLedgerCount, purgedEvidenceCount, auditLogId };
  });
}

if (require.main === module) {
  const retentionDays = parseInt(process.env.RETENTION_DAYS || '90', 10);
  const dryRun = process.argv.includes('--dry-run');

  purgeRetention({ retentionDays, dryRun })
    .catch((e) => {
      console.error('[Retention Purge Failed]:', e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}
