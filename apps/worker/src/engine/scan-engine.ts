import { TokenBucket, type ScopeSnapshot } from "@wvs/scope-guard";
import type { CrawlRecord, RawFinding, ScanProfile } from "@wvs/shared";
import {
  loadDefinitions,
  runActiveDetectors,
  runPassiveDetectors,
  runTlsDetectors,
  type ActiveSurface,
  type DetectorCatalogue,
  type DetectorFailure,
  type ProbeFn,
} from "@wvs/detectors";

import { crawl, type CrawlerDb } from "../crawler/crawler.js";
import { dispatch, type LedgerClient } from "../scope-guard/dispatch.js";
import { probeTls } from "../tls/tls-probe.js";

export type EngineDb = CrawlerDb & LedgerClient;

export interface EngineInput {
  scanJobId: string;
  profile: ScanProfile;
  scope: ScopeSnapshot;
  adminBlocklist: string[];
  isKillSwitchEngaged: () => Promise<boolean>;
  userAgent: string;
}

export interface EngineResult {
  findings: RawFinding[];
  failures: DetectorFailure[];
  pagesCrawled: number;
  requestsMade: number;
}

/** URLs that look like an administrative interface (A-13). */
const ADMIN_URL = /\/(admin|administrator|dashboard|manage|wp-admin)(\/|$)/i;

/**
 * F.4 + F.5 end to end: crawl the target, probe its TLS, then run the passive,
 * TLS and (for non-PASSIVE profiles) safe-active detectors over what was found.
 * Every request goes through the scope guard. The caller persists the findings.
 */
export async function runScanEngine(
  db: EngineDb,
  input: EngineInput,
  catalogue?: DetectorCatalogue,
): Promise<EngineResult> {
  const definitions = catalogue ?? (await loadDefinitions());
  const limiter = new TokenBucket(input.scope.rateLimit);
  const records: CrawlRecord[] = [];

  const summary = await crawl(db, {
    scanJobId: input.scanJobId,
    scope: input.scope,
    adminBlocklist: input.adminBlocklist,
    isKillSwitchEngaged: input.isKillSwitchEngaged,
    userAgent: input.userAgent,
    limiter,
    onPage: (record) => records.push(record),
  });

  const tlsFacts = await probeTls(db, {
    scanJobId: input.scanJobId,
    scope: input.scope,
    adminBlocklist: input.adminBlocklist,
    isKillSwitchEngaged: input.isKillSwitchEngaged,
    limiter,
  });

  const passive = runPassiveDetectors(definitions, input.profile, records);
  const tls = runTlsDetectors(definitions, input.profile, tlsFacts);
  const active = await runScanActiveDetectors({ db, catalogue: definitions, input, limiter, records });

  return {
    findings: [...passive.findings, ...tls.findings, ...active.findings],
    failures: [...passive.failures, ...tls.failures, ...active.failures],
    pagesCrawled: summary.pagesCrawled,
    requestsMade: summary.requestsMade,
  };
}

interface ActiveRun {
  db: EngineDb;
  catalogue: DetectorCatalogue;
  input: EngineInput;
  limiter: TokenBucket;
  records: CrawlRecord[];
}

function runScanActiveDetectors({ db, catalogue, input, limiter, records }: ActiveRun) {
  const probe: ProbeFn = async (request) => {
    const result = await dispatch(db, {
      url: request.url,
      method: request.method,
      headers: request.headers,
      scanJobId: input.scanJobId,
      scope: input.scope,
      adminBlocklist: input.adminBlocklist,
      killSwitchEngaged: await input.isKillSwitchEngaged(),
      pagesCrawled: 0,
      requestsMade: 0,
      depth: 0,
      userAgent: input.userAgent,
      rateLimiter: limiter,
    });
    return result.ok
      ? { ok: true, status: result.status, headers: result.headers, body: result.body }
      : { ok: false };
  };

  const surface: ActiveSurface = {
    origin: input.scope.origin,
    entryUrls: records.filter((r) => r.contentType?.includes("html")).map((r) => r.url),
    parameters: collectParameters(records),
    forms: collectForms(records),
    adminUrls: records.map((r) => r.url).filter((url) => ADMIN_URL.test(url)),
    entryHeaders: records[0]?.responseHeaders ?? {},
  };

  return runActiveDetectors(catalogue, input.profile, { surface, probe, marker: markerFactory(input.scanJobId) });
}

function collectParameters(records: CrawlRecord[]): string[] {
  const names = new Set<string>();
  for (const record of records) {
    for (const key of new URL(record.url).searchParams.keys()) names.add(key);
    for (const form of asForms(record.forms)) for (const input of form.inputs ?? []) if (input?.name) names.add(input.name);
  }
  return [...names];
}

function collectForms(records: CrawlRecord[]): ActiveSurface["forms"] {
  return records.flatMap((record) => asForms(record.forms));
}

function asForms(forms: unknown): ActiveSurface["forms"] {
  return Array.isArray(forms) ? (forms as ActiveSurface["forms"]) : [];
}

/** Markers stay unique within a scan without pulling in node:crypto per call. */
function markerFactory(scanJobId: string): () => string {
  let counter = 0;
  return () => `wvsprobe${scanJobId.replace(/[^a-z0-9]/gi, "").slice(0, 8)}${(counter++).toString(36)}`;
}
