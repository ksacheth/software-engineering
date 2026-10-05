import type { ActiveDetector } from "./types";
import { ACCESS_DETECTORS } from "./access";
import { HTTP_DETECTORS } from "./http";
import { INJECTION_DETECTORS } from "./injection";

/** Every safe-active detector (A-01..A-14), in catalogue order. */
export const ACTIVE_DETECTORS: ActiveDetector[] = [...INJECTION_DETECTORS, ...HTTP_DETECTORS, ...ACCESS_DETECTORS].sort(
  (a, b) => a.id.localeCompare(b.id),
);

export { createMarker } from "./marker";
export { runActiveDetectors } from "./runner";
export type { ActiveContext, ActiveDetector, ActiveSurface, ProbeFn, ProbeRequest, ProbeResponse } from "./types";
