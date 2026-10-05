import { z } from "zod";
import {
  FINDING_SEVERITIES,
  REPORT_FORMATS,
  REPORT_SHARE_BOUNDS,
  REPORT_TEMPLATES,
  TRIAGE_STATES,
} from "@wvs/shared";

/** F.7 request validation (NFR-SEC-2). Unknown members are refused. */

export const createReportSchema = z.strictObject({
  scanId: z.string().trim().min(1, "scanId is required."),
  template: z.enum(REPORT_TEMPLATES),
  format: z.enum(REPORT_FORMATS),
  minSeverity: z.enum(FINDING_SEVERITIES).optional(),
  triageStates: z
    .array(z.enum(TRIAGE_STATES))
    .max(TRIAGE_STATES.length)
    .optional()
    .transform((states) => [...new Set(states ?? [])]),
});

export type CreateReportRequest = z.infer<typeof createReportSchema>;

export const shareReportSchema = z.strictObject({
  expiresInDays: z
    .number()
    .int()
    .min(REPORT_SHARE_BOUNDS.minDays)
    .max(REPORT_SHARE_BOUNDS.maxDays)
    .default(REPORT_SHARE_BOUNDS.defaultDays),
});

export type ShareReportRequest = z.infer<typeof shareReportSchema>;
