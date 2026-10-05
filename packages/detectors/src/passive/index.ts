import type { PassiveDetector } from "../types";
import { COOKIE_DETECTORS } from "./cookies";
import { DISCLOSURE_DETECTORS } from "./disclosure";
import { FINGERPRINT_DETECTORS } from "./fingerprint";
import { HEADER_DETECTORS } from "./headers";

export const PASSIVE_DETECTORS: PassiveDetector[] = [
  ...HEADER_DETECTORS,
  ...COOKIE_DETECTORS,
  ...DISCLOSURE_DETECTORS,
  ...FINGERPRINT_DETECTORS,
];
export { fingerprint, type Technology } from "./fingerprint";
export { TLS_DETECTORS } from "./tls";
