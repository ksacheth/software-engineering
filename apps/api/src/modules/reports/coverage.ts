import {
  deriveScanWarnings,
  type FindingSeverity,
  type ScanProfile,
  type ScanWarningSource,
  type TriageState,
} from "@wvs/shared";

/**
 * F.7: the coverage limitations statement every report carries.
 *
 * The SRS makes this mandatory, and its first line is fixed: an unauthenticated
 * scan is not a complete assessment, whatever else is true. The rest says what
 * this particular scan could not see, and is built from the same scan warnings
 * the dashboard shows, so a report cannot be more optimistic than the live view
 * was.
 */

export const UNAUTHENTICATED_LIMITATION =
  "This was an unauthenticated scan. Anything behind a sign-in was not tested, " +
  "so this report is not a complete security assessment.";

export const AUTOMATION_LIMITATION =
  "Automated scanning cannot find every vulnerability. A finding that is not " +
  "listed has not been shown to be absent.";

export interface EvidenceCounts {
  /** Evidence not confirmed redacted, withheld under ADR-0010. */
  unredacted: number;
  /** Evidence withheld because the report's author may not read it. */
  role: number;
  purged: number;
}

export interface CoverageFacts extends ScanWarningSource {
  profile: ScanProfile;
  includedPaths: string[];
  excludedPaths: string[];
  /** Pages the crawler saw blocked or could only partly read. */
  reducedConfidencePages: number;
  /** Detectors that recorded at least one execution error. */
  failedDetectorIds: string[];
  detectorVersionsRecorded: boolean;
  filters: { minSeverity: FindingSeverity | null; triageStates: TriageState[] };
  /** Technical reports only; the executive summary carries no evidence. */
  evidence?: EvidenceCounts;
}

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

function scopeLimitations(facts: CoverageFacts): string[] {
  const lines: string[] = [];
  if (facts.includedPaths.length > 0) {
    lines.push(
      `Only these paths were in scope: ${facts.includedPaths.join(", ")}.`,
    );
  }
  if (facts.excludedPaths.length > 0) {
    lines.push(
      `These paths were excluded from scope and not tested: ${facts.excludedPaths.join(", ")}.`,
    );
  }
  return lines;
}

function scanLimitations(facts: CoverageFacts): string[] {
  const lines: string[] = [];
  if (facts.profile === "PASSIVE") {
    lines.push(
      "The Passive profile sends no test payloads, so injection-class " +
        "vulnerabilities were not tested.",
    );
  }
  for (const warning of deriveScanWarnings(facts)) {
    lines.push(warning.message);
  }
  if (facts.reducedConfidencePages > 0) {
    lines.push(
      `${plural(facts.reducedConfidencePages, "page was", "pages were")} blocked ` +
        "or only partly read, so findings on them carry reduced confidence.",
    );
  }
  if (facts.failedDetectorIds.length > 0) {
    lines.push(
      `${plural(facts.failedDetectorIds.length, "detector", "detectors")} ` +
        `reported execution errors and may not have completed their checks: ` +
        `${facts.failedDetectorIds.join(", ")}.`,
    );
  }
  if (!facts.detectorVersionsRecorded) {
    lines.push("The scan engine did not record which detector versions ran.");
  }
  return lines;
}

function filterLimitations(facts: CoverageFacts): string[] {
  const lines: string[] = [];
  if (facts.filters.minSeverity && facts.filters.minSeverity !== "INFO") {
    lines.push(
      `This report lists only findings of ${facts.filters.minSeverity} severity or higher.`,
    );
  }
  if (facts.filters.triageStates.length > 0) {
    lines.push(
      `This report lists only findings triaged as ${facts.filters.triageStates.join(", ")}.`,
    );
  }
  return lines;
}

function evidenceLimitations(evidence: EvidenceCounts | undefined): string[] {
  if (!evidence) return [];
  const lines: string[] = [];
  if (evidence.unredacted > 0) {
    lines.push(
      `Evidence for ${plural(evidence.unredacted, "finding is", "findings is")} ` +
        "withheld because its redaction has not been confirmed.",
    );
  }
  if (evidence.role > 0) {
    lines.push(
      `Evidence for ${plural(evidence.role, "finding is", "findings is")} ` +
        "withheld because the report's author is not permitted to read raw evidence.",
    );
  }
  if (evidence.purged > 0) {
    lines.push(
      `Evidence for ${plural(evidence.purged, "finding has", "findings have")} ` +
        "been purged under the retention policy.",
    );
  }
  return lines;
}

export function coverageLimitations(facts: CoverageFacts): string[] {
  return [
    UNAUTHENTICATED_LIMITATION,
    AUTOMATION_LIMITATION,
    ...scopeLimitations(facts),
    ...scanLimitations(facts),
    ...filterLimitations(facts),
    ...evidenceLimitations(facts.evidence),
  ];
}
