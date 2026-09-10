import { z } from "zod";
import {
  resolveScanConfiguration,
  SCAN_PROFILES,
  type ScanConfiguration,
  type ScanProfile,
} from "@wvs/shared";
import type { ProblemFieldError } from "../../common/problem";

/**
 * F.3 scan request validation (NFR-SEC-2: every trust-boundary input is
 * validated against an explicit schema).
 *
 * Two layers, deliberately:
 *
 * 1. This schema checks structure and refuses unknown members, so a typo in a
 *    field name is an error rather than a silently ignored override.
 * 2. `resolveScanConfiguration` from `@wvs/shared` applies the profile preset
 *    and the domain bounds. The API applies it authoritatively, so a client
 *    cannot request a configuration the server would not allow.
 *
 * Every problem is reported at once, so a user can fix them in one edit.
 */

const configurationShape = {
  rateLimit: z.number().int().optional(),
  concurrency: z.number().int().optional(),
  maxDepth: z.number().int().optional(),
  maxPages: z.number().int().optional(),
  maxRequests: z.number().int().optional(),
};

export const startScanSchema = z.strictObject({
  targetId: z.string().min(1),
  profile: z.enum(SCAN_PROFILES).optional(),
  configuration: z.strictObject(configurationShape).optional(),
});

export interface StartScanRequest {
  targetId: string;
  profile: ScanProfile;
  configuration: ScanConfiguration;
}

export type StartScanParse =
  | { ok: true; value: StartScanRequest }
  | { ok: false; errors: ProblemFieldError[] };

function pointerFor(path: readonly PropertyKey[]): string {
  return path.length === 0 ? "/" : `/${path.map(String).join("/")}`;
}

export function parseStartScanRequest(body: unknown): StartScanParse {
  const parsed = startScanSchema.safeParse(body ?? {});

  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => ({
        pointer: pointerFor(issue.path),
        detail: issue.message,
      })),
    };
  }

  const profile = parsed.data.profile ?? "STANDARD";
  const overrides = (parsed.data.configuration ?? {}) as Partial<ScanConfiguration>;
  const resolved = resolveScanConfiguration(profile, overrides);

  if (!resolved.configuration) {
    return {
      ok: false,
      errors: resolved.problems.map((problem) => ({
        pointer: pointerFor(["configuration", problem.field]),
        detail: problem.message,
      })),
    };
  }

  return {
    ok: true,
    value: {
      targetId: parsed.data.targetId,
      profile,
      configuration: resolved.configuration,
    },
  };
}
