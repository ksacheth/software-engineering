import type { PassiveDetector } from "../types";
import { COOKIE_DETECTORS } from "./cookies";
import { HEADER_DETECTORS } from "./headers";

export const PASSIVE_DETECTORS: PassiveDetector[] = [...HEADER_DETECTORS, ...COOKIE_DETECTORS];
