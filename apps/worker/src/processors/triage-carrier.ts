export type TriageState = "OPEN" | "CONFIRMED" | "FALSE_POSITIVE" | "ACCEPTED_RISK" | "RESOLVED";
export type ComparisonStatus = "NEW" | "PERSISTING" | "RESOLVED";

export interface TriageProcessedFinding {
  fingerprint: string;
  triageState: TriageState;
  comparisonStatus: ComparisonStatus;
}

export interface TargetFindingTriageRecord {
  targetId: string;
  findingFingerprint: string;
  state: TriageState;
}

export interface ScanFindingDiffRecord {
  scanJobId: string;
  targetId: string;
  fingerprint: string;
  status: ComparisonStatus;
}

export class TriageCarrier {
  /**
   * Processes new scan findings against target's triage history and previous scan findings.
   * Carries forward prior triage decisions (OPEN, CONFIRMED, FALSE_POSITIVE, ACCEPTED_RISK, RESOLVED)
   * and calculates diffs (NEW, PERSISTING, RESOLVED).
   */
  static processScanTriage(
    targetId: string,
    currentScanJobId: string,
    newFingerprints: string[],
    priorTriageRecords: TargetFindingTriageRecord[],
    previousScanFingerprints: string[] = []
  ): {
    findingsWithTriage: TriageProcessedFinding[];
    diffRecords: ScanFindingDiffRecord[];
  } {
    const triageMap = new Map<string, TriageState>();
    for (const record of priorTriageRecords) {
      if (record.targetId === targetId) {
        triageMap.set(record.findingFingerprint, record.state);
      }
    }

    const previousSet = new Set(previousScanFingerprints);
    const currentSet = new Set(newFingerprints);

    const findingsWithTriage: TriageProcessedFinding[] = [];
    const diffRecords: ScanFindingDiffRecord[] = [];

    // 1. Process active findings in current scan
    for (const fingerprint of newFingerprints) {
      const carriedState = triageMap.get(fingerprint) || "OPEN";
      const isPersisting = previousSet.has(fingerprint);
      const comparisonStatus: ComparisonStatus = isPersisting ? "PERSISTING" : "NEW";

      findingsWithTriage.push({
        fingerprint,
        triageState: carriedState,
        comparisonStatus,
      });

      diffRecords.push({
        scanJobId: currentScanJobId,
        targetId,
        fingerprint,
        status: comparisonStatus,
      });
    }

    // 2. Process findings present in previous scan but absent in current scan (RESOLVED machine diff)
    for (const prevFp of previousScanFingerprints) {
      if (!currentSet.has(prevFp)) {
        diffRecords.push({
          scanJobId: currentScanJobId,
          targetId,
          fingerprint: prevFp,
          status: "RESOLVED",
        });
      }
    }

    return {
      findingsWithTriage,
      diffRecords,
    };
  }
}
