import type { FindingSeverity } from "@wvs/shared";
import {
  REPORT_GENERATOR,
  SEVERITIES_DESCENDING,
  type ReportDocument,
  type ReportFinding,
} from "../report-document";
import { headerLines, locationText, scopeLines, TEMPLATE_TITLES } from "./labels";

/**
 * SARIF v2.1.0 export, shaped for GitHub code scanning without transformation
 * (F.7).
 *
 * What GitHub reads, and where it comes from:
 * - `rules[].properties["security-severity"]` sets the alert severity. It is
 *   the highest CVSS score among the rule's results when there is one, and a
 *   fixed score per WVS severity otherwise.
 * - `partialFingerprints` keeps one alert per finding across uploads. The WVS
 *   fingerprint is already the cross-scan identity, so it is used as is.
 * - `automationDetails.id` is `wvs/<host>/<scan>`; GitHub takes everything up
 *   to the last slash as the category, so each target keeps its own alerts.
 *
 * A DAST finding has a URL, not a file, so the location is the URL. GitHub
 * accepts it and shows the alert without a source link.
 */

const SARIF_SCHEMA = "https://json.schemastore.org/sarif-2.1.0.json";

type SarifLevel = "error" | "warning" | "note";

const LEVELS: Record<FindingSeverity, SarifLevel> = {
  CRITICAL: "error",
  HIGH: "error",
  MEDIUM: "warning",
  LOW: "note",
  INFO: "note",
};

/** GitHub's bands: 9.0+ critical, 7.0+ high, 4.0+ medium, above 0 low. */
const SECURITY_SEVERITY: Record<FindingSeverity, number> = {
  CRITICAL: 9.5,
  HIGH: 8.0,
  MEDIUM: 5.5,
  LOW: 3.0,
  INFO: 0.0,
};

const PRECISION = { CONFIRMED: "very-high", FIRM: "high", TENTATIVE: "medium" } as const;

function cweTag(cwe: string | null): string | null {
  const match = cwe ? /(\d+)/.exec(cwe) : null;
  return match ? `external/cwe/cwe-${match[1]}` : null;
}

function mostSevere(findings: ReportFinding[]): ReportFinding {
  return findings.reduce((worst, finding) =>
    SEVERITIES_DESCENDING.indexOf(finding.severity) <
    SEVERITIES_DESCENDING.indexOf(worst.severity)
      ? finding
      : worst,
  );
}

function securitySeverity(findings: ReportFinding[]): string {
  const scores = findings.flatMap((f) => (f.cvssScore === null ? [] : [f.cvssScore]));
  const score =
    scores.length > 0 ? Math.max(...scores) : SECURITY_SEVERITY[mostSevere(findings).severity];
  return score.toFixed(1);
}

function buildRule(detectorId: string, findings: ReportFinding[]) {
  const sample = mostSevere(findings);
  const tags = [
    "security",
    ...new Set(findings.flatMap((f) => [cweTag(f.cwe)].filter(Boolean) as string[])),
  ];
  return {
    id: detectorId,
    name: sample.name,
    shortDescription: { text: sample.name },
    fullDescription: { text: sample.description },
    help: { text: sample.remediation, markdown: sample.remediation },
    defaultConfiguration: { level: LEVELS[sample.severity] },
    properties: {
      tags,
      precision: PRECISION[sample.confidence],
      "security-severity": securitySeverity(findings),
      ...(sample.owaspCategory ? { owaspCategory: sample.owaspCategory } : {}),
    },
  };
}

