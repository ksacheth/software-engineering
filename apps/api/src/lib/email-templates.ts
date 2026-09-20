import { escapeHtml, renderHtml, type EmailMessage } from "./email";

/**
 * F.1: the three transactional emails the auth module sends. Each builder
 * returns an `EmailMessage` minus the recipient, which the caller supplies.
 */

const APP_NAME = "Website Vulnerability Scanner";

type TemplateInput = { name: string; url: string };

export function verificationEmail({
  name,
  url,
}: TemplateInput): Omit<EmailMessage, "to"> {
  const subject = `Confirm your email address (${APP_NAME})`;
  const text = [
    `Hello ${name},`,
    "",
    "Confirm this email address to activate your account:",
    url,
    "",
    "The link expires in one hour.",
  ].join("\n");

  const body =
    `<p>Hello ${escapeHtml(name)}, confirm this email address to activate your account. ` +
    "The link expires in one hour.</p>";

  return {
    subject,
    text,
    html: renderHtml("Confirm your email address", body, {
      label: "Confirm email",
      url,
    }),
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
