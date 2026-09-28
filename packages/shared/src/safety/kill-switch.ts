/**
 * F.8 kill switch contract (ADR-0008).
 *
 * The administration side writes this setting; the Scope Guard reads it before
 * every outbound request. Both import the names from here so neither can drift.
 *
 * `system_setting.value` holds `engaged` or `released`. A missing row means the
 * switch has never been used, which reads as released. A row the reader cannot
 * fetch at all is a different case: the Scope Guard must treat that as engaged,
 * because a safety kernel that cannot tell whether it has been told to stop must
 * stop.
 */

export const KILL_SWITCH_SETTING_KEY = "scan.kill_switch";

export const KILL_SWITCH_STATES = ["engaged", "released"] as const;
export type KillSwitchState = (typeof KILL_SWITCH_STATES)[number];

/**
 * Whether a stored value means scanning is halted.
 *
 * Anything other than the literal `released` or an absent row reads as engaged,
 * so a corrupted value fails closed rather than open.
 */
export function isKillSwitchEngaged(value: string | null | undefined): boolean {
  if (value === null || value === undefined) return false;
  return value !== "released";
}
