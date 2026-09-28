import type { ReactNode } from "react";
import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, ChevronRight, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import {
  fetchFinding,
  triageFinding,
  type FindingDetail,
  type FindingEvidence,
  type TriageInput,
} from "@/services/findings";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useCanWrite } from "@/lib/use-role";
import {
  DiffBadge,
  SeverityBadge,
  TRIAGE_LABELS,
  TriageBadge,
} from "./components/finding-badges";
import { TriageForm } from "./components/triage-form";

/**
 * One finding (F.6), in the order a reader needs it: what is wrong in plain
 * language, how to fix it, the technical classification, then the evidence,
 * which is disclosed only on request (NFR-USE-1). Triage sits alongside, with
 * its history.
 */

function formatDate(value: string | null): string {
  return value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "-";
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-border py-1.5 text-sm last:border-b-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right font-mono text-xs break-all">{children}</dd>
    </div>
  );
}

function asText(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function EvidenceBlock({ label, value }: { label: string; value: unknown }) {
  const text = asText(value);
  if (!text) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre className="max-h-80 overflow-auto rounded-lg bg-muted p-3 font-mono text-xs whitespace-pre-wrap break-all">
        {text}
      </pre>
    </div>
  );
}

interface Occurrence {
  url: string;
  parameter?: string | null;
}

function asOccurrences(value: unknown): Occurrence[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Occurrence =>
      typeof entry === "object" && entry !== null && typeof entry.url === "string",
  );
}

function EvidenceSection({ evidence }: { evidence: FindingEvidence }) {
  switch (evidence.status) {
    case "NONE":
      return (
        <p className="text-sm text-muted-foreground">
          No request or response was recorded for this finding.
        </p>
      );
    case "PURGED":
      return (
        <p className="text-sm text-muted-foreground">
          Evidence purged on {formatDate(evidence.purgedAt)}, at the end of
          the retention period.
        </p>
      );
    case "WITHHELD_ROLE":
      return (
        <p className="text-sm text-muted-foreground">
          Raw evidence is available to analysts, developers and administrators.
        </p>
      );
    case "WITHHELD_UNREDACTED":
      return (
        <Alert>
          <ShieldOff className="size-4" />
          <AlertTitle>Evidence withheld</AlertTitle>
          <AlertDescription>
            Redaction of credentials and personal data was not confirmed for
            this evidence, so it is not shown.
          </AlertDescription>
        </Alert>
      );
    case "AVAILABLE":
      return (
        <details className="group rounded-lg border border-border">
          <summary className="flex cursor-pointer items-center gap-2 p-3 text-sm font-medium">
            <ChevronRight className="size-4 transition-transform group-open:rotate-90" />
            Show request and response
          </summary>
          <div className="flex flex-col gap-3 border-t border-border p-3">
            <p className="text-xs text-muted-foreground">
              Credentials, session tokens and recognised personal data are
              redacted. Kept until {formatDate(evidence.expiresAt)}.
            </p>
            <EvidenceBlock label="Extracted snippet" value={evidence.extractedSnippet} />
            <EvidenceBlock label="Request headers" value={evidence.requestHeaders} />
            <EvidenceBlock label="Request body" value={evidence.requestBody} />
            <EvidenceBlock label="Response headers" value={evidence.responseHeaders} />
            <EvidenceBlock label="Response body" value={evidence.responseBody} />
            <EvidenceBlock label="Reproduce with curl" value={evidence.curlCommand} />
          </div>
        </details>
      );
  }
}

function formatCvss(finding: FindingDetail): string {
  if (finding.cvssScore === null) return "-";
  const vector = finding.cvssVector ? ` · ${finding.cvssVector}` : "";
  return `${finding.cvssScore.toFixed(1)}${vector}`;
}

function formatEpss(finding: FindingDetail): string {
  if (finding.epssScore === null) return "-";
  const percentile =
    finding.epssPercentile === null
      ? ""
      : ` · percentile ${(finding.epssPercentile * 100).toFixed(0)}`;
  return `${(finding.epssScore * 100).toFixed(2)}%${percentile}`;
}

