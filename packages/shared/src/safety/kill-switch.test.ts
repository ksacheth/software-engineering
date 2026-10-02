import { describe, expect, test } from "bun:test";
import { isKillSwitchEngaged } from "./kill-switch.js";

describe("isKillSwitchEngaged", () => {
  test("a switch that was never used is released", () => {
    expect(isKillSwitchEngaged(undefined)).toBe(false);
    expect(isKillSwitchEngaged(null)).toBe(false);
  });

  test("reads the two stored states", () => {
    expect(isKillSwitchEngaged("engaged")).toBe(true);
    expect(isKillSwitchEngaged("released")).toBe(false);
  });

  test("a value it does not recognise halts scanning", () => {
    expect(isKillSwitchEngaged("true")).toBe(true);
    expect(isKillSwitchEngaged("")).toBe(true);
  });
});
