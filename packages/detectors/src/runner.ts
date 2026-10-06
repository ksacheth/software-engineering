import type { CrawlRecord, RawFinding, ScanProfile, TlsFacts } from "@wvs/shared";

import type { DetectorCatalogue, DetectorDefinition } from "./definitions";
import { toPageView } from "./page-view";
import { PASSIVE_DETECTORS, SITE_DETECTORS, TLS_DETECTORS } from "./passive";
import type { Detector, Observation, PageView, PassiveDetector, SiteDetector, SiteView, TlsDetector } from "./types";

/** A detector that threw. F.5: record it and carry on with the rest. */
export interface DetectorFailure {
  detectorId: string;
  affectedUrl: string;
  message: string;
}

export interface DetectionResult {
  findings: RawFinding[];
  failures: DetectorFailure[];
}

/**
 * Runs every passive detector the profile enables over the crawled pages,
 * then the site-wide ones over each origin, without sending a request.
 * Findings are collapsed on (detector, URL, parameter), so a site-wide issue
 * seen on every page is reported once.
 */
export function runPassiveDetectors(
  catalogue: DetectorCatalogue,
  profile: ScanProfile,
  records: CrawlRecord[],
  detectors: { page?: PassiveDetector[]; site?: SiteDetector[] } = {},
): DetectionResult {
  const { pages, failures: setupFailures } = toPageViews(records);
  const perPage = runDetectors(catalogue, profile, detectors.page ?? PASSIVE_DETECTORS, pages, (page) => page.url);
  const perSite = runDetectors(catalogue, profile, detectors.site ?? SITE_DETECTORS, sites(pages), (site) => `${site.origin}/`);
  return {
    findings: [...perPage.findings, ...perSite.findings],
    failures: [...setupFailures, ...perPage.failures, ...perSite.failures],
  };
}

/** One record that cannot become a page (say, an unparseable URL) must not abort the run (F.5). */
function toPageViews(records: CrawlRecord[]): { pages: PageView[]; failures: DetectorFailure[] } {
  const pages: PageView[] = [];
  const failures: DetectorFailure[] = [];
  for (const record of records) {
    try {
      pages.push(toPageView(record));
    } catch (error) {
      failures.push({ detectorId: "page-view", affectedUrl: record.url, message: messageOf(error) });
    }
  }
  return { pages, failures };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sites(pages: PageView[]): SiteView[] {
  const byOrigin = new Map<string, PageView[]>();
  for (const page of pages) byOrigin.set(page.origin, [...(byOrigin.get(page.origin) ?? []), page]);
  return [...byOrigin].map(([origin, sitePages]) => ({ origin, pages: sitePages }));
}

/** P-11..P-16 over the TLS probe's result; nothing to judge for a plaintext origin. */
export function runTlsDetectors(
  catalogue: DetectorCatalogue,
  profile: ScanProfile,
  facts: TlsFacts | null,
  detectors: TlsDetector[] = TLS_DETECTORS,
): DetectionResult {
  return runDetectors(catalogue, profile, detectors, facts ? [facts] : [], (input) => `${input.origin}/`);
}

function runDetectors<Input>(
  catalogue: DetectorCatalogue,
  profile: ScanProfile,
  detectors: Detector<Input>[],
  inputs: Input[],
  locate: (input: Input) => string,
): DetectionResult {
  const findings = new Map<string, RawFinding>();
  const failures: DetectorFailure[] = [];

  for (const detector of detectors) {
    const definition = catalogue.get(detector.id);
    if (!definition) {
      failures.push({
        detectorId: detector.id,
        affectedUrl: inputs[0] === undefined ? "" : locate(inputs[0]),
        message: `Detector ${detector.id} has no definition in the catalogue`,
      });
      continue;
    }
    if (!definition.profiles.includes(profile)) continue;

    for (const input of inputs) {
      const result = inspect(detector, definition, input, locate);
      if ("message" in result) failures.push(result);
      else result.forEach((finding) => findings.set(findingKey(finding), findings.get(findingKey(finding)) ?? finding));
    }
  }

  return { findings: [...findings.values()], failures };
}

function inspect<Input>(
  detector: Detector<Input>,
  definition: DetectorDefinition,
  input: Input,
  locate: (input: Input) => string,
): RawFinding[] | DetectorFailure {
  try {
    return detector.inspect(input).map((observation) => toFinding(definition, observation));
  } catch (error) {
    return {
      detectorId: detector.id,
      affectedUrl: locate(input),
      message: messageOf(error),
    };
  }
}

function findingKey(finding: RawFinding): string {
  return `${finding.detectorId}|${finding.affectedUrl}|${finding.affectedParameter ?? ""}`;
}

export function toFinding(definition: DetectorDefinition, observation: Observation): RawFinding {
  const severity = observation.severity ?? (definition.severity === "VARIES" ? undefined : definition.severity);
  if (!severity) throw new Error(`${definition.id} has severity VARIES but reported none`);

  return {
    detectorId: definition.id,
    name: definition.name,
    description: `${definition.description} ${observation.detail}`,
    remediation: definition.remediation,
    severity,
    confidence: definition.confidence,
    cwe: definition.cwe ?? undefined,
    owaspCategory: definition.owaspCategory ?? undefined,
    affectedUrl: observation.affectedUrl,
    affectedParameter: observation.affectedParameter ?? null,
    evidence: observation.evidence,
  };
}
