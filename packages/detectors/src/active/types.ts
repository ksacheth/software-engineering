import type { Observation } from "../types";

/** A safe-active request. The scope guard permits only these methods, so a
 *  detector cannot issue a mutating one even by mistake (F.5). */
export interface ProbeRequest {
  url: string;
  method: "GET" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;
}

export type ProbeResponse =
  | { ok: true; status: number; headers: Headers; body: string }
  | { ok: false };

/** A probe reply that completed, narrowed out of ProbeResponse. */
export type OkProbeResponse = Extract<ProbeResponse, { ok: true }>;

/** One guarded, rate-limited, ledgered request. Returns ok:false when the
 *  guard refused or the request never completed. */
export type ProbeFn = (request: ProbeRequest) => Promise<ProbeResponse>;

/** What the crawl found, which the active detectors probe further. */
export interface ActiveSurface {
  /** The scope origin, e.g. https://shop.example.com. */
  origin: string;
  /** Pages that returned HTML, used to pick realistic probe targets. */
  entryUrls: string[];
  /** Query parameter names seen across the crawl (URLs and form fields); each is probed once, up to a cap. */
  parameters: string[];
  /** Forms found during the crawl (A-10). */
  forms: Array<{ action: string; method: string; inputs: Array<{ name: string; type: string }> }>;
  /** Admin/dashboard-looking URLs found during the crawl (A-13). */
  adminUrls: string[];
  /** Response headers of the first entry page (A-06). */
  entryHeaders: Record<string, string>;
}

export interface ActiveContext {
  surface: ActiveSurface;
  probe: ProbeFn;
  /** A fresh benign marker: random, inert, unique to this scan. */
  marker(): string;
}

/** Judges one origin by sending safe probes and reading the replies. */
export interface ActiveDetector {
  id: string;
  run(context: ActiveContext): Promise<Observation[]>;
}
