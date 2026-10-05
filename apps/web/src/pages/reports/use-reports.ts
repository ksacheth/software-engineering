import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { PENDING_REPORT_STATUSES } from "@wvs/shared";
import { toast } from "sonner";
import { fetchReports, type Report } from "@/services/reports";
import { TEMPLATE_LABELS } from "./report-labels";

/**
 * The organisation's reports, or one scan's, polled while any is still being
 * generated.
 *
 * F.7 asks for a notification when generation completes. The author gets an
 * email; this is the in-app half, a toast when a report the user is watching
 * changes from pending to ready or failed. A report already finished when the
 * page loaded raises nothing.
 */

export const REPORT_POLL_INTERVAL_MS = 2_000;

function isPending(status: Report["status"] | undefined): boolean {
  return status !== undefined && PENDING_REPORT_STATUSES.includes(status);
}

/**
 * Reports that finished since `seen` was last updated. Records every current
 * status in `seen` as it goes, so each finish is reported once.
 */
export function finishedSince(
  seen: Map<string, Report["status"]>,
  reports: Report[],
): Report[] {
  const finished: Report[] = [];
  for (const report of reports) {
    const before = seen.get(report.id);
    seen.set(report.id, report.status);
    if (isPending(before) && !isPending(report.status)) finished.push(report);
  }
  return finished;
}

function announce(report: Report): void {
  const name = `${TEMPLATE_LABELS[report.template]} (${report.format}) for ${report.scan.target.label}`;
  if (report.status === "READY") toast.success(`${name} is ready`);
  else toast.error(`${name} could not be generated`);
}

export function useReports(scanId?: string) {
  const query = useQuery({
    queryKey: ["reports", scanId ?? "all"],
    queryFn: () => fetchReports(scanId),
    refetchInterval: (current) =>
      current.state.data?.reports.some((r) => isPending(r.status))
        ? REPORT_POLL_INTERVAL_MS
        : false,
  });

  const seen = useRef(new Map<string, Report["status"]>());
  const reports = query.data?.reports;

  useEffect(() => {
    if (reports) finishedSince(seen.current, reports).forEach(announce);
  }, [reports]);

  return query;
}
