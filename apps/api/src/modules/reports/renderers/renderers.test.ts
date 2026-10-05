import { describe, expect, test } from "bun:test";
import {
  emptySeverityCounts,
  readDetectorVersions,
  severitiesAtOrAbove,
  type ReportDocument,
  type ReportFinding,
} from "../report-document";
import {
  AUTOMATION_LIMITATION,
  coverageLimitations,
  UNAUTHENTICATED_LIMITATION,
  type CoverageFacts,
} from "../coverage";
import { csvCell, renderCsv } from "./csv";
import { renderHtml } from "./html";
import { renderJson } from "./json";
import { pdfSafe, renderPdf } from "./pdf";
import { renderSarif } from "./sarif";

/**
 * F.7 renderers, as pure functions of a report document. The database side
 * of report generation is covered by reports.test.ts.
 */

const HOSTILE = `<script>alert(1)</script>`;

function finding(overrides: Partial<ReportFinding> = {}): ReportFinding {
  return {
    id: "f1",
    fingerprint: "fp-1",
    detectorId: "A-03",
    name: "Reflected cross-site scripting",
    severity: "HIGH",
    confidence: "FIRM",
    cwe: "CWE-79",
    owaspCategory: "A03:2021",
    affectedUrl: "https://app.example.test/search",
    affectedParameter: "q",
    cvssScore: 7.4,
    cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N",
    cveId: null,
    epssScore: null,
    epssPercentile: null,
    occurrenceCount: 2,
    diffStatus: "NEW",
    triage: { state: "OPEN", justification: null },
    description: "User input is reflected without encoding.",
    remediation: "Encode output for its context.",
    ...overrides,
  };
}

function document(overrides: Partial<ReportDocument> = {}): ReportDocument {
  const findings = overrides.findings ?? [
    finding(),
    finding({
      id: "f2",
      fingerprint: "fp-2",
      detectorId: "P-01",
      name: "Missing Content-Security-Policy",
      severity: "MEDIUM",
      confidence: "CONFIRMED",
      cwe: "CWE-693",
      affectedParameter: null,
      cvssScore: null,
      triage: { state: "ACCEPTED_RISK", justification: "Legacy page" },
    }),
  ];
  const bySeverity = emptySeverityCounts();
  for (const f of findings) bySeverity[f.severity] += 1;
  return {
    report: {
      id: "r1",
      template: "EXECUTIVE_SUMMARY",
      format: "PDF",
      generatedAt: new Date("2026-10-05T10:00:00Z"),
      filters: { minSeverity: null, triageStates: [] },
    },
    target: { id: "t1", label: "Shop", origin: "https://app.example.test" },
    scan: {
      id: "scan-123456789",
      profile: "STANDARD",
      queuedAt: new Date("2026-10-04T09:00:00Z"),
      startedAt: new Date("2026-10-04T09:01:00Z"),
      completedAt: new Date("2026-10-04T09:13:00Z"),
      pagesCrawled: 120,
      requestsMade: 900,
      scope: {
        includedPaths: [],
        excludedPaths: ["/admin"],
        maxDepth: 5,
        maxPages: 200,
        maxRequests: 2000,
        rateLimit: 10,
        concurrency: 5,
      },
      detectorVersions: [{ detectorId: "A-03", version: "1.2.0" }],
    },
    coverageLimitations: [UNAUTHENTICATED_LIMITATION, AUTOMATION_LIMITATION],
    summary: {
      total: findings.length,
      bySeverity,
      actionable: 1,
      highestActionable: "HIGH",
      diff: { NEW: 1, PERSISTING: 1, RESOLVED: 0 },
    },
    trend: [
      {
        scanId: "scan-123456789",
        completedAt: new Date("2026-10-04T09:13:00Z"),
        total: findings.length,
        bySeverity,
      },
    ],
    findings,
    ...overrides,
  };
}

function technical(findings: ReportFinding[]): ReportDocument {
  const doc = document({ findings });
  return { ...doc, report: { ...doc.report, template: "TECHNICAL_REPORT" } };
}

const AVAILABLE_EVIDENCE = {
  status: "AVAILABLE" as const,
  expiresAt: new Date("2027-01-01T00:00:00Z"),
  redactionVersion: 1,
  requestHeaders: { Host: "app.example.test", Cookie: "session=[REDACTED]" },
  requestBody: null,
  responseHeaders: { "Content-Type": "text/html" },
  responseBody: `<p>${HOSTILE}</p>`,
  curlCommand: "curl 'https://app.example.test/search?q=x'",
  extractedSnippet: HOSTILE,
};

// ---------------------------------------------------------------- coverage ---

