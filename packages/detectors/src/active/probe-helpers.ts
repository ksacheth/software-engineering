import type { ActiveContext, ActiveSurface, OkProbeResponse, ProbeRequest, ProbeResponse } from "./types";

/** The most parameters one detector probes, so a form-heavy site cannot
 *  multiply the request volume. */
export const MAX_PARAMETERS = 20;

/** A copy of `url` with one query parameter set to `value`. */
export function withParameter(url: string, parameter: string, value: string): string {
  const probed = new URL(url);
  probed.searchParams.set(parameter, value);
  return probed.toString();
}

/** The URL a parameter was first seen on, falling back to the first crawled
 *  page (always in scope), then the origin root. `preferHtml` picks an HTML
 *  page carrying the parameter first, for a detector that needs an HTML reply
 *  (A-01); the others keep the first URL seen, which may be a redirect or a
 *  raw file (A-04, A-11). */
export function targetFor(parameter: string, surface: ActiveSurface, preferHtml = false): string {
  const carries = (url: string) => new URL(url).searchParams.has(parameter);
  const seenOn = (preferHtml ? surface.entryUrls.find(carries) : undefined) ?? surface.parameterUrls.find(carries);
  return seenOn ?? surface.entryUrls[0] ?? `${surface.origin}/`;
}

/** Parameter names to probe: those seen in page URLs first (they are real
 *  query inputs), then form-only names, capped at MAX_PARAMETERS. */
export function selectParameters(surface: ActiveSurface, accept: (name: string) => boolean = () => true): string[] {
  const inUrls = new Set(surface.parameterUrls.flatMap((url) => [...new URL(url).searchParams.keys()]));
  const candidates = surface.parameters.filter(accept);
  const ordered = [...candidates.filter((name) => inUrls.has(name)), ...candidates.filter((name) => !inUrls.has(name))];
  return ordered.slice(0, MAX_PARAMETERS);
}

/** Sends one probe; a throw becomes `{ ok: false }` so one failed request
 *  cannot discard what a detector already learned. */
export async function safeProbe(context: Pick<ActiveContext, "probe">, request: ProbeRequest): Promise<ProbeResponse> {
  try {
    return await context.probe(request);
  } catch {
    return { ok: false };
  }
}

/** Probes the origin root, or the first crawled page when the root is refused
 *  (for example a target scoped to /app). Null when neither answered. */
export async function probeRoot(
  context: ActiveContext,
  request: Omit<ProbeRequest, "url">,
): Promise<{ url: string; response: OkProbeResponse } | null> {
  const { origin, entryUrls } = context.surface;
  const fallback = entryUrls[0];
  const candidates = [`${origin}/`, ...(fallback && fallback !== `${origin}/` ? [fallback] : [])];
  for (const url of candidates) {
    const response = await safeProbe(context, { ...request, url });
    if (response.ok) return { url, response };
  }
  return null;
}

export function isRedirect(response: OkProbeResponse): boolean {
  return response.status >= 300 && response.status < 400;
}

export function isSuccess(response: OkProbeResponse): boolean {
  return response.status >= 200 && response.status < 300;
}

/** True for a document a browser renders as HTML. */
export function isHtml(response: OkProbeResponse): boolean {
  return /\b(?:text\/html|application\/xhtml\+xml)\b/i.test(response.headers.get("content-type") ?? "");
}

/** Strips digits and whitespace so volatile content (tokens, timestamps) does
 *  not make two otherwise identical pages look different. */
export function normalise(body: string): string {
  return body.replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
}

const BASELINE_PREFIX = 200;
const BASELINE_LENGTH_RATIO = 0.95;

/** True when `response` is the same page as the baseline: same status and an
 *  identical or near-identical body. A site with a catch-all route answers
 *  every unknown path this way, so such a reply proves nothing. */
export function matchesBaseline(response: OkProbeResponse, baseline: ProbeResponse): boolean {
  if (!baseline.ok || baseline.status !== response.status) return false;
  const a = normalise(response.body);
  const b = normalise(baseline.body);
  if (a === b) return true;
  const ratio = Math.min(a.length, b.length) / Math.max(a.length, b.length);
  return ratio >= BASELINE_LENGTH_RATIO && a.slice(0, BASELINE_PREFIX) === b.slice(0, BASELINE_PREFIX);
}
