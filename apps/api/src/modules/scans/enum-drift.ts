import type {
  FindingSeverity as PrismaFindingSeverity,
  ScanPhase as PrismaScanPhase,
  ScanProfile as PrismaScanProfile,
  ScanStatus as PrismaScanStatus,
} from "@wvs/database";
import type {
  FindingSeverity,
  ScanPhase,
  ScanProfile,
  ScanStatus,
} from "@wvs/shared";

/**
 * Compile-time guard against enum drift.
 *
 * `@wvs/shared` duplicates the Prisma enums rather than importing them, so the
 * package stays free of a database dependency (the same spirit as ADR-0005).
 * The cost is that a Prisma enum member added without updating the shared
 * package would compile happily and then crash at runtime, so the duplication
 * is asserted here. This file has no runtime behaviour: if it stops type
 * checking, the build fails.
 *
 * Mutual assignability, not one-way: a member missing on either side is a
 * mismatch.
 */
type Assert<T extends true> = T;
type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : false
  : false;

export type ScanProfileMatchesPrisma = Assert<
  MutuallyAssignable<PrismaScanProfile, ScanProfile>
>;
export type ScanStatusMatchesPrisma = Assert<
  MutuallyAssignable<PrismaScanStatus, ScanStatus>
>;
export type ScanPhaseMatchesPrisma = Assert<
  MutuallyAssignable<PrismaScanPhase, ScanPhase>
>;
export type FindingSeverityMatchesPrisma = Assert<
  MutuallyAssignable<PrismaFindingSeverity, FindingSeverity>
>;
