import type { FindingSeverity, RawFindingEvidence, TlsFacts } from "@wvs/shared";

/** One response, as a detector sees it. */
export interface PageView {
  url: string;
  origin: string;
  isHttps: boolean;
  statusCode: number;
  contentType: string;
  /** True for a successful HTML document, the only kind header policies apply to. */
  isHtmlDocument: boolean;
  /** Case-insensitive response header lookup. */
  header(name: string): string | undefined;
  /** Every Set-Cookie header, unmerged. */
  setCookies: string[];
  responseHeaders: Record<string, string>;
  body: string | null;
}

/**
 * What a detector saw. The runner turns it into a finding using the
 * detector's YAML definition, so detectors never restate names, CWEs or
 * severities.
 */
export interface Observation {
  affectedUrl: string;
  affectedParameter?: string | null;
  /** Specific to this occurrence; appended to the definition's description. */
  detail: string;
  /** Required only when the definition's severity is VARIES. */
  severity?: FindingSeverity;
  evidence?: RawFindingEvidence;
}

export interface Detector<Input> {
  id: string;
  inspect(input: Input): Observation[];
}

/** Judges one crawled response. */
export type PassiveDetector = Detector<PageView>;

/** Judges what the TLS probe learned about the origin. */
export type TlsDetector = Detector<TlsFacts>;
