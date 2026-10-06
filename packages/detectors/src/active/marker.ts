import { randomBytes } from "node:crypto";

/** A factory of inert tokens the scanner can recognise in a response. A token
 *  carries no markup or code, so reflecting it changes nothing; the detector
 *  reports only that a value it supplied came back where it should not have.
 *  The seed (for example a scan job id) keeps tokens unique to one scan, and a
 *  counter keeps them unique within it. */
export function createMarkerFactory(seed: string): () => string {
  const prefix = `wvsprobe${seed.replace(/[^a-z0-9]/gi, "").slice(0, 8)}`;
  let counter = 0;
  return () => `${prefix}${(counter++).toString(36)}`;
}

/** A marker source seeded randomly once per process. */
export const createMarker: () => string = createMarkerFactory(randomBytes(6).toString("hex"));
