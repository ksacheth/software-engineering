// @ts-ignore
import { describe, expect, test } from "bun:test";
import { TriageCarrier, type TargetFindingTriageRecord } from "./triage-carrier.js";

describe("TriageCarrier", () => {
  const targetId = "target-100";
  const scanJobId = "scan-200";

  test("first scan defaults findings to OPEN state and NEW diff status", () => {
    const fingerprints = ["fp-alpha", "fp-beta"];
    const result = TriageCarrier.processScanTriage(targetId, scanJobId, fingerprints, []);

    expect(result.findingsWithTriage.length).toBe(2);
    expect(result.findingsWithTriage[0].triageState).toBe("OPEN");
    expect(result.findingsWithTriage[0].comparisonStatus).toBe("NEW");

    expect(result.diffRecords.length).toBe(2);
    expect(result.diffRecords[0].status).toBe("NEW");
  });

  test("carries forward prior triage decisions for matching fingerprint on same target", () => {
    const priorTriage: TargetFindingTriageRecord[] = [
      { targetId, findingFingerprint: "fp-alpha", state: "FALSE_POSITIVE" },
      { targetId, findingFingerprint: "fp-beta", state: "CONFIRMED" },
      { targetId, findingFingerprint: "fp-gamma", state: "ACCEPTED_RISK" },
    ];

    const fingerprints = ["fp-alpha", "fp-beta", "fp-gamma", "fp-delta"];
    const previousScan = ["fp-alpha", "fp-beta"];

    const result = TriageCarrier.processScanTriage(
      targetId,
      scanJobId,
      fingerprints,
      priorTriage,
      previousScan
    );

    const alpha = result.findingsWithTriage.find((f) => f.fingerprint === "fp-alpha");
    expect(alpha?.triageState).toBe("FALSE_POSITIVE");
    expect(alpha?.comparisonStatus).toBe("PERSISTING");

    const beta = result.findingsWithTriage.find((f) => f.fingerprint === "fp-beta");
    expect(beta?.triageState).toBe("CONFIRMED");
    expect(beta?.comparisonStatus).toBe("PERSISTING");

    const gamma = result.findingsWithTriage.find((f) => f.fingerprint === "fp-gamma");
    expect(gamma?.triageState).toBe("ACCEPTED_RISK");
    expect(gamma?.comparisonStatus).toBe("NEW");

    const delta = result.findingsWithTriage.find((f) => f.fingerprint === "fp-delta");
    expect(delta?.triageState).toBe("OPEN");
    expect(delta?.comparisonStatus).toBe("NEW");
  });

  test("creates RESOLVED diff records for findings present in previous scan but missing in current scan", () => {
    const previousScan = ["fp-existing", "fp-fixed"];
    const currentScan = ["fp-existing", "fp-brand-new"];

    const result = TriageCarrier.processScanTriage(
      targetId,
      scanJobId,
      currentScan,
      [],
      previousScan
    );

    const resolvedDiff = result.diffRecords.find((d) => d.fingerprint === "fp-fixed");
    expect(resolvedDiff).toBeDefined();
    expect(resolvedDiff?.status).toBe("RESOLVED");

    const persistingDiff = result.diffRecords.find((d) => d.fingerprint === "fp-existing");
    expect(persistingDiff?.status).toBe("PERSISTING");

    const newDiff = result.diffRecords.find((d) => d.fingerprint === "fp-brand-new");
    expect(newDiff?.status).toBe("NEW");
  });

  test("does NOT carry forward triage from a different target", () => {
    const priorTriage: TargetFindingTriageRecord[] = [
      { targetId: "different-target", findingFingerprint: "fp-alpha", state: "FALSE_POSITIVE" },
    ];

    const result = TriageCarrier.processScanTriage(targetId, scanJobId, ["fp-alpha"], priorTriage);
    expect(result.findingsWithTriage[0].triageState).toBe("OPEN");
  });

  test("does NOT carry forward triage to a different fingerprint", () => {
    const priorTriage: TargetFindingTriageRecord[] = [
      { targetId, findingFingerprint: "fp-alpha", state: "FALSE_POSITIVE" },
    ];

    const result = TriageCarrier.processScanTriage(targetId, scanJobId, ["fp-beta"], priorTriage);
    expect(result.findingsWithTriage[0].triageState).toBe("OPEN");
  });

  test("supports all TriageState enums: OPEN, CONFIRMED, FALSE_POSITIVE, ACCEPTED_RISK, RESOLVED", () => {
    const states: ("OPEN" | "CONFIRMED" | "FALSE_POSITIVE" | "ACCEPTED_RISK" | "RESOLVED")[] = [
      "OPEN",
      "CONFIRMED",
      "FALSE_POSITIVE",
      "ACCEPTED_RISK",
      "RESOLVED",
    ];

    const priorTriage: TargetFindingTriageRecord[] = states.map((state, idx) => ({
      targetId,
      findingFingerprint: `fp-${idx}`,
      state,
    }));

    const result = TriageCarrier.processScanTriage(
      targetId,
      scanJobId,
      priorTriage.map((p) => p.findingFingerprint),
      priorTriage
    );

    states.forEach((state, idx) => {
      const finding = result.findingsWithTriage.find((f) => f.fingerprint === `fp-${idx}`);
      expect(finding?.triageState).toBe(state);
    });
  });
});
