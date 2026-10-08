import { TokenBucket, type BlocklistEntry, type ScopeSnapshot } from "@wvs/scope-guard";
import type { CrawlRecord, RawFinding, ScanProfile, ScanWarningCode } from "@wvs/shared";
import {
  createMarkerFactory,
  loadDefinitions,
  runActiveDetectors,
  runPassiveDetectors,
  runTlsDetectors,
  type ActiveSurface,
  type DetectorCatalogue,
  type DetectorFailure,
  type ProbeFn,
} from "@wvs/detectors";

import { crawl, type CrawlOptions, type CrawlSummary, type CrawlerDb } from "../crawler/crawler.js";
import type { PageRenderer } from "../crawler/renderer.js";
import { dispatch, type LedgerClient, type RequestBudget } from "../scope-guard/dispatch.js";
import { probeTls, type TlsProbeOptions } from "../tls/tls-probe.js";

export type EngineDb = CrawlerDb & LedgerClient;

export interface EngineInput {
  scanJobId: string;
  profile: ScanProfile;
  scope: ScopeSnapshot;
  adminBlocklist: readonly BlocklistEntry[];
  isKillSwitchEngaged: () => Promise<boolean>;
  /** True once the scan was paused or cancelled (ADR-0007); read before every request. */
  shouldStop?: () => Promise<boolean>;
  /** What an earlier run of this scan already spent, so a resumed job keeps one budget. */
  resumeFrom?: CrawlOptions["resumeFrom"];
  /** Starts the headless renderer for this scan; omitted, or failing, the crawl is static only. */
  launchRenderer?: (userAgent: string) => Promise<PageRenderer>;
  userAgent: string;
  /** Replace the TLS probe's sockets, for tests. */
  tlsConnectors?: TlsProbeOptions["connectors"];
}

/** Why a run ended before every phase finished. */
export type EngineAbort = "KILL_SWITCH" | "STOPPED";

export interface EngineWarning {
  code: ScanWarningCode;
  message: string;
}

export interface EngineResult {
  findings: RawFinding[];
  failures: DetectorFailure[];
  pagesCrawled: number;
  /** Crawl, TLS and active requests together, resumed spend included. */
  requestsMade: number;
  /** Set when the run was cut short; the findings are then empty and the scan is not complete. */
  aborted: EngineAbort | null;
  /** Active probes the guard refused: coverage the scan did not get. */
  probesRefused: number;
  warnings: EngineWarning[];
}

/** Bodies are kept for the passive detectors only, and they never read past this (page-view.ts). */
const MAX_KEPT_BODY_CHARS = 512 * 1024;
/** Binary content the detectors never read; its body is dropped as soon as it is crawled. */
const BINARY_CONTENT = /^(image|audio|video|font)\/|^application\/(pdf|zip|gzip|x-tar|x-7z-compressed|x-rar-compressed|wasm)/i;

/** URLs that look like an administrative interface (A-13). */
const ADMIN_URL = /\/(admin|administrator|dashboard|manage|wp-admin)(\/|$)/i;

/**
 * F.4 + F.5 end to end: crawl the target, probe its TLS, then run the passive,
 * TLS and (for non-PASSIVE profiles) safe-active detectors over what was found.
 * Every request goes through the scope guard and counts toward one shared
 * ceiling. A kill switch, pause or cancel ends the run early with `aborted`
 * set. The caller persists the findings.
 */
