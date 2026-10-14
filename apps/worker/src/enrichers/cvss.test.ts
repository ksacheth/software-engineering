// @ts-ignore
import { describe, expect, test } from "bun:test";
import { cvssBaseScore } from "./cvss.js";

/**
 * The first three expected scores are NVD's published base scores for those
 * CVEs, so a mistake in a weight or in the scope-changed formula shows up as a
 * wrong number rather than a test agreeing with itself. The other vectors cover
 * the remaining weights and were worked by hand from the specification.
 */

describe("cvssBaseScore", () => {
  test.each([
    // CVE-2019-11358, jQuery prototype pollution: scope changed, user interaction.
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N", 6.1],
    // CVE-2021-41773, Apache 2.4.49 path traversal.
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N", 7.5],
    // CVE-2021-44228, Log4Shell: the scope-changed maximum.
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H", 10],
    // The common critical shape.
    ["CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H", 9.8],
    // Privileges required weigh more under a changed scope.
    ["CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:C/C:L/I:L/A:N", 6.4],
    // A local, high-complexity, low-impact issue.
    ["CVSS:3.1/AV:L/AC:H/PR:H/UI:R/S:U/C:L/I:N/A:N", 1.8],
  ])("scores %s as %d", (vector: string, score: number) => {
    expect(cvssBaseScore(vector)).toBe(score);
  });

  test("scores a v3.0 vector with the same formula", () => {
    expect(cvssBaseScore("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N")).toBe(7.5);
  });

  test("scores no impact as zero", () => {
    expect(cvssBaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  });

  test("accepts metrics in any order", () => {
    expect(cvssBaseScore("CVSS:3.1/S:U/C:H/I:N/A:N/AV:N/AC:L/PR:N/UI:N")).toBe(7.5);
  });

  test.each([
    ["a v4 vector", "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N"],
    ["a v2 vector", "AV:N/AC:L/Au:N/C:P/I:P/A:P"],
    ["a missing metric", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N"],
    ["an unknown value", "CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"],
    ["an unknown scope", "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:Z/C:H/I:N/A:N"],
    ["a value named after an object property", "CVSS:3.1/AV:constructor/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N"],
    ["an empty string", ""],
  ])("does not score %s", (_label: string, vector: string) => {
    expect(cvssBaseScore(vector)).toBeNull();
  });
});
