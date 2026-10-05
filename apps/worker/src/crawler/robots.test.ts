// @ts-ignore
import { describe, expect, test } from "bun:test";
import { parseRobots, robotsAllows } from "./robots.js";

const UA = "WebsiteVulnerabilityScanner/1.0 (+https://scanner.example.com)";

describe("parseRobots", () => {
  test("prefers the group naming our product token over *", () => {
    const rules = parseRobots(
      "User-agent: *\nDisallow: /\n\nUser-agent: WebsiteVulnerabilityScanner\nDisallow: /admin\n",
      UA,
    );
    expect(rules.disallowed).toEqual(["/admin"]);
  });

  test("applies rules to every agent in a grouped User-agent block", () => {
    const rules = parseRobots("User-agent: googlebot\nUser-agent: *\nDisallow: /tmp\n", UA);
    expect(rules.disallowed).toEqual(["/tmp"]);
  });

  test("collects sitemaps from anywhere in the file and ignores comments", () => {
    const rules = parseRobots(
      "Sitemap: https://a.example/s1.xml\nUser-agent: other\nDisallow: /x # not us\nSitemap: https://a.example/s2.xml\n",
      UA,
    );
    expect(rules.sitemaps).toEqual(["https://a.example/s1.xml", "https://a.example/s2.xml"]);
    expect(rules.disallowed).toEqual([]);
  });

  test("treats an empty Disallow as allow-all", () => {
    expect(parseRobots("User-agent: *\nDisallow:\n", UA).disallowed).toEqual([]);
  });
});

describe("robotsAllows", () => {
  test("the longest matching rule wins", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /docs\nAllow: /docs/public\n", UA);
    expect(robotsAllows("/docs/private", rules)).toBe(false);
    expect(robotsAllows("/docs/public/a", rules)).toBe(true);
    expect(robotsAllows("/other", rules)).toBe(true);
  });
});