export async function runScanEngine(
  db: EngineDb,
  input: EngineInput,
  catalogue?: DetectorCatalogue,
): Promise<EngineResult> {
  const definitions = catalogue ?? (await loadDefinitions());
  const limiter = new TokenBucket(input.scope.rateLimit);
  const records: CrawlRecord[] = [];
  const warnings: EngineWarning[] = [];
  const budget: RequestBudget = { requestsMade: 0 };

  const summary = await crawlWithRenderer(db, input, limiter, records, warnings);
  budget.requestsMade = summary.requestsMade;
  warnings.push(...crawlWarnings(summary));

  const result = (aborted: EngineAbort | null, rest: Partial<EngineResult> = {}): EngineResult => ({
    findings: [],
    failures: [],
    pagesCrawled: summary.pagesCrawled,
    requestsMade: budget.requestsMade,
    aborted,
    probesRefused: 0,
    warnings,
    ...rest,
  });

  const crawlHalt = summary.stoppedBy === "KILL_SWITCH" || summary.stoppedBy === "STOPPED" ? summary.stoppedBy : null;
  const beforeTls = crawlHalt ?? (await checkpoint(input));
  if (beforeTls) return result(beforeTls);

  const tlsFacts = await probeTls(db, {
    scanJobId: input.scanJobId,
    scope: input.scope,
    adminBlocklist: input.adminBlocklist,
    isKillSwitchEngaged: input.isKillSwitchEngaged,
    limiter,
    budget,
    connectors: input.tlsConnectors,
  });
  const beforeDetection = await checkpoint(input);
  if (beforeDetection) return result(beforeDetection);

  const passive = runPassiveDetectors(definitions, input.profile, records);
  const tls = runTlsDetectors(definitions, input.profile, tlsFacts);
  releaseBodies(records);
  const active = await runScanActiveDetectors({ db, catalogue: definitions, input, limiter, records, budget });
  if (active.aborted) return result(active.aborted, { probesRefused: active.probesRefused });
  if (active.budgetSpent && summary.stoppedBy !== "CEILING") {
    warnings.push({ code: "CRAWL_LIMIT_REACHED", message: "The request limit was reached before every active check ran." });
  }

  return result(null, {
    findings: [...passive.findings, ...tls.findings, ...active.findings],
    failures: [...passive.failures, ...tls.failures, ...active.failures],
    probesRefused: active.probesRefused,
  });
}

/** What the user should know about how the crawl ended. */
function crawlWarnings(summary: CrawlSummary): EngineWarning[] {
  const warnings: EngineWarning[] = [];
  if (summary.stoppedBy === "CEILING") {
    warnings.push({ code: "CRAWL_LIMIT_REACHED", message: "The crawl stopped at a page or request limit." });
  }
  if (summary.robotsDisallowAll) {
    warnings.push({
      code: "TARGET_BLOCKING_DETECTED",
      message: "robots.txt could not be fetched, so no pages were crawled (RFC 9309 treats that as disallow-all).",
    });
  }
  return warnings;
}

/** The kill switch, then a pause or cancel; null when the scan may go on. */
async function checkpoint(input: EngineInput): Promise<EngineAbort | null> {
  if (await input.isKillSwitchEngaged()) return "KILL_SWITCH";
  return (await input.shouldStop?.()) ? "STOPPED" : null;
}

/** Crawls with a headless renderer when one starts, and always closes it. */
async function crawlWithRenderer(
  db: EngineDb,
  input: EngineInput,
  limiter: TokenBucket,
  records: CrawlRecord[],
  warnings: EngineWarning[],
): Promise<CrawlSummary> {
  const renderer = await launchRenderer(input, warnings);
  try {
    return await crawl(db, {
      scanJobId: input.scanJobId,
      scope: input.scope,
      adminBlocklist: input.adminBlocklist,
      isKillSwitchEngaged: input.isKillSwitchEngaged,
      shouldStop: input.shouldStop,
      resumeFrom: input.resumeFrom,
      userAgent: input.userAgent,
      limiter,
      renderer,
      onPage: (record) => records.push(keepableRecord(record)),
    });
  } finally {
    await renderer?.close().catch(() => undefined);
  }
}

/** A missing browser degrades the crawl to static; it never fails the scan. */
async function launchRenderer(input: EngineInput, warnings: EngineWarning[]): Promise<PageRenderer | undefined> {
  if (!input.launchRenderer) return undefined;
  try {
    return await input.launchRenderer(input.userAgent);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
    console.warn(`[Engine] Scan ${input.scanJobId}: headless renderer unavailable, crawling statically: ${reason}`);
    warnings.push({ code: "RENDERING_UNAVAILABLE", message: "JavaScript rendering was unavailable; the crawl was static only." });
    return undefined;
  }
}

