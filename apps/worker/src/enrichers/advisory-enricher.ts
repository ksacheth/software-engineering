import { OSVClient } from "./osv-client.js";
import { EPSSClient } from "./epss-client.js";
import type { RawFinding } from "../detectors/mock-detector.js";

export class AdvisoryEnricher {
  private osvClient: OSVClient;
  private epssClient: EPSSClient;

  constructor(osvClient = new OSVClient(), epssClient = new EPSSClient()) {
    this.osvClient = osvClient;
    this.epssClient = epssClient;
  }

  async enrichFinding(finding: RawFinding): Promise<RawFinding> {
    const enriched = { ...finding };

    let cveId = enriched.cveId;
    const componentInfo = (finding as any).component || (finding.evidence as any)?.component;

    if (!cveId && componentInfo && typeof componentInfo === "string") {
      const parts = componentInfo.split("@");
      if (parts.length === 2) {
        const [pkg, ver] = parts;
        const vulns = await this.osvClient.queryPackage(pkg, ver);
        if (vulns.length > 0) {
          const primaryVuln = vulns[0];
          cveId = primaryVuln.aliases?.find((a) => a.startsWith("CVE-")) || primaryVuln.id;
          enriched.cveId = cveId;
          enriched.advisoryData = {
            osvId: primaryVuln.id,
            summary: primaryVuln.summary,
            vulns: vulns.map((v) => ({ id: v.id, summary: v.summary })),
          };

          if (primaryVuln.severity && primaryVuln.severity.length > 0) {
            enriched.cvssVector = primaryVuln.severity[0].score;
          }
        }
      }
    }

    if (cveId && cveId.startsWith("CVE-")) {
      const epssData = await this.epssClient.getScore(cveId);
      if (epssData) {
        enriched.epssScore = epssData.epss;
        enriched.epssPercentile = epssData.percentile;
      }
    }

    return enriched;
  }

  async enrichFindings(findings: RawFinding[]): Promise<RawFinding[]> {
    if (!findings || findings.length === 0) return [];
    return Promise.all(findings.map((f) => this.enrichFinding(f)));
  }
}
