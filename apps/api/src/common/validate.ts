import type { Response } from "express";
import type { z } from "zod";
import { sendProblem } from "./problem";

/**
 * Parse a request input against a schema, or answer 400 with every problem at
 * once (NFR-SEC-2, RFC 9457).
 *
 * Returns the parsed value, or null after the response has been sent, so a
 * handler reads `const body = parseOr400(...); if (!body) return;`.
 */
export function parseOr400<S extends z.ZodType>(
  schema: S,
  input: unknown,
  res: Response,
  detail?: string,
): z.infer<S> | null {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;

  sendProblem(res, {
    title: "Validation failed",
    status: 400,
    detail,
    errors: parsed.error.issues.map((issue) => ({
      pointer: `/${issue.path.map(String).join("/")}`,
      detail: issue.message,
    })),
  });
  return null;
}
