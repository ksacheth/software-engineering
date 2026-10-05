/**
 * F.1 email confirmation by one-time code (ADR-0013).
 *
 * The API configures Better Auth's email OTP plugin from these, and the
 * dashboard sizes its code field and wording from them, so the two cannot
 * disagree about what a valid code looks like.
 */
export const EMAIL_VERIFICATION_CODE = {
  /** Digits in a code. */
  length: 6,
  /** How long a code stays valid after it is sent. */
  expiresInMinutes: 10,
  /** Wrong guesses before a code is discarded and a new one must be sent. */
  allowedAttempts: 3,
} as const;
