import type { CrawlRecord, RawFinding, ScanProfile } from "@wvs/shared";

import type { DetectorCatalogue, DetectorDefinition } from "./definitions";
import { toPageView } from "./page-view";
import { PASSIVE_DETECTORS } from "./passive";
import type { Observation, PageView, PassiveDetector } from "./types";

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
 * without sending a request. Findings are collapsed on (detector, URL,
 * parameter), so a site-wide issue seen on every page is reported once.
 */
export function runPassiveDetectors(
  catalogue: DetectorCatalogue,
  profile: ScanProfile,
  records: CrawlRecord[],
  detectors: PassiveDetector[] = PASSIVE_DETECTORS,
): DetectionResult {
  const pages = records.map(toPageView);
  const findings = new Map<string, RawFinding>();
  const failures: DetectorFailure[] = [];

  for (const detector of detectors) {
    const definition = definitionFor(catalogue, detector.id);
    if (!definition.profiles.includes(profile)) continue;

    for (const page of pages) {
      const result = inspect(detector, definition, page);
      if ("message" in result) failures.push(result);
      else result.forEach((finding) => findings.set(findingKey(finding), findings.get(findingKey(finding)) ?? finding));
    }
  }

  return { findings: [...findings.values()], failures };
}

function inspect(detector: PassiveDetector, definition: DetectorDefinition, page: PageView): RawFinding[] | DetectorFailure {
  try {
    return detector.inspect(page).map((observation) => toFinding(definition, observation));
  } catch (error) {
    return {
      detectorId: detector.id,
      affectedUrl: page.url,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function findingKey(finding: RawFinding): string {
  return `${finding.detectorId}|${finding.affectedUrl}|${finding.affectedParameter ?? ""}`;
}

function definitionFor(catalogue: DetectorCatalogue, id: string): DetectorDefinition {
  const definition = catalogue.get(id);
  if (!definition) throw new Error(`Detector ${id} has no definition in the catalogue`);
  return definition;
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
