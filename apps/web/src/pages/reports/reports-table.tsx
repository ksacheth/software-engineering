import { useState } from "react";
import { Link } from "react-router-dom";
import { AlertCircle, Download, Link2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useCanWrite, useRole } from "@/lib/use-role";
import { reportDownloadUrl, type Report } from "@/services/reports";
import { TRIAGE_LABELS } from "../findings/components/finding-badges";
import { ShareReportDialog } from "./share-report-dialog";
import { formatBytes, TEMPLATE_LABELS } from "./report-labels";
import { useReports } from "./use-reports";

/**
 * Reports with their generation status, download and share controls (F.7).
 *
 * The controls mirror what the API enforces rather than replacing it: a VIEWER
 * is not offered a file that holds raw evidence (ADR-0010), and only a write
 * role is offered sharing (ADR-0011).
 */

function StatusBadge({ report }: { report: Report }) {
  if (report.status === "READY" && report.expired) {
    return <Badge variant="outline">Expired</Badge>;
  }
  switch (report.status) {
    case "QUEUED":
      return (
        <Badge variant="outline">
          <Spinner data-icon="inline-start" /> Queued
        </Badge>
      );
    case "GENERATING":
      return (
        <Badge variant="outline">
          <Spinner data-icon="inline-start" /> Generating
        </Badge>
      );
    case "READY":
      return (
        <Badge
          variant="outline"
          className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
        >
          Ready
        </Badge>
      );
    case "FAILED":
      return (
        <Badge variant="outline" className="border-destructive/30 bg-destructive/10 text-destructive">
          Failed
        </Badge>
      );
  }
}

function filterText(report: Report): string {
  const parts: string[] = [];
  if (report.filters.minSeverity) parts.push(`${report.filters.minSeverity} and above`);
  if (report.filters.triageStates.length > 0) {
    parts.push(report.filters.triageStates.map((s) => TRIAGE_LABELS[s]).join(", "));
  }
  return parts.join(" · ") || "All findings";
}

function downloadBlockedReason(report: Report, role: string | null): string | null {
  if (report.status !== "READY") return "The report is not ready yet.";
  if (report.expired) return "The evidence in this report has passed its retention period.";
  if (report.includesEvidence && role === "VIEWER") {
    return "This report contains raw evidence, which your role cannot read.";
  }
  return null;
}

function ReportActions({ report, onShare }: { report: Report; onShare: () => void }) {
  const role = useRole();
  const canWrite = useCanWrite();
  const blocked = downloadBlockedReason(report, role);
  const label = `Download ${TEMPLATE_LABELS[report.template]} (${report.format})`;

  return (
    <div className="flex justify-end gap-2">
      {blocked ? (
        <Button size="sm" variant="outline" disabled title={blocked} aria-label={label}>
          <Download data-icon="inline-start" />
          Download
        </Button>
      ) : (
        <Button size="sm" variant="outline" asChild>
          <a href={reportDownloadUrl(report.id)} download aria-label={label}>
            <Download data-icon="inline-start" />
            Download
          </a>
        </Button>
      )}
      {canWrite && report.status === "READY" && !report.expired && (
        <Button size="sm" variant="ghost" onClick={onShare} aria-label={`Share ${label}`}>
          <Link2 data-icon="inline-start" />
          {report.share.active ? "Shared" : "Share"}
        </Button>
      )}
    </div>
  );
}

function fileText(report: Report): string {
  return [
    report.format,
    report.fileSize !== null ? formatBytes(report.fileSize) : null,
    report.includesEvidence ? "raw evidence" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

interface ReportRowProps {
  report: Report;
  showScan: boolean;
  onShare: () => void;
}

function ReportRow({ report, showScan, onShare }: ReportRowProps) {
  const failure = report.status === "FAILED" ? report.failureReason : null;
  return (
    <TableRow>
      <TableCell className="text-sm">
        <div>{new Date(report.createdAt).toLocaleString()}</div>
        <div className="text-xs text-muted-foreground">{report.createdBy?.name}</div>
      </TableCell>
      {showScan && (
        <TableCell className="text-sm">
          <Link to={`/scans/${report.scan.id}`} className="hover:underline">
            {report.scan.target.label}
          </Link>
          <div className="font-mono text-xs text-muted-foreground">
            {report.scan.target.origin}
          </div>
        </TableCell>
      )}
      <TableCell className="text-sm">
        <div className="font-medium">{TEMPLATE_LABELS[report.template]}</div>
        <div className="text-xs text-muted-foreground">{fileText(report)}</div>
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">{filterText(report)}</TableCell>
      <TableCell>
        <StatusBadge report={report} />
        {failure && <div className="mt-1 max-w-56 text-xs text-muted-foreground">{failure}</div>}
      </TableCell>
      <TableCell>
        <ReportActions report={report} onShare={onShare} />
      </TableCell>
    </TableRow>
  );
}

interface ReportsTableProps {
  /** Scopes the table to one scan and drops the scan column. */
  scanId?: string;
}

export function ReportsTable({ scanId }: ReportsTableProps) {
  const { data, isLoading, error } = useReports(scanId);
  const [sharing, setSharing] = useState<Report | null>(null);

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="size-6" />
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertCircle className="size-4" />
        <AlertTitle>Reports could not be loaded</AlertTitle>
        <AlertDescription>{error instanceof Error ? error.message : "Try again."}</AlertDescription>
      </Alert>
    );
  }

  const reports = data?.reports ?? [];
  if (reports.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No reports yet. Generate one from a completed scan.
      </p>
    );
  }

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Requested</TableHead>
            {!scanId && <TableHead>Scan</TableHead>}
            <TableHead>Report</TableHead>
            <TableHead>Includes</TableHead>
            <TableHead>Status</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reports.map((report) => (
            <ReportRow
              key={report.id}
              report={report}
              showScan={!scanId}
              onShare={() => setSharing(report)}
            />
          ))}
        </TableBody>
      </Table>
      {sharing && (
        <ShareReportDialog
          report={reports.find((r) => r.id === sharing.id) ?? sharing}
          open
          onOpenChange={(open) => {
            if (!open) setSharing(null);
          }}
        />
      )}
    </>
  );
}
