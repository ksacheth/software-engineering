/**
 * F.5 detector contract: what the worker hands a detector, and what a detector
 * hands back. The orchestrator deduplicates, fingerprints and enriches the
 * result (F.6), so a detector reports only what it observed.
 */
import type { FindingSeverity } from "../scans/events.js";
import type { FindingConfidence } from "./index.js";

/** One crawled request and response, as the crawler recorded it (F.4). */
export interface CrawlRecord {
  url: string;
  method?: string;
  statusCode?: number;
  contentType?: string;
  requestHeaders?: Record<string, string> | null;
  responseHeaders?: Record<string, string> | null;
  forms?: any;
  parameters?: any;
  responseBody?: string | null;
}

export interface RawFindingEvidence {
  requestHeaders?: Record<string, string> | null;
  requestBody?: string | null;
  responseHeaders?: Record<string, string> | null;
  responseBody?: string | null;
  curlCommand?: string | null;
  extractedSnippet?: string | null;
}

export interface RawFinding {
  detectorId: string;
  name: string;
  description: string;
  remediation: string;
  severity: FindingSeverity;
  confidence: FindingConfidence;
  cwe?: string;
  owaspCategory?: string;
  affectedUrl: string;
  affectedParameter?: string | null;
  cvssScore?: number;
  cvssVector?: string;
  cveId?: string;
  epssScore?: number;
  epssPercentile?: number;
  advisoryData?: any;
  evidence?: RawFindingEvidence;
}
