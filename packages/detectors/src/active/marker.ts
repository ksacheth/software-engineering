import { randomBytes } from "node:crypto";

/** An inert token the scanner can recognise in a response. It carries no markup
 *  or code, so reflecting it changes nothing; the detector reports only that a
 *  value it supplied came back where it should not have. */
export function createMarker(): string {
  return `wvsprobe${randomBytes(6).toString("hex")}`;
}