function OccurrenceList({ occurrences }: { occurrences: Occurrence[] }) {
  if (occurrences.length < 2) return null;
  return (
    <div className="mt-4 flex flex-col gap-1">
      <h3 className="text-sm font-medium">Also found at</h3>
      <ul className="flex flex-col gap-1">
        {occurrences.map((occurrence) => (
          <li
            key={`${occurrence.url}-${occurrence.parameter ?? ""}`}
            className="font-mono text-xs text-muted-foreground break-all"
          >
            {occurrence.url}
            {occurrence.parameter ? ` · ${occurrence.parameter}` : ""}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TechnicalDetailCard({ finding }: { finding: FindingDetail }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Technical detail</CardTitle>
      </CardHeader>
      <CardContent>
        <dl>
          <Row label="Target">
            <Link to={`/targets/${finding.target.id}`} className="hover:underline">
              {finding.target.label}
            </Link>
          </Row>
          <Row label="Detector">{finding.detectorId}</Row>
          <Row label="Confidence">{finding.confidence}</Row>
          <Row label="CWE">{finding.cwe ?? "-"}</Row>
          <Row label="OWASP category">{finding.owaspCategory ?? "-"}</Row>
          <Row label="CVSS">{formatCvss(finding)}</Row>
          <Row label="CVE">{finding.cveId ?? "-"}</Row>
          <Row label="EPSS">{formatEpss(finding)}</Row>
          <Row label="Occurrences">{finding.occurrenceCount}</Row>
          <Row label="Found by scan">
            <Link to={`/scans/${finding.scan.id}`} className="hover:underline">
              {finding.scan.profile} · {formatDate(finding.scan.completedAt)}
            </Link>
          </Row>
          <Row label="First seen">{formatDate(finding.seen.first)}</Row>
          <Row label="Last seen">
            {formatDate(finding.seen.last)} · in {finding.seen.scans} scan
            {finding.seen.scans === 1 ? "" : "s"}
          </Row>
        </dl>
        <OccurrenceList occurrences={asOccurrences(finding.occurrences)} />
      </CardContent>
    </Card>
  );
}

function TriagePanel({ finding }: { finding: FindingDetail }) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const mutation = useMutation({
    mutationFn: (input: TriageInput) => triageFinding(finding.id, input),
    onSuccess: ({ finding: updated, changed }) => {
      queryClient.setQueryData(["finding", finding.id], { finding: updated });
      void queryClient.invalidateQueries({ queryKey: ["findings"] });
      toast.success(changed ? "Triage recorded" : "Already in that state");
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Triage</CardTitle>
        <CardDescription>
          Applies to this finding in every scan of {finding.target.label}.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <TriageBadge state={finding.triage.state} />
          {finding.triage.updatedBy && (
            <span className="text-muted-foreground">
              by {finding.triage.updatedBy.name},{" "}
              {formatDate(finding.triage.updatedAt)}
            </span>
          )}
        </div>
        {finding.triage.justification && (
          <p className="text-sm">{finding.triage.justification}</p>
        )}

        {canWrite && (
          <TriageForm
            key={`${finding.triage.state}-${finding.triage.updatedAt}`}
            initialState={finding.triage.state}
            initialJustification={finding.triage.justification}
            submitLabel="Record triage"
            pending={mutation.isPending}
            error={mutation.error instanceof Error ? mutation.error.message : null}
            onSubmit={(input) => mutation.mutate(input)}
          />
        )}

        <div className="flex flex-col gap-2">
          <h3 className="text-sm font-medium">History</h3>
          {finding.triageHistory.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Never triaged. Untriaged findings are open.
            </p>
          ) : (
            <ol className="flex flex-col gap-3" aria-label="Triage history">
              {finding.triageHistory.map((entry) => (
                <li key={entry.id} className="border-l-2 border-border pl-3 text-sm">
                  <div className="font-medium">{TRIAGE_LABELS[entry.state]}</div>
                  <div className="text-xs text-muted-foreground">
                    {entry.user?.name ?? "Deleted user"} ·{" "}
                    {formatDate(entry.createdAt)}
                  </div>
                  {entry.justification && <p className="mt-1">{entry.justification}</p>}
                </li>
              ))}
            </ol>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

export function FindingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, isLoading, error } = useQuery({
    queryKey: ["finding", id],
    queryFn: () => fetchFinding(id!),
    enabled: Boolean(id),
  });

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Spinner className="size-8" />
      </div>
    );
  }

  const finding = data?.finding;
  if (error || !finding) {
    return (
      <div className="flex flex-col gap-4 p-6 max-w-6xl mx-auto">
        <Alert variant="destructive">
          <AlertTitle>Finding not found</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : "This finding could not be loaded."}
          </AlertDescription>
        </Alert>
        <Button variant="outline" asChild className="w-fit">
          <Link to="/findings">
            <ArrowLeft data-icon="inline-start" />
            Back to Findings
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <Button variant="ghost" size="sm" asChild className="w-fit">
        <Link
          to="/findings"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft data-icon="inline-start" />
          Back to Findings
        </Link>
      </Button>

      <div className="flex flex-col gap-3 rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center gap-3">
          <SeverityBadge severity={finding.severity} />
          <TriageBadge state={finding.triage.state} />
          <DiffBadge status={finding.diffStatus} />
        </div>
        <h1 className="text-2xl font-bold tracking-tight">{finding.name}</h1>
        <p className="max-w-3xl text-base leading-relaxed">{finding.description}</p>
        <p className="font-mono text-xs text-muted-foreground break-all">
          {finding.affectedUrl}
          {finding.affectedParameter ? ` · parameter ${finding.affectedParameter}` : ""}
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="text-base">How to fix it</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm leading-relaxed">{finding.remediation}</p>
            </CardContent>
          </Card>

          <TechnicalDetailCard finding={finding} />

          <Card>
            <CardHeader>
              <CardTitle className="text-base">Evidence</CardTitle>
              <CardDescription>
                The request and response that substantiate this finding.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <EvidenceSection evidence={finding.evidence} />
            </CardContent>
          </Card>
        </div>

        <TriagePanel finding={finding} />
      </div>
    </div>
  );
}
