// @ts-ignore
import { describe, expect, test } from "bun:test";
import { DISALLOW_ALL, parseRobots, robotsAllows } from "./robots.js";

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

  test("supports * wildcards and a trailing $ anchor", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.pdf$\nDisallow: /*?sessionid=\n", UA);
    expect(robotsAllows("/files/a.pdf", rules)).toBe(false);
    expect(robotsAllows("/files/a.pdf?x=1", rules)).toBe(true);
    expect(robotsAllows("/files/a.pdfx", rules)).toBe(true);
    expect(robotsAllows("/page?sessionid=9", rules)).toBe(false);
    expect(robotsAllows("/page?other=1", rules)).toBe(true);
  });

  test("treats other regex metacharacters literally", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /a.b(c)+\n", UA);
    expect(robotsAllows("/a.b(c)+/x", rules)).toBe(false);
    expect(robotsAllows("/aXb(c)+", rules)).toBe(true);
  });

  test("measures precedence by raw rule length and lets Allow win a tie", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /*.js\nAllow: /app/*.js\nDisallow: /tie\nAllow: /tie\n", UA);
    expect(robotsAllows("/app/main.js", rules)).toBe(true);
    expect(robotsAllows("/other/main.js", rules)).toBe(false);
    expect(robotsAllows("/tie", rules)).toBe(true);
  });

  test("stacked wildcards cannot make matching blow up", () => {
    const rules = parseRobots(`User-agent: *\nDisallow: /${"*a".repeat(30)}b\n`, UA);
    expect(robotsAllows(`/${"a".repeat(5000)}`, rules)).toBe(true);
  });

  test("DISALLOW_ALL refuses everything", () => {
    expect(robotsAllows("/", DISALLOW_ALL)).toBe(false);
    expect(robotsAllows("/x?y=1", DISALLOW_ALL)).toBe(false);
  });
});
