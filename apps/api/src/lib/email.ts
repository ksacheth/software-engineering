import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env';
import {
  dueEmails,
  markRetryFailed,
  markSent,
  recordFailedEmail,
} from './email-outbox';

/**
 * F.1: transactional email delivery (verification, password reset, deletion).
 *
 * SRS §3.2.3 treats the SMTP relay as a degradable dependency: a delivery
 * failure must never block sign-up or password reset, and the message should
 * be queued for retry. Delivery is therefore best-effort here: `sendEmail`
 * reports success but never throws, and a failure is written to `email_outbox`
 * for `retryPendingEmails` to pick up.
 *
 * Callers must NOT await it (Better Auth documentation: awaiting email during
 * sign-up leaks account existence through response timing). Use `void`.
 *
 * The retry loop belongs in apps/worker once that scan engine exists, which is
 * why it is off by default and opt-in via EMAIL_RETRY_INTERVAL_MS. Running it
 * in the API conflicts with NFR-SCAL-1: every extra API instance would drain
 * the same queue and send duplicates.
 */

/** Which flow produced a message. Recorded on the outbox row for triage. */
export type EmailKind = 'verification' | 'password-reset' | 'account-deletion';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: EmailKind;
}

let transport: Transporter | null = null;

function getTransport(): Transporter {
  transport ??= nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.secure,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.password }
      : undefined,
  });
  return transport;
}

/** Escape interpolated values before they reach the HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderHtml(title: string, body: string, action?: { label: string; url: string }): string {
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" ` +
      `style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;` +
      `text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p>`
    : '';

  return [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">',
    `<h1 style="font-size:18px">${escapeHtml(title)}</h1>`,
    body,
    button,
    '<p style="color:#666;font-size:12px">If you did not request this, you can ignore this message.</p>',
    '</body></html>',
  ].join('');
}

/**
 * Deliver a message over SMTP.
 *
 * Returns `false` instead of throwing when the relay is unavailable, so an
 * auth flow can proceed. A failure is recorded in `email_outbox` so it can be
 * retried; see `retryPendingEmails`.
 */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  try {
    await deliver(message);
    return true;
  } catch (error) {
    console.error(
      '[email] delivery failed, message queued for retry (SRS §3.2.3)',
      { to: message.to, subject: message.subject, kind: message.kind },
      error
    );
    await recordFailedEmail(message, error);
    return false;
  }
}

/** Attempt to send, letting the caller decide what a failure means. */
async function deliver(message: EmailMessage): Promise<void> {
  await getTransport().sendMail({
    from: config.smtp.from,
    to: message.to,
    subject: message.subject,
    text: message.text,
    html: message.html,
  });
}

export interface RetrySummary {
  attempted: number;
  sent: number;
  failed: number;
  deadLettered: number;
}

/**
 * Drain messages whose backoff has elapsed.
 *
 * Safe to call concurrently only on a single instance: two drains can select
 * the same row. That is acceptable here because this runs as a manual command
 * or an opt-in single-instance loop, but it is the reason a worker-based
 * implementation should claim rows with `SELECT ... FOR UPDATE SKIP LOCKED`.
 */
export async function retryPendingEmails(
  batchSize = 20
): Promise<RetrySummary> {
  const summary: RetrySummary = {
    attempted: 0,
    sent: 0,
    failed: 0,
    deadLettered: 0,
  };

  const rows = await dueEmails(batchSize);

  for (const row of rows) {
    summary.attempted += 1;
    try {
      await deliver({
        to: row.recipient,
        subject: row.subject,
        text: row.text,
        html: row.html ?? undefined,
        kind: row.kind as EmailMessage['kind'],
      });
      await markSent(row.id);
      summary.sent += 1;
    } catch (error) {
      const parked = await markRetryFailed(row, error);
      if (parked) {
        summary.deadLettered += 1;
      } else {
        summary.failed += 1;
      }
      console.error('[email] retry attempt failed', {
        to: row.recipient,
        attempt: row.attempts + 1,
      });
    }
  }

  return summary;
}

/**
 * Run the retry drain on an interval.
 *
 * Opt-in because it breaks the statelessness NFR-SCAL-1 relies on. The timer is
 * unref'd so it never holds the process open during shutdown.
 */
export function startEmailRetryLoop(intervalMs: number): NodeJS.Timeout {
  const timer = setInterval(() => {
    retryPendingEmails().catch((error) => {
      console.error('[email] retry drain failed', error);
    });
  }, intervalMs);

  timer.unref();
  return timer;
}
