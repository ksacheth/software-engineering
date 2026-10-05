// @ts-ignore
import { describe, expect, test } from "bun:test";
import { Deduplicator } from "./deduplicator.js";
import type { RawFinding } from "../detectors/mock-detector.js";

describe("Deduplicator", () => {
  test("unique findings remain unique", () => {
    const rawFindings: RawFinding[] = [
      {
        detectorId: "A-01",
        name: "XSS 1",
        description: "XSS on page 1",
        remediation: "Remediate",
        severity: "HIGH",
        confidence: "FIRM",
        affectedUrl: "https://example.com/page1",
        affectedParameter: "q",
      },
      {
        detectorId: "A-02",
        name: "SQLi 1",
        description: "SQLi on page 2",
        remediation: "Remediate",
        severity: "CRITICAL",
        confidence: "CONFIRMED",
        affectedUrl: "https://example.com/page2",
        affectedParameter: "id",
      },
    ];

    const deduped = Deduplicator.deduplicate(rawFindings);
    expect(deduped.length).toBe(2);
    expect(deduped[0].occurrenceCount).toBe(1);
    expect(deduped[1].occurrenceCount).toBe(1);
  });

  test("exact duplicates collapse into single finding with updated occurrenceCount", () => {
    const rawFindings: RawFinding[] = Array(50).fill(null).map(() => ({
      detectorId: "A-01",
      name: "Reflected XSS",
      description: "XSS on search endpoint",
      remediation: "Encode output",
      severity: "HIGH",
      confidence: "FIRM",
      affectedUrl: "https://example.com/search",
      affectedParameter: "q",
    }));

    const deduped = Deduplicator.deduplicate(rawFindings);
    expect(deduped.length).toBe(1);
    expect(deduped[0].occurrenceCount).toBe(50);
    expect(deduped[0].occurrences.length).toBe(50);
  });

  test("same detector with different locations remain separate", () => {
    const rawFindings: RawFinding[] = [
      {
        detectorId: "A-01",
        name: "XSS Page 1",
        description: "XSS",
        remediation: "Fix",
        severity: "HIGH",
        confidence: "FIRM",
        affectedUrl: "https://example.com/page1",
        affectedParameter: "q",
      },
      {
        detectorId: "A-01",
        name: "XSS Page 2",
        description: "XSS",
        remediation: "Fix",
        severity: "HIGH",
        confidence: "FIRM",
        affectedUrl: "https://example.com/page2",
        affectedParameter: "q",
      },
    ];

    const deduped = Deduplicator.deduplicate(rawFindings);
    expect(deduped.length).toBe(2);
  });

  test("same location with different parameters remain separate", () => {
    const rawFindings: RawFinding[] = [
      {
        detectorId: "A-01",
        name: "XSS Param Q",
        description: "XSS",
        remediation: "Fix",
        severity: "HIGH",
        confidence: "FIRM",
        affectedUrl: "https://example.com/search",
        affectedParameter: "q",
      },
      {
        detectorId: "A-01",
        name: "XSS Param Sort",
        description: "XSS",
        remediation: "Fix",
        severity: "HIGH",
        confidence: "FIRM",
        affectedUrl: "https://example.com/search",
        affectedParameter: "sort",
      },
    ];

    const deduped = Deduplicator.deduplicate(rawFindings);
    expect(deduped.length).toBe(2);
  });

  test("generates deterministic 64-character hex SHA-256 fingerprints", () => {
    const finding1 = {
      detectorId: "P-01",
      affectedUrl: "https://example.com/login",
      affectedParameter: null,
    };
    const fp1 = Deduplicator.generateFingerprint(finding1);
    const fp2 = Deduplicator.generateFingerprint(finding1);

    expect(fp1).toBe(fp2);
    expect(fp1.length).toBe(64);
    expect(/^[a-f0-9]{64}$/.test(fp1)).toBe(true);
  });

  test("performance test: deduplicates 10,000 mock findings in under 500ms", () => {
    const detectors = ["A-01", "A-02", "P-01", "P-02", "P-03"];
    const severities: ("CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO")[] = [
      "CRITICAL",
      "HIGH",
      "MEDIUM",
      "LOW",
      "INFO",
    ];

    const mockFindings: RawFinding[] = [];
    for (let i = 0; i < 10000; i++) {
      const det = detectors[i % detectors.length];
      const pageIndex = i % 50; // 50 distinct URLs
      const paramIndex = i % 5; // 5 distinct parameters per URL
      const sev = severities[i % severities.length];

      mockFindings.push({
        detectorId: det,
        name: `Finding ${i}`,
        description: `Description ${i}`,
        remediation: `Remediation ${i}`,
        severity: sev,
        confidence: "FIRM",
        affectedUrl: `https://example.com/page${pageIndex}`,
        affectedParameter: `param${paramIndex}`,
      });
    }

    const start = Date.now();
    const deduped = Deduplicator.deduplicate(mockFindings);
    const durationMs = Date.now() - start;

    console.log(`Deduplicated 10,000 findings into ${deduped.length} groups in ${durationMs}ms`);

    expect(deduped.length).toBeLessThan(10000);
    expect(durationMs).toBeLessThan(500);
  });
});
