import type { ProbeResponse } from "./types";

/** A copy of `url` with one query parameter set to `value`. */
export function withParameter(url: string, parameter: string, value: string): string {
  const probed = new URL(url);
  probed.searchParams.set(parameter, value);
  return probed.toString();
}

/** The URL a parameter was first seen on, falling back to the origin root. */
export function targetFor(parameter: string, entryUrls: string[], origin: string): string {
  return entryUrls.find((url) => new URL(url).searchParams.has(parameter)) ?? `${origin}/`;
}

export function isRedirect(response: Extract<ProbeResponse, { ok: true }>): boolean {
  return response.status >= 300 && response.status < 400;
}
