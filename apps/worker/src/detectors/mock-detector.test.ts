// @ts-ignore
import { describe, expect, test } from "bun:test";
import { MockDetector, type MockCrawlRecord } from "./mock-detector.js";

describe("MockDetector", () => {
  test("returns empty array for empty crawl input", () => {
    expect(MockDetector.analyze([])).toEqual([]);
    expect(MockDetector.analyze(null as any)).toEqual([]);
  });

  test("generates findings for a single crawl record", () => {
    const record: MockCrawlRecord = {
      url: "https://example.com/search?q=test",
      responseHeaders: {},
    };

    const findings = MockDetector.analyze([record]);
    expect(findings.length).toBeGreaterThan(0);

    const xss = findings.find((f) => f.detectorId === "A-01");
    expect(xss).toBeDefined();
    expect(xss?.name).toBe("Reflected Cross-Site Scripting (XSS)");
    expect(xss?.severity).toBe("HIGH");
    expect(xss?.confidence).toBe("FIRM");
    expect(xss?.affectedUrl).toBe("https://example.com/search?q=test");
    expect(xss?.affectedParameter).toBe("q");
  });

  test("generates deterministic output across multiple invocations", () => {
    const records: MockCrawlRecord[] = [
      { url: "https://example.com/page1", responseHeaders: {} },
      { url: "https://example.com/login?id=123", responseHeaders: {} },
      { url: "https://example.com/search?query=hello", responseHeaders: { "Strict-Transport-Security": "max-age=31536000", "Content-Security-Policy": "default-src 'self'" } },
    ];

    const run1 = MockDetector.analyze(records);
    const run2 = MockDetector.analyze(records);

    expect(run1).toEqual(run2);
  });

  test("handles multiple crawl records and produces expected finding structure", () => {
    const records: MockCrawlRecord[] = [
      {
        url: "https://target.com/login?user=admin",
        responseHeaders: {},
      },
      {
        url: "https://target.com/search?q=foo",
        responseHeaders: {
          "Strict-Transport-Security": "max-age=31536000",
          "Content-Security-Policy": "default-src 'self'",
        },
      },
    ];

    const findings = MockDetector.analyze(records);
    expect(findings.length).toBeGreaterThan(0);

    for (const finding of findings) {
      expect(typeof finding.detectorId).toBe("string");
      expect(typeof finding.name).toBe("string");
      expect(typeof finding.description).toBe("string");
      expect(typeof finding.remediation).toBe("string");
      expect(["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"]).toContain(finding.severity);
      expect(["CONFIRMED", "FIRM", "TENTATIVE"]).toContain(finding.confidence);
      expect(typeof finding.affectedUrl).toBe("string");
      expect(finding.evidence).toBeDefined();
    }

    const sqli = findings.find((f) => f.detectorId === "A-02");
    expect(sqli).toBeDefined();
    expect(sqli?.severity).toBe("CRITICAL");
    expect(sqli?.cwe).toBe("CWE-89");
  });
});
