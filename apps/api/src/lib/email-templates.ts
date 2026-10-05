import { EMAIL_VERIFICATION_CODE } from "@wvs/shared";
import { escapeHtml, renderHtml, type EmailMessage } from "./email-html";

/**
 * F.1: the three transactional emails the auth module sends. Each builder
 * returns an `EmailMessage` minus the recipient, which the caller supplies.
 */

const APP_NAME = "Website Vulnerability Scanner";

type TemplateInput = { name: string; url: string };

/**
 * F.1 email confirmation (ADR-0013): a one-time code typed into the dashboard,
 * not a link. The code is the credential, so it is shown once, plainly, with
 * its lifetime and nothing to click.
 */
export function verificationCodeEmail({
  name,
  code,
}: {
  name: string;
  code: string;
}): Omit<EmailMessage, "to"> {
  const minutes = EMAIL_VERIFICATION_CODE.expiresInMinutes;
  // Not in the subject: subjects show on lock screens and in notification
  // previews, where a code would be readable without opening the mailbox.
  const subject = `Your verification code (${APP_NAME})`;
  const text = [
    `Hello ${name},`,
    "",
    "Enter this code to confirm your email address and activate your account:",
    "",
    `    ${code}`,
    "",
    `The code expires in ${minutes} minutes. If you did not create an account, ignore this email.`,
  ].join("\n");

  const body =
    `<p>Hello ${escapeHtml(name)}, enter this code to confirm your email address ` +
    "and activate your account:</p>" +
    '<p style="font-size:28px;font-weight:600;letter-spacing:6px;margin:24px 0">' +
    `${escapeHtml(code)}</p>` +
    `<p>The code expires in ${minutes} minutes. ` +
    "If you did not create an account, ignore this email.</p>";

  return {
    subject,
    text,
    html: renderHtml("Confirm your email address", body),
    kind: "verification",
  };
}

export function resetPasswordEmail({
  name,
  url,
}: TemplateInput): Omit<EmailMessage, "to"> {
  const subject = `Reset your password (${APP_NAME})`;
  const text = [
    `Hello ${name},`,
    "",
    "Choose a new password using this link:",
    url,
    "",
    "The link expires in 30 minutes. If you did not ask for this, ignore this email.",
  ].join("\n");

  const body =
    `<p>Hello ${escapeHtml(name)}, use the button below to choose a new password. ` +
    "The link expires in 30 minutes.</p>";

  return {
    subject,
    text,
    html: renderHtml("Reset your password", body, {
      label: "Choose a new password",
      url,
    }),
    kind: "password-reset",
  };
}

export function deleteAccountEmail({
  name,
  url,
}: TemplateInput): Omit<EmailMessage, "to"> {
  const subject = `Confirm account deletion (${APP_NAME})`;
  const text = [
    `Hello ${name},`,
    "",
    "Confirm that you want to permanently delete your account and all associated data:",
    url,
    "",
    "If you did not request this, ignore this email and your account will be left unchanged.",
  ].join("\n");

  const body =
    `<p>Hello ${escapeHtml(name)}, confirm that you want to permanently delete your account ` +
    "and all associated data. This cannot be undone.</p>";

  return {
    subject,
    text,
    html: renderHtml("Confirm account deletion", body, {
      label: "Delete my account",
      url,
    }),
    kind: "account-deletion",
  };
}