/** Keeps the body only when a detector can read it, and no more than it reads. */
export function keepableRecord(record: CrawlRecord): CrawlRecord {
  const body = record.responseBody;
  if (!body || BINARY_CONTENT.test(record.contentType ?? "")) return { ...record, responseBody: null };
  return body.length > MAX_KEPT_BODY_CHARS ? { ...record, responseBody: body.slice(0, MAX_KEPT_BODY_CHARS) } : record;
}

/** The active phase reads URLs, forms and headers, never bodies. */
function releaseBodies(records: CrawlRecord[]): void {
  for (const record of records) record.responseBody = null;
}

interface ActiveRun {
  db: EngineDb;
  catalogue: DetectorCatalogue;
  input: EngineInput;
  limiter: TokenBucket;
  records: CrawlRecord[];
  budget: RequestBudget;
}

type ActiveOutcome = Awaited<ReturnType<typeof runActiveDetectors>> & {
  aborted: EngineAbort | null;
  probesRefused: number;
  /** Probes skipped because the scan's request budget was already spent. */
  budgetSpent: boolean;
};

async function runScanActiveDetectors({ db, catalogue, input, limiter, records, budget }: ActiveRun): Promise<ActiveOutcome> {
  const state = { aborted: null as EngineAbort | null, probesRefused: 0, budgetSpent: false };

  const probe: ProbeFn = async (request) => {
    if (state.aborted) return { ok: false };
    // Once maxRequests is spent every probe would be refused anyway; skip the
    // pacing wait and the ledger row for each one.
    if (budget.requestsMade >= input.scope.maxRequests) {
      state.budgetSpent = true;
      return { ok: false };
    }
    try {
      await sleep(limiter.msUntilAvailable());
      const killSwitchEngaged = await input.isKillSwitchEngaged();
      if (!killSwitchEngaged && (await input.shouldStop?.())) {
        state.aborted = "STOPPED";
        return { ok: false };
      }
      // Counted before dispatching, like the crawl, so the ceiling sees every probe sent.
      const requestsMade = budget.requestsMade++;
      const result = await dispatch(db, {
        url: request.url,
        method: request.method,
        headers: request.headers,
        scanJobId: input.scanJobId,
        scope: input.scope,
        adminBlocklist: input.adminBlocklist,
        killSwitchEngaged,
        pagesCrawled: 0,
        requestsMade,
        depth: 0,
        userAgent: input.userAgent,
        rateLimiter: limiter,
        allowPlaintextTwin: isPlaintextTwin(request.url, input.scope.origin),
      });
      if (!result.ok) {
        budget.requestsMade -= 1;
        state.probesRefused += 1;
        if (result.decision.code === "KILL_SWITCH") state.aborted = "KILL_SWITCH";
        return { ok: false };
      }
      return { ok: true, status: result.status, headers: result.headers, body: result.body };
    } catch {
      // Timeouts and network errors are ledgered by dispatch; one slow endpoint must not lose the detector's other observations.
      return { ok: false };
    }
  };

  const surface: ActiveSurface = {
    origin: input.scope.origin,
    entryUrls: records.filter((r) => r.contentType?.includes("html")).map((r) => r.url),
    parameterUrls: records.map((r) => r.url).filter((url) => new URL(url).search !== ""),
    parameters: collectParameters(records),
    forms: collectForms(records),
    adminUrls: records.map((r) => r.url).filter((url) => ADMIN_URL.test(url)),
    entryHeaders: records[0]?.responseHeaders ?? {},
  };

  const outcome = await runActiveDetectors(catalogue, input.profile, { surface, probe, marker: createMarkerFactory(input.scanJobId) });
  return { ...outcome, ...state };
}

/** A-14 asks for the http:// root of an https scope, which the guard admits only when told. */
function isPlaintextTwin(probeUrl: string, scopeOrigin: string): boolean {
  try {
    const url = new URL(probeUrl);
    const origin = new URL(scopeOrigin);
    return (
      origin.protocol === "https:" &&
      url.protocol === "http:" &&
      url.hostname === origin.hostname &&
      url.port === "" &&
      url.pathname === "/"
    );
  } catch {
    return false;
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