function facts(overrides: Partial<CoverageFacts> = {}): CoverageFacts {
  return {
    profile: "STANDARD",
    includedPaths: [],
    excludedPaths: [],
    degradations: [],
    blockingDetected: false,
    bindingLimit: null,
    reducedConfidencePages: 0,
    failedDetectorIds: [],
    detectorVersionsRecorded: true,
    filters: { minSeverity: null, triageStates: [] },
    ...overrides,
  };
}

describe("coverage limitations", () => {
  test("always open with the unauthenticated statement", () => {
    expect(coverageLimitations(facts())).toEqual([
      UNAUTHENTICATED_LIMITATION,
      AUTOMATION_LIMITATION,
    ]);
  });

  test("name everything the scan could not see", () => {
    const lines = coverageLimitations(
      facts({
        profile: "PASSIVE",
        excludedPaths: ["/admin"],
        blockingDetected: true,
        bindingLimit: "PAGE_CEILING_REACHED",
        reducedConfidencePages: 3,
        failedDetectorIds: ["A-01", "A-07"],
        detectorVersionsRecorded: false,
        filters: { minSeverity: "HIGH", triageStates: ["OPEN"] },
        evidence: { unredacted: 1, role: 0, purged: 2 },
      }),
    ).join("\n");
    expect(lines).toContain("Passive profile");
    expect(lines).toContain("/admin");
    expect(lines).toContain("block the scan");
    expect(lines).toContain("page ceiling");
    expect(lines).toContain("3 pages were blocked");
    expect(lines).toContain("A-01, A-07");
    expect(lines).toContain("did not record which detector versions");
    expect(lines).toContain("HIGH severity or higher");
    expect(lines).toContain("triaged as OPEN");
    expect(lines).toContain("1 finding is withheld");
    expect(lines).toContain("2 findings have been purged");
  });

  test("an INFO threshold is no filter at all", () => {
    expect(
      coverageLimitations(facts({ filters: { minSeverity: "INFO", triageStates: [] } })),
    ).toHaveLength(2);
  });
});

describe("document helpers", () => {
  test("severity threshold keeps the threshold and above", () => {
    expect(severitiesAtOrAbove("HIGH")).toEqual(["HIGH", "CRITICAL"]);
    expect(severitiesAtOrAbove(null)).toHaveLength(5);
  });

  test("detector versions accept a map or a list and nothing else", () => {
    expect(readDetectorVersions({ "P-01": "1.0.0", "A-03": 2 })).toEqual([
      { detectorId: "P-01", version: "1.0.0" },
      { detectorId: "A-03", version: "2" },
    ]);
    expect(readDetectorVersions([{ id: "P-02", version: "0.9" }])).toEqual([
      { detectorId: "P-02", version: "0.9" },
    ]);
    expect(readDetectorVersions(null)).toEqual([]);
    expect(readDetectorVersions("1.0")).toEqual([]);
  });
});

// --------------------------------------------------------------------- csv ---

describe("CSV", () => {
  test("defuses cells a spreadsheet would evaluate", () => {
    expect(csvCell("=HYPERLINK(\"x\")")).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell("+1")).toBe("'+1");
    expect(csvCell("@SUM(A1)")).toBe("'@SUM(A1)");
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(7.4)).toBe("7.4");
    expect(csvCell(null)).toBe("");
  });

  test("carries the metadata and limitations before the findings", () => {
    const text = renderCsv(document()).toString("utf8");
    expect(text.startsWith("﻿Report,")).toBe(true);
    expect(text).toContain(`Coverage limitation,"This was an unauthenticated scan.`);
    expect(text).toContain("Detector versions,A-03 1.2.0");
    expect(text).toContain("Excluded paths,/admin");
    expect(text).toContain("\r\nSeverity,Name,Location");
  });

  test("the executive summary has no evidence columns", () => {
    const text = renderCsv(document()).toString("utf8");
    expect(text).not.toContain("Curl command");
  });

  test("the technical report carries evidence it may show", () => {
    const text = renderCsv(technical([finding({ evidence: AVAILABLE_EVIDENCE })])).toString("utf8");
    expect(text).toContain("Curl command");
    expect(text).toContain("curl 'https://app.example.test/search?q=x'");
  });
});

// ------------------------------------------------------------------- sarif ---

