// @ts-ignore
import { createHash } from "crypto";
import type { RawFinding } from "../detectors/mock-detector.js";

export interface DeduplicatedFinding extends RawFinding {
  fingerprint: string;
  occurrenceCount: number;
  occurrences: Array<{
    affectedUrl: string;
    affectedParameter?: string | null;
    timestamp: string;
  }>;
}

const SEVERITY_RANK: Record<string, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
  INFO: 0,
};

export class Deduplicator {
  /**
   * Generates a deterministic SHA-256 fingerprint for a finding based on detectorId + affectedUrl + affectedParameter.
   */
  static generateFingerprint(finding: {
    detectorId: string;
    affectedUrl: string;
    affectedParameter?: string | null;
  }): string {
    const param = finding.affectedParameter ? finding.affectedParameter.trim() : "global";
    const rawKey = `${finding.detectorId.trim()}|${finding.affectedUrl.trim()}|${param}`;
    return createHash("sha256").update(rawKey).digest("hex");
  }

  /**
   * Deduplicates identical findings by fingerprint, collapsing duplicate vulnerability warnings.
   */
  static deduplicate(findings: RawFinding[]): DeduplicatedFinding[] {
    if (!findings || findings.length === 0) {
      return [];
    }

    const groups = new Map<string, RawFinding[]>();

    for (const finding of findings) {
      const fp = this.generateFingerprint(finding);
      let list = groups.get(fp);
      if (!list) {
        list = [];
        groups.set(fp, list);
      }
      list.push(finding);
    }

    const result: DeduplicatedFinding[] = [];
    const now = new Date().toISOString();

    for (const [fingerprint, group] of groups.entries()) {
      // Sort by severity descending so the highest severity is kept as master
      group.sort((a, b) => {
        const rankA = SEVERITY_RANK[a.severity] ?? 0;
        const rankB = SEVERITY_RANK[b.severity] ?? 0;
        return rankB - rankA;
      });

      const master = group[0];
      const occurrences = group.map((f) => ({
        affectedUrl: f.affectedUrl,
        affectedParameter: f.affectedParameter || null,
        timestamp: now,
      }));

      result.push({
        ...master,
        fingerprint,
        occurrenceCount: group.length,
        occurrences,
      });
    }

    return result;
  }
}
