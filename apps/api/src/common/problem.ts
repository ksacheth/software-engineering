import type { Response } from "express";

/**
 * RFC 9457 problem details (SRS §3.2.4).
 *
 * New scan endpoints return `application/problem+json`. The existing targets
 * endpoints keep their custom error shape: migrating them and the dashboard
 * error class for no functional gain is a poor trade, and the mixed state is a
 * deliberate, recorded deviation.
 */

export interface ProblemFieldError {
  /** JSON Pointer to the offending member, e.g. "/configuration/rateLimit". */
  pointer?: string;
  detail: string;
}

export interface ProblemDetails {
  /** A URI reference identifying the problem type. Defaults to "about:blank". */
  type?: string;
  title: string;
  status: number;
  detail?: string;
  /** Client-supplied errors, reported together so one edit can fix them all. */
  errors?: ProblemFieldError[];
  /**
   * Extension members, RFC 9457 §3.2: a machine-readable `code`, the offending
   * `scanStatus`, and so on. Unknown members are preserved on the wire.
   */
  [extension: string]: unknown;
}

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export function sendProblem(res: Response, problem: ProblemDetails): void {
  res
    .status(problem.status)
    .type(PROBLEM_CONTENT_TYPE)
    .json({ type: "about:blank", ...problem });
}