describe("SARIF", () => {
  const sarif = () => JSON.parse(renderSarif(document()).toString("utf8"));

  test("is a SARIF 2.1.0 log GitHub code scanning reads", () => {
    const log = sarif();
    expect(log.version).toBe("2.1.0");
    expect(log.$schema).toContain("sarif-2.1.0");
    const run = log.runs[0];
    expect(run.tool.driver.name).toBe("WVS");
    expect(run.automationDetails.id).toBe("wvs/app.example.test/scan-123456789");
    for (const result of run.results) {
      expect(result.message.text.length).toBeGreaterThan(0);
      expect(result.locations[0].physicalLocation.artifactLocation.uri).toStartWith("https://");
      expect(result.partialFingerprints["wvsFingerprint/v1"]).toBeString();
      expect(run.tool.driver.rules[result.ruleIndex].id).toBe(result.ruleId);
    }
  });

  test("maps severity onto levels and GitHub security-severity", () => {
    const run = sarif().runs[0];
    const xss = run.tool.driver.rules.find((r: { id: string }) => r.id === "A-03");
    const csp = run.tool.driver.rules.find((r: { id: string }) => r.id === "P-01");
    expect(xss.properties["security-severity"]).toBe("7.4"); // the CVSS score
    expect(xss.properties.tags).toContain("external/cwe/cwe-79");
    expect(csp.properties["security-severity"]).toBe("5.5"); // MEDIUM, no CVSS
    const levels = run.results.map((r: { level: string }) => r.level);
    expect(levels).toEqual(["error", "warning"]);
  });

  test("states the limitations and metadata in the run", () => {
    const run = sarif().runs[0];
    const notes = run.invocations[0].toolExecutionNotifications.map(
      (n: { message: { text: string } }) => n.message.text,
    );
    expect(notes[0]).toBe(UNAUTHENTICATED_LIMITATION);
    expect(run.invocations[0].startTimeUtc).toBe("2026-10-04T09:01:00.000Z");
    expect(run.properties.scan.profile).toBe("STANDARD");
    expect(run.properties.scan.detectorVersions).toHaveLength(1);
  });

  test("uses SARIF web request objects for technical evidence", () => {
    const log = JSON.parse(
      renderSarif(technical([finding({ evidence: AVAILABLE_EVIDENCE })])).toString("utf8"),
    );
    const result = log.runs[0].results[0];
    expect(result.webRequest.headers.Cookie).toBe("session=[REDACTED]");
    expect(result.webResponse.body.text).toContain("<script>");
  });
});

// -------------------------------------------------------------------- html ---

describe("HTML", () => {
  test("escapes target-controlled text and runs no script", () => {
    const html = renderHtml(
      technical([finding({ name: HOSTILE, evidence: AVAILABLE_EVIDENCE })]),
    ).toString("utf8");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("default-src 'none'");
  });

  test("shows severity by label and shape, not colour alone", () => {
    const html = renderHtml(document()).toString("utf8");
    expect(html).toContain("&#9670;</span> High"); // diamond
    expect(html).toContain("&#9632;</span> Medium"); // square
  });

  test("the executive summary carries posture, trend and no evidence", () => {
    const doc = document();
    const html = renderHtml(doc).toString("utf8");
    expect(html).toContain("1 finding needs action; the most severe is high.");
    expect(html).toContain("Trend");
    expect(html).toContain(UNAUTHENTICATED_LIMITATION);
    expect(html).not.toContain("Evidence");
  });
});

// --------------------------------------------------------------------- pdf ---

describe("PDF", () => {
  test("maps text onto what the standard fonts can draw", () => {
    expect(pdfSafe("“quoted” – done…")).toBe(`"quoted" - done...`);
    expect(pdfSafe("日本")).toBe("??");
    expect(pdfSafe("café")).toBe("café");
  });

  test("renders both templates", async () => {
    for (const doc of [document(), technical([finding({ evidence: AVAILABLE_EVIDENCE })])]) {
      const bytes = await renderPdf(doc);
      expect(bytes.subarray(0, 5).toString("latin1")).toBe("%PDF-");
      expect(bytes.length).toBeGreaterThan(1000);
    }
  });

  test("a 500-finding technical report renders well inside 60 seconds", async () => {
    const findings = Array.from({ length: 500 }, (_, i) =>
      finding({
        id: `f${i}`,
        fingerprint: `fp-${i}`,
        severity: (["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"] as const)[i % 5],
        evidence: { ...AVAILABLE_EVIDENCE, responseBody: "x".repeat(16 * 1024) },
      }),
    );
    const started = performance.now();
    const bytes = await renderPdf(technical(findings));
    const elapsed = performance.now() - started;
    expect(bytes.length).toBeGreaterThan(0);
    expect(elapsed).toBeLessThan(60_000);
  }, 60_000);
});

// -------------------------------------------------------------------- json ---

describe("JSON", () => {
  test("is the document with a format version", () => {
    const body = JSON.parse(renderJson(document()).toString("utf8"));
    expect(body.formatVersion).toBe(1);
    expect(body.coverageLimitations[0]).toBe(UNAUTHENTICATED_LIMITATION);
    expect(body.target.origin).toBe("https://app.example.test");
    expect(body.findings).toHaveLength(2);
  });
});
