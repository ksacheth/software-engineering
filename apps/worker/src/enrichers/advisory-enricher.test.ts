// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { OSVClient } from "./osv-client.js";
import { EPSSClient } from "./epss-client.js";
import { AdvisoryEnricher } from "./advisory-enricher.js";
import type { RawFinding } from "../detectors/mock-detector.js";

// The tests below stub fetch; bun runs every test file in one process, so put it back.
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OSVClient & EPSSClient", () => {
  test("OSVClient handles empty / no vulnerability response gracefully", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ vulns: [] }), { status: 200 });
    globalThis.fetch = mockFetch as any;

    const client = new OSVClient("https://mock-osv.dev");
    const result = await client.queryPackage("safe-lib", "1.0.0");
    expect(result).toEqual([]);
  });

  test("OSVClient parses vulnerabilities correctly", async () => {
    const mockVulns = [
      {
        id: "GHSA-1234",
        summary: "Vulnerability in lib",
        aliases: ["CVE-2023-9999"],
        severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      },
    ];
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ vulns: mockVulns }), { status: 200 })) as any;

    const client = new OSVClient("https://mock-osv.dev");
    const result = await client.queryPackage("vuln-lib", "1.0.0");
    expect(result.length).toBe(1);
    expect(result[0].id).toBe("GHSA-1234");
    expect(result[0].aliases).toContain("CVE-2023-9999");
  });

  test("EPSSClient parses EPSS score and percentile correctly", async () => {
    const mockEpss = {
      status: "OK",
      data: [
        {
          cve: "CVE-2023-9999",
          epss: "0.85430",
          percentile: "0.97210",
          date: "2026-09-01",
        },
      ],
    };
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(mockEpss), { status: 200 })) as any;

    const epssClient = new EPSSClient("https://mock-epss.org");
    const result = await epssClient.getScore("CVE-2023-9999");
    expect(result).not.toBeNull();
    expect(result?.epss).toBe(0.8543);
    expect(result?.percentile).toBe(0.9721);
  });

  test("EPSSClient handles network failure without throwing", async () => {
    globalThis.fetch = (async () => {
      throw new Error("Network offline");
    }) as any;

    const epssClient = new EPSSClient("https://mock-epss.org");
    const result = await epssClient.getScore("CVE-2023-9999");
    expect(result).toBeNull();
  });
});

describe("AdvisoryEnricher", () => {
  test("enriches finding with CVE, CVSS vector, and EPSS scores", async () => {
    const mockOsv = {
      queryPackage: async () => [
        {
          id: "GHSA-abcd-1234",
          summary: "Prototype Pollution",
          aliases: ["CVE-2023-1111"],
          severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N" }],
        },
      ],
    };

    const mockEpss = {
      getScore: async (cve: string) => ({
        cve,
        epss: 0.952,
        percentile: 0.991,
      }),
    };

    const enricher = new AdvisoryEnricher(mockOsv as any, mockEpss as any);

    const finding: RawFinding = {
      detectorId: "P-18",
      name: "Vulnerable Library",
      description: "Outdated lodash dependency",
      remediation: "Upgrade lodash",
      severity: "HIGH",
      confidence: "CONFIRMED",
      affectedUrl: "https://example.com/package.json",
      affectedParameter: null,
      evidence: { component: "lodash@4.17.19" } as any,
    };

    const enriched = await enricher.enrichFinding(finding);
    expect(enriched.cveId).toBe("CVE-2023-1111");
    expect(enriched.epssScore).toBe(0.952);
    expect(enriched.epssPercentile).toBe(0.991);
    expect(enriched.cvssVector).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N");
    expect(enriched.cvssScore).toBe(7.5);
    expect(enriched.advisoryData).toBeDefined();
  });

  test("scores the v3 vector when OSV lists a v4 one first", async () => {
    const mockOsv = {
      queryPackage: async () => [
        {
          id: "GHSA-v4v3",
          aliases: ["CVE-2023-2222"],
          severity: [
            { type: "CVSS_V4", score: "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N" },
            { type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N" },
          ],
        },
      ],
    };
    const enricher = new AdvisoryEnricher(mockOsv as any, { getScore: async () => null } as any);

    const finding: RawFinding = {
      detectorId: "P-18",
      name: "Technology and component fingerprinting",
      description: "jQuery 1.12.4",
      remediation: "Upgrade",
      severity: "INFO",
      confidence: "FIRM",
      affectedUrl: "https://example.com/",
      evidence: { component: "jquery@1.12.4" } as any,
    };
    const enriched = await enricher.enrichFinding(finding);

    expect(enriched.cvssVector).toBe("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N");
    expect(enriched.cvssScore).toBe(6.1);
  });

  test("keeps the vector but no score when only a v4 vector is given", async () => {
    const v4 = "CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N";
    const mockOsv = {
      queryPackage: async () => [
        { id: "GHSA-v4only", aliases: ["CVE-2024-3333"], severity: [{ type: "CVSS_V4", score: v4 }] },
      ],
    };
    const enricher = new AdvisoryEnricher(mockOsv as any, { getScore: async () => null } as any);

    const finding: RawFinding = {
      detectorId: "P-18",
      name: "Technology and component fingerprinting",
      description: "lodash 4.17.19",
      remediation: "Upgrade",
      severity: "INFO",
      confidence: "FIRM",
      affectedUrl: "https://example.com/",
      evidence: { component: "lodash@4.17.19" } as any,
    };
    const enriched = await enricher.enrichFinding(finding);

    expect(enriched.cvssVector).toBe(v4);
    expect(enriched.cvssScore).toBeUndefined();
  });

  test("looks up scoped npm packages by their full name", async () => {
    const queried: string[] = [];
    const mockOsv = {
      queryPackage: async (pkg: string, ver: string) => {
        queried.push(`${pkg} ${ver}`);
        return [];
      },
    };
    const enricher = new AdvisoryEnricher(mockOsv as any, { getScore: async () => null } as any);

    await enricher.enrichFinding({
      detectorId: "P-18",
      name: "Vulnerable Library",
      description: "Outdated dependency",
      remediation: "Upgrade",
      severity: "HIGH",
      confidence: "CONFIRMED",
      affectedUrl: "https://example.com/package.json",
      evidence: { component: "@babel/core@7.0.0" } as any,
    });

    expect(queried).toEqual(["@babel/core 7.0.0"]);
  });

  test("handles finding without vulnerability gracefully without mutation", async () => {
    const mockOsv = { queryPackage: async () => [] };
    const mockEpss = { getScore: async () => null };

    const enricher = new AdvisoryEnricher(mockOsv as any, mockEpss as any);
    const finding: RawFinding = {
      detectorId: "A-01",
      name: "XSS",
      description: "XSS",
      remediation: "Fix",
      severity: "MEDIUM",
      confidence: "FIRM",
      affectedUrl: "https://example.com/search",
    };

    const enriched = await enricher.enrichFinding(finding);
    expect(enriched.cveId).toBeUndefined();
    expect(enriched.epssScore).toBeUndefined();
    expect(enriched.severity).toBe("MEDIUM");
  });
});
