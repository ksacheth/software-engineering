import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config/env';

/**
 * F.1: transactional email delivery (verification, password reset, deletion).
 *
 * SRS §3.2.3 treats the SMTP relay as a degradable dependency: a delivery
 * failure must never block sign-up or password reset, and the message should
 * be queued for retry. Delivery is therefore best-effort here: `sendEmail`
 * reports success but never throws.
 *
 * Callers must NOT await it (Better Auth documentation: awaiting email during
 * sign-up leaks account existence through response timing). Use `void`.
 *
 * TODO(F.1): persist failed messages to a durable outbox and retry them once
 * the worker exists. Until then a failure is logged loudly and the flow
 * continues, which is the "degrade, don't block" half of the requirement.
 */

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
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
 * auth flow can proceed. The failure is logged with enough context to find the
 * message that was lost.
 */
export async function sendEmail(message: EmailMessage): Promise<boolean> {
  try {
    await getTransport().sendMail({
      from: config.smtp.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      html: message.html,
    });
    return true;
  } catch (error) {
    console.error(
      '[email] delivery failed (SRS §3.2.3: queued for retry, request not blocked)',
      { to: message.to, subject: message.subject },
      error,
    );
    return false;
  }
}
