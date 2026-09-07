/**
 * C.2 — the single place "may this target be scanned?" is answered.
 *
 * SRS C.2: "Scanning is permitted only against targets whose ownership is
 * verified per F.2. There shall be no configuration option that disables this."
 *
 * Every caller that is about to originate traffic on a target's behalf — scan
 * launch, schedule tick, worker job pickup — asks this function. There is
 * deliberately no options argument and no bypass flag: the absence of a way to
 * turn it off is the requirement.
 */

export type NotScannableReason =
  | 'ARCHIVED'
  | 'NOT_VERIFIED'
  | 'VERIFICATION_FAILED'
  | 'VERIFICATION_EXPIRED'
  | 'NO_VERIFIED_ADDRESSES'
  | 'AUTHORISATION_NOT_ACKNOWLEDGED';

export interface ScannableVerdict {
  scannable: boolean;
  reason?: NotScannableReason;
}

/**
 * The subset of Target this predicate reads. Declared structurally rather than
 * importing the Prisma type so this package stays free of a database
 * dependency and can be unit-tested with plain objects.
 */
export interface ScannableTarget {
  verificationStatus: string;
  verificationExpiresAt: Date | null;
  verifiedIpRanges: readonly string[];
  authorisationAck: boolean;
  isArchived: boolean;
}

/**
 * Expiry is evaluated here, at read time, from verificationExpiresAt. No job
 * writes the EXPIRED status: a sweeper would leave a window in which a lapsed
 * target still reads as VERIFIED, and that window is exactly when C.2 would be
 * violated. The EXPIRED enum value is for display.
 */
export function isScannable(
  target: ScannableTarget,
  now: Date = new Date(),
): ScannableVerdict {
  if (target.isArchived) {
    return { scannable: false, reason: 'ARCHIVED' };
  }

  if (!target.authorisationAck) {
    return { scannable: false, reason: 'AUTHORISATION_NOT_ACKNOWLEDGED' };
  }

  if (target.verificationStatus === 'FAILED') {
    return { scannable: false, reason: 'VERIFICATION_FAILED' };
  }

  if (target.verificationStatus !== 'VERIFIED') {
    return { scannable: false, reason: 'NOT_VERIFIED' };
  }

  if (!target.verificationExpiresAt || target.verificationExpiresAt.getTime() <= now.getTime()) {
    return { scannable: false, reason: 'VERIFICATION_EXPIRED' };
  }

  // Fails closed: without recorded addresses the Scope Guard's DNS-rebinding
  // check has nothing to compare against, so it would silently pass. See
  // docs/adr/0004.
  if (target.verifiedIpRanges.length === 0) {
    return { scannable: false, reason: 'NO_VERIFIED_ADDRESSES' };
  }

  return { scannable: true };
}

/** Days a verification remains valid before re-verification is required (F.2). */
export const VERIFICATION_VALIDITY_DAYS = 90;

export function verificationExpiryFrom(verifiedAt: Date): Date {
  return new Date(verifiedAt.getTime() + VERIFICATION_VALIDITY_DAYS * 24 * 60 * 60 * 1000);
}
