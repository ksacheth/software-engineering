/**
 * The shape of a transactional message and the HTML it is rendered into.
 * Pure: no configuration, no transport, so email-templates.ts and its tests
 * do not load the SMTP client or the environment (see email.ts).
 */

/** Which flow produced a message. Recorded on the outbox row for triage. */
export type EmailKind =
  | "verification"
  | "password-reset"
  | "account-deletion"
  | "report-ready";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: EmailKind;
}

/** Escape interpolated values before they reach the HTML body. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderHtml(
  title: string,
  body: string,
  action?: { label: string; url: string },
): string {
  const button = action
    ? `<p style="margin:24px 0"><a href="${escapeHtml(action.url)}" ` +
      `style="background:#111;color:#fff;padding:10px 18px;border-radius:6px;` +
      `text-decoration:none;display:inline-block">${escapeHtml(action.label)}</a></p>`
    : "";

  return [
    '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5">',
    `<h1 style="font-size:18px">${escapeHtml(title)}</h1>`,
    body,
    button,
    '<p style="color:#666;font-size:12px">If you did not request this, you can ignore this message.</p>',
    "</body></html>",
  ].join("");
}
