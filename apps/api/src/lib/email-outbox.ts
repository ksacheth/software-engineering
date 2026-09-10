import { prisma, type EmailOutbox } from "@wvs/database";
import type { EmailMessage } from "./email";

/**
 * F.1: durable record of transactional email that failed to send.
 *
 * SRS F.1 §3.2.3 lists the SMTP relay as a degradable dependency and requires
 * that failure "shall degrade only the feature that depends on it, and the
 * degradation shall be recorded rather than silently absorbed". Two outcomes
 * follow: the auth flow must not block on email, and a lost message must leave
 * a durable trace so it can be retried.
 *
 * This module owns persistence only. Delivery lives in `email.ts`, which keeps
 * the dependency one-way (email -> email-outbox) and avoids an import cycle.
 *
 * Rules every function here obeys:
 *   - Never throw. A queue write must not break the auth flow it serves, and
 *     callers invoke it from a `void`-ed promise where a rejection would
 *     surface as an unhandled rejection.
 *   - Never store credentials. The message body is stored because a retry needs
 *     it, and it contains a verification or reset URL. That URL is a live
 *     credential, so rows are purged on the retention schedule in
 *     `packages/database/docs/retention-and-maintenance.md`.
 */

/** Retry attempts before a row is parked as DEAD_LETTER for an operator. */
export const MAX_ATTEMPTS = 5;

/** First retry delay. Each subsequent delay doubles. */
const BACKOFF_BASE_MS = 60_000;

/**
 * Delay before the next attempt, as `base * 2^(attempts - 1)`:
 * 1 min, 2 min, 4 min, 8 min. Capped attempts keep the total under 15 minutes,
 * which is well inside the one-hour verification link lifetime.
 */
export function backoffMs(attempts: number): number {
  return BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1);
}

/** Postgres text columns reject NUL; other control characters are noise. */
function sanitise(input: string, max = 2000): string {
  // eslint-disable-next-line no-control-regex
  const withoutNul = input.replace(/\u0000/g, "");
  return withoutNul.length > max
    ? `${withoutNul.slice(0, max)}...`
    : withoutNul;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string"
      ? `${code}: ${error.message}`
      : error.message;
  }
  return sanitise(String(error));
}

/**
 * Record a failed delivery. The caller has already consumed the failure, so
 * this reports nothing back: the row is the durable record and the return value
 * would only be ignored.
 */
export async function recordFailedEmail(
  message: EmailMessage,
  error: unknown,
): Promise<void> {
  const now = new Date();
  try {
    await prisma.emailOutbox.create({
      data: {
        recipient: message.to,
        subject: sanitise(message.subject, 300),
        // Bodies are unbounded in theory but realistic templates are small;
        // the cap protects the row from a runaway interpolation.
        text: sanitise(message.text, 20_000),
        html: message.html ? sanitise(message.html, 40_000) : null,
        kind: message.kind,
        attempts: 1,
        lastError: sanitise(describe(error)),
        lastAttemptAt: now,
        nextAttemptAt: new Date(now.getTime() + backoffMs(1)),
      },
    });
  } catch (dbError) {
    // Losing the queue row must not lose the failure too. This is the last line
    // of defence, so it shouts.
    console.error(
      "[email-outbox] failed to record undelivered message (SRS F.1 §3.2.3)",
      { to: message.to, subject: message.subject },
      dbError,
    );
  }
}

/** Messages whose backoff has elapsed, oldest first. */
export function dueEmails(limit: number): Promise<EmailOutbox[]> {
  return prisma.emailOutbox.findMany({
    where: { status: "FAILED", nextAttemptAt: { lte: new Date() } },
    orderBy: { nextAttemptAt: "asc" },
    take: limit,
  });
}

export async function markSent(id: string): Promise<void> {
  await prisma.emailOutbox.update({
    where: { id },
    data: { status: "SENT", sentAt: new Date(), lastError: null },
  });
}

/**
 * Record another failed attempt, scheduling the next one or parking the row
 * once the attempt budget is spent. Returns true when the row was parked, so
 * the caller does not have to re-derive the exhaustion rule.
 */
export async function markRetryFailed(
  row: EmailOutbox,
  error: unknown,
): Promise<boolean> {
  const attempts = row.attempts + 1;
  const exhausted = attempts >= MAX_ATTEMPTS;
  const now = new Date();

  await prisma.emailOutbox.update({
    where: { id: row.id },
    data: {
      status: exhausted ? "DEAD_LETTER" : "FAILED",
      attempts,
      lastError: sanitise(describe(error)),
      lastAttemptAt: now,
      // Irrelevant once parked, but keeping it non-null avoids a nullable
      // column that every reader would have to handle.
      nextAttemptAt: new Date(now.getTime() + backoffMs(attempts)),
    },
  });

  if (exhausted) {
    console.error(
      `[email-outbox] giving up after ${attempts} attempts, message is now DEAD_LETTER`,
      { to: row.recipient, subject: row.subject, kind: row.kind },
    );
  }

  return exhausted;
}

/** Counts by status, for health checks and operator triage. */
export function outboxCounts(): Promise<Record<string, number>> {
  return prisma.emailOutbox
    .groupBy({ by: ["status"], _count: { _all: true } })
    .then((rows) =>
      Object.fromEntries(rows.map((r) => [r.status, r._count._all])),
    );
}