function headerObject(headers: unknown): Record<string, string> {
  return Object.fromEntries(
    headerLines(headers).map((line) => {
      const colon = line.indexOf(":");
      return colon === -1
        ? [line, ""]
        : [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }),
  );
}

/** SARIF's own web request/response objects, for evidence that may be shown. */
function webEvidence(finding: ReportFinding) {
  const evidence = finding.evidence;
  if (evidence?.status !== "AVAILABLE") {
    return evidence ? { properties: { evidenceStatus: evidence.status } } : {};
  }
  return {
    webRequest: {
      target: finding.affectedUrl,
      headers: headerObject(evidence.requestHeaders),
      ...(evidence.requestBody !== null ? { body: { text: evidence.requestBody } } : {}),
    },
    webResponse: {
      headers: headerObject(evidence.responseHeaders),
      ...(evidence.responseBody !== null ? { body: { text: evidence.responseBody } } : {}),
    },
    properties: {
      evidenceStatus: evidence.status,
      curlCommand: evidence.curlCommand,
      extractedSnippet: evidence.extractedSnippet,
    },
  };
}

function buildResult(finding: ReportFinding, ruleIndex: number) {
  const evidence = webEvidence(finding);
  return {
    ruleId: finding.detectorId,
    ruleIndex,
    level: LEVELS[finding.severity],
    message: { text: `${finding.name} at ${locationText(finding)}` },
    locations: [
      {
        physicalLocation: { artifactLocation: { uri: finding.affectedUrl } },
        ...(finding.affectedParameter
          ? { message: { text: `Parameter: ${finding.affectedParameter}` } }
          : {}),
      },
    ],
    partialFingerprints: { "wvsFingerprint/v1": finding.fingerprint },
    ...("webRequest" in evidence
      ? { webRequest: evidence.webRequest, webResponse: evidence.webResponse }
      : {}),
    properties: {
      severity: finding.severity,
      confidence: finding.confidence,
      triageState: finding.triage.state,
      diffStatus: finding.diffStatus,
      occurrenceCount: finding.occurrenceCount,
      cvssScore: finding.cvssScore,
      cvssVector: finding.cvssVector,
      cveId: finding.cveId,
      epssScore: finding.epssScore,
      ...evidence.properties,
    },
  };
}

function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

export function renderSarif(doc: ReportDocument): Buffer {
  const byDetector = new Map<string, ReportFinding[]>();
  for (const finding of doc.findings) {
    const list = byDetector.get(finding.detectorId) ?? [];
    list.push(finding);
    byDetector.set(finding.detectorId, list);
  }
  const detectorIds = [...byDetector.keys()].sort();
  const ruleIndex = new Map(detectorIds.map((id, index) => [id, index]));

  const sarif = {
    $schema: SARIF_SCHEMA,
    version: "2.1.0",
    runs: [
      {
        tool: {
          driver: {
            name: REPORT_GENERATOR.name,
            fullName: REPORT_GENERATOR.fullName,
            version: REPORT_GENERATOR.version,
            semanticVersion: REPORT_GENERATOR.version,
            informationUri: REPORT_GENERATOR.informationUri,
            rules: detectorIds.map((id) => buildRule(id, byDetector.get(id)!)),
          },
        },
        automationDetails: {
          id: `wvs/${hostOf(doc.target.origin)}/${doc.scan.id}`,
        },
        invocations: [
          {
            executionSuccessful: true,
            ...(doc.scan.startedAt ? { startTimeUtc: doc.scan.startedAt.toISOString() } : {}),
            ...(doc.scan.completedAt ? { endTimeUtc: doc.scan.completedAt.toISOString() } : {}),
            // The mandatory limitations statement, where SARIF viewers look
            // for what a run could not do.
            toolExecutionNotifications: doc.coverageLimitations.map((text) => ({
              level: "note",
              message: { text },
            })),
          },
        ],
        results: doc.findings.map((finding) =>
          buildResult(finding, ruleIndex.get(finding.detectorId)!),
        ),
        properties: {
          report: {
            id: doc.report.id,
            template: TEMPLATE_TITLES[doc.report.template],
            generatedAt: doc.report.generatedAt.toISOString(),
            filters: doc.report.filters,
          },
          target: doc.target,
          scan: {
            id: doc.scan.id,
            profile: doc.scan.profile,
            queuedAt: doc.scan.queuedAt.toISOString(),
            startedAt: doc.scan.startedAt?.toISOString() ?? null,
            completedAt: doc.scan.completedAt?.toISOString() ?? null,
            scope: Object.fromEntries(scopeLines(doc)),
            detectorVersions: doc.scan.detectorVersions,
          },
          coverageLimitations: doc.coverageLimitations,
        },
      },
    ],
  };
  return Buffer.from(`${JSON.stringify(sarif, null, 2)}\n`, "utf8");
}
