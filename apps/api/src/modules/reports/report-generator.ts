import { prisma } from "@wvs/database";
import { webOrigin } from "../../config/env";
import { escapeHtml, renderHtml, sendEmail } from "../../lib/email";
import { buildReportDocument } from "./report-document";
import { FORMATS, renderReport } from "./renderers";
import { storeReportFile } from "./report-storage";
import { TEMPLATE_TITLES } from "./renderers/labels";

/**
 * F.7 generation: what the report worker does with one job.
 *
 * The row moves QUEUED -> GENERATING -> READY, or to FAILED once the queue has
 * given up. The author is told either way, by email, which is the
 * "notification when generation completes" F.7 asks for; the dashboard also
 * polls a report it is waiting on. Email is sent from here and not from a
 * pub/sub fan-out, because exactly one worker runs a job and a fan-out would
 * send once per API instance (ADR-0006).
 */

export type GenerationOutcome = "READY" | "SKIPPED";

/**
 * Generate one report. Throws on failure so the queue can retry; the caller
 * marks the row FAILED when it stops retrying (see `markReportFailed`).
 *
 * Returns SKIPPED for a row that no longer needs work: deleted with its scan,
 * already READY from an earlier delivery, or already FAILED.
 */
export async function generateReport(
  reportId: string,
  now: Date = new Date(),
): Promise<GenerationOutcome> {
  // A retry finds the row GENERATING from the delivery that crashed, so that
  // status is claimable too. READY and FAILED are final.
  const claimed = await prisma.scanReport.updateMany({
    where: { id: reportId, status: { in: ["QUEUED", "GENERATING"] } },
    data: { status: "GENERATING" },
  });
  if (claimed.count === 0) return "SKIPPED";

  const report = await prisma.scanReport.findUniqueOrThrow({
    where: { id: reportId },
  });
  const built = await buildReportDocument(report, now);
  const bytes = await renderReport(built.document);
  const filePath = await storeReportFile(
    report.id,
    FORMATS[report.format].extension,
    bytes,
  );

  await prisma.scanReport.update({
    where: { id: report.id },
    data: {
      status: "READY",
      filePath,
      fileSize: bytes.length,
      coverageLimitations: built.document.coverageLimitations.join("\n"),
      includesEvidence: built.includesEvidence,
      expiresAt: built.evidenceExpiresAt,
      completedAt: new Date(),
      failureReason: null,
    },
  });
  await notifyAuthor(report.id);
  return "READY";
}

/**
 * Record that generation has stopped for good. The reason shown is generic:
 * the error itself goes to the worker log, since it can carry paths and
 * database detail no reader of the dashboard needs.
 */
export async function markReportFailed(reportId: string): Promise<void> {
  const updated = await prisma.scanReport.updateMany({
    where: { id: reportId, status: { in: ["QUEUED", "GENERATING"] } },
    data: {
      status: "FAILED",
      failureReason: "The report could not be generated. Try again, and contact an administrator if it keeps failing.",
      completedAt: new Date(),
    },
  });
  if (updated.count > 0) await notifyAuthor(reportId);
}

async function notifyAuthor(reportId: string): Promise<void> {
  const report = await prisma.scanReport.findUnique({
    where: { id: reportId },
    select: {
      status: true,
      template: true,
      format: true,
      scanJobId: true,
      createdBy: { select: { name: true, email: true } },
      scanJob: { select: { target: { select: { label: true } } } },
    },
  });
  if (!report?.createdBy) return;

  const ready = report.status === "READY";
  const title = `${TEMPLATE_TITLES[report.template]} (${report.format})`;
  const target = report.scanJob.target.label;
  const url = `${webOrigin()}/reports?scanId=${encodeURIComponent(report.scanJobId)}`;
  const subject = ready
    ? `Your report for ${target} is ready`
    : `Your report for ${target} could not be generated`;
  const sentence = ready
    ? `Your ${title} for ${target} is ready to download.`
    : `Your ${title} for ${target} could not be generated. You can request it again.`;

  // Best effort, like every other notification: sendEmail never throws, and a
  // failed delivery is queued for retry.
  void sendEmail({
    to: report.createdBy.email,
    subject,
    text: [`Hello ${report.createdBy.name},`, "", sentence, "", url].join("\n"),
    html: renderHtml(
      ready ? "Your report is ready" : "Your report could not be generated",
      `<p>Hello ${escapeHtml(report.createdBy.name)}, ${escapeHtml(sentence)}</p>`,
      { label: "Open reports", url },
    ),
    kind: "report-ready",
  });
}
