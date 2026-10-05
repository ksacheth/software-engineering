import type { RawFinding, ScanProfile } from "@wvs/shared";

import type { DetectorCatalogue, DetectorDefinition } from "../definitions";
import { toFinding, type DetectionResult, type DetectorFailure } from "../runner";
import { ACTIVE_DETECTORS } from "./index";
import type { ActiveContext, ActiveDetector } from "./types";

/**
 * Runs the safe-active detectors the profile enables (F.5). Active definitions
 * list only STANDARD and THOROUGH, so a PASSIVE scan runs none of them without
 * a special case here. A detector that throws is recorded and the rest run on.
 * Findings are collapsed on (detector, URL, parameter).
 */
export async function runActiveDetectors(
  catalogue: DetectorCatalogue,
  profile: ScanProfile,
  context: ActiveContext,
  detectors: ActiveDetector[] = ACTIVE_DETECTORS,
): Promise<DetectionResult> {
  const findings = new Map<string, RawFinding>();
  const failures: DetectorFailure[] = [];

  for (const detector of detectors) {
    const definition = definitionFor(catalogue, detector.id);
    if (!definition.profiles.includes(profile)) continue;

    const result = await runOne(detector, definition, context);
    if ("message" in result) failures.push(result);
    else for (const finding of result) findings.set(keyOf(finding), findings.get(keyOf(finding)) ?? finding);
  }

  return { findings: [...findings.values()], failures };
}

async function runOne(
  detector: ActiveDetector,
  definition: DetectorDefinition,
  context: ActiveContext,
): Promise<RawFinding[] | DetectorFailure> {
  try {
    const observations = await detector.run(context);
    return observations.map((observation) => toFinding(definition, observation));
  } catch (error) {
    return {
      detectorId: detector.id,
      affectedUrl: context.surface.origin,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function definitionFor(catalogue: DetectorCatalogue, id: string): DetectorDefinition {
  const definition = catalogue.get(id);
  if (!definition) throw new Error(`Detector ${id} has no definition in the catalogue`);
  return definition;
}

function keyOf(finding: RawFinding): string {
  return `${finding.detectorId}|${finding.affectedUrl}|${finding.affectedParameter ?? ""}`;
}
