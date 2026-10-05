import type { PassiveDetector } from "../types";
import { CONTENT_DETECTORS } from "./content";
import { COOKIE_DETECTORS } from "./cookies";
import { DISCLOSURE_DETECTORS } from "./disclosure";
import { EXPOSURE_DETECTORS } from "./exposure";
import { FINGERPRINT_DETECTORS } from "./fingerprint";
import { HEADER_DETECTORS } from "./headers";

export const PASSIVE_DETECTORS: PassiveDetector[] = [
  ...HEADER_DETECTORS,
  ...COOKIE_DETECTORS,
  ...DISCLOSURE_DETECTORS,
  ...FINGERPRINT_DETECTORS,
  ...EXPOSURE_DETECTORS,
  ...CONTENT_DETECTORS,
];
export { fingerprint, type Technology } from "./fingerprint";
export { SECURITY_TXT_PATHS, SITE_DETECTORS } from "./site";
export { TLS_DETECTORS } from "./tls";
