import { prisma } from "@wvs/database";
import type { TriageState } from "@wvs/shared";
import { writeAudit } from "../../common/audit";
import type { AuthContext } from "../../common/session";
import type { BulkTriageRequest, TriageRequest } from "./finding-request";

/**
 * F.6 triage writes.
 *
 * The only way to change triage state is to append to `finding_triage_history`:
 * `wvs_app` can only read the projection, and a trigger maintains it from the
 * history (ADR-0003). Triage is held per `(target, fingerprint)`, so triaging a
 * finding from any scan sets it for every scan of that target, which is what
 * carries a judgement forward.
 *
 * Re-sending the current state and justification writes nothing, so a retried
 * request cannot pad the history with no-op transitions.
 *
 * Each change is also written to the audit log as FINDING_TRIAGED, after the
 * history insert and on the same best-effort terms as every other audited
 * action: history is the record of truth, and the audit row is what filtered
 * audit review (F.8) reads.
 */

export interface TriageOutcome {
  findingId: string;
  targetId: string;
  fingerprint: string;
  previous: TriageState;
  state: TriageState;
  changed: boolean;
}

export type TriageResult =
  | { ok: true; outcomes: TriageOutcome[] }
  | { ok: false; reason: "FINDING_NOT_FOUND" };

interface Subject {
  findingId: string;
  targetId: string;
  fingerprint: string;
}

async function currentTriage(
  subjects: Subject[],
): Promise<Map<string, { state: TriageState; justification: string | null }>> {
  const rows = await prisma.targetFindingTriage.findMany({
    where: {
      targetId: { in: [...new Set(subjects.map((s) => s.targetId))] },
      findingFingerprint: {
        in: [...new Set(subjects.map((s) => s.fingerprint))],
      },
    },
    select: {
      targetId: true,
      findingFingerprint: true,
      state: true,
      justification: true,
    },
  });
  return new Map(
    rows.map((row) => [
      `${row.targetId}\u0000${row.findingFingerprint}`,
      { state: row.state, justification: row.justification },
    ]),
  );
}

async function applyTriage(
  ctx: AuthContext,
  subjects: Subject[],
  request: TriageRequest,
): Promise<TriageOutcome[]> {
  // Two findings from different scans of one target share a triage row, so
  // they are one decision, not two.
  const unique = new Map<string, Subject>();
  for (const subject of subjects) {
    const key = `${subject.targetId}\u0000${subject.fingerprint}`;
    if (!unique.has(key)) unique.set(key, subject);
  }

  const current = await currentTriage([...unique.values()]);
  const justification = request.justification ?? null;

  const outcomes = [...unique].map(([key, subject]): TriageOutcome => {
    const existing = current.get(key);
    const previous = existing?.state ?? "OPEN";
    const changed =
      previous !== request.state ||
      (existing?.justification ?? null) !== justification;
    return { ...subject, previous, state: request.state, changed };
  });

  const changes = outcomes.filter((outcome) => outcome.changed);
  if (changes.length > 0) {
    // One statement, so a bulk triage lands whole or not at all.
    await prisma.findingTriageHistory.createMany({
      data: changes.map((change) => ({
        targetId: change.targetId,
        findingFingerprint: change.fingerprint,
        state: request.state,
        justification,
        userId: ctx.userId,
      })),
    });
  }

  for (const change of changes) {
    await writeAudit(ctx, {
      action: "FINDING_TRIAGED",
      resourceType: "finding",
      resourceId: change.findingId,
      metadata: {
        targetId: change.targetId,
        fingerprint: change.fingerprint,
        from: change.previous,
        to: change.state,
        justification,
      },
    });
  }

  return outcomes;
}

export async function triageFinding(
  ctx: AuthContext,
  findingId: string,
  request: TriageRequest,
): Promise<TriageResult> {
  return triageFindings(ctx, { ...request, findingIds: [findingId] });
}

/**
 * All or nothing: if any id is not a finding of this organisation, nothing is
 * written, and the refusal does not say which id failed, so it cannot be used
 * to probe another organisation's findings.
 */
export async function triageFindings(
  ctx: AuthContext,
  request: BulkTriageRequest,
): Promise<TriageResult> {
  const findings = await prisma.finding.findMany({
    where: {
      id: { in: request.findingIds },
      target: { organizationId: ctx.organizationId },
    },
    select: { id: true, targetId: true, fingerprint: true },
  });
  if (findings.length !== request.findingIds.length) {
    return { ok: false, reason: "FINDING_NOT_FOUND" };
  }

  const outcomes = await applyTriage(
    ctx,
    findings.map((finding) => ({
      findingId: finding.id,
      targetId: finding.targetId,
      fingerprint: finding.fingerprint,
    })),
    request,
  );
  return { ok: true, outcomes };
}
