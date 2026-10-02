import { Link, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CircleSlash,
  Pause,
  Play,
  Radio,
  Wifi,
  WifiOff,
} from "lucide-react";
import { toast } from "sonner";
import {
  PROGRESS_INTERVAL_MS,
  isTerminalScanStatus,
  type ScanStatus,
} from "@wvs/shared";
import {
  cancelScan,
  pauseScan,
  resumeScan,
  ScanApiError,
  type Scan,
} from "@/services/scans";
import { fetchResolvedSince } from "@/services/findings";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { useCanWrite } from "@/lib/use-role";
import { useWebSocket } from "@/providers/websocket-provider";
import { ScanStatusBadge } from "./components/scan-status-badge";
import { useLiveScan } from "./use-live-scan";
import type { ScanFindingSummary } from "@/services/scans";
import {
  SeverityBadge,
  TriageBadge,
} from "../findings/components/finding-badges";
import { FindingsTable } from "../findings/components/findings-table";

function ConnectionBadge({
  socketStatus,
  isPolling,
}: {
  socketStatus: string;
  isPolling: boolean;
}) {
  if (socketStatus === "connected") {
    return (
      <Badge
        variant="outline"
        className="border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
      >
        <Wifi data-icon="inline-start" />
        Live
      </Badge>
    );
  }

  return (
    <Badge
      variant="outline"
      className="border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    >
      <WifiOff data-icon="inline-start" />
      {isPolling ? "Reconnecting, polling" : "Reconnecting"}
    </Badge>
  );
}
function ProgressBar({ value }: { value: number }) {
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-muted"
      role="progressbar"
      aria-valuenow={Math.round(clamped)}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-primary transition-all"
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

function FindingTable({ findings }: { findings: ScanFindingSummary[] }) {
  if (findings.length === 0) {
    return (
      <p className="py-6 text-center text-sm text-muted-foreground">
        No findings yet. They appear here as they are discovered.
      </p>
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Severity</TableHead>
          <TableHead>Finding</TableHead>
          <TableHead>Detector</TableHead>
          <TableHead>Location</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((finding) => (
          <TableRow key={finding.fingerprint}>
            <TableCell>
              <SeverityBadge severity={finding.severity} />
            </TableCell>
            <TableCell className="text-sm font-medium">
              {/* A finding streamed live is keyed by its fingerprint until the
                  durable row is read back, and only a durable row has a
                  detail page to link to. */}
              {finding.id !== finding.fingerprint ? (
                <Link
                  to={`/findings/${finding.id}`}
                  className="transition-colors hover:text-primary"
                >
                  {finding.name}
                </Link>
              ) : (
                finding.name
              )}
            </TableCell>
            <TableCell className="font-mono text-xs text-muted-foreground">
              {finding.detectorId}
            </TableCell>
            <TableCell className="max-w-80 truncate font-mono text-xs text-muted-foreground">
              {finding.affectedUrl}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * What the previous scan found and this one did not (diff RESOLVED). This
 * scan wrote no row for them, so each links to its last earlier sighting.
 */
function ResolvedSinceCard({ scanId }: { scanId: string }) {
  const { data, isLoading, error } = useQuery({
    queryKey: ["findings", "resolved", scanId],
    queryFn: () => fetchResolvedSince(scanId),
  });
  const resolved = data?.findings ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Resolved since previous scan</CardTitle>
        <CardDescription>
          Found by an earlier scan and not seen by this one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <Spinner className="mx-auto size-6" />
        ) : error ? (
          <p className="text-sm text-destructive">
            {error instanceof Error ? error.message : "Could not load resolved findings."}
          </p>
        ) : resolved.length === 0 ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Nothing from the previous scan has gone away.
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Severity</TableHead>
                <TableHead>Finding</TableHead>
                <TableHead>Triage</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {resolved.map((finding) => (
                <TableRow key={finding.fingerprint}>
                  <TableCell>
                    <SeverityBadge severity={finding.severity} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col">
                      <Link
                        to={`/findings/${finding.id}`}
                        className="text-sm font-medium transition-colors hover:text-primary"
                      >
                        {finding.name}
                      </Link>
                      <span className="truncate font-mono text-xs text-muted-foreground">
                        {finding.affectedUrl}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell>
                    <TriageBadge state={finding.triage.state} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

function ControlButtons({
  scan,
  onError,
}: {
  scan: Scan;
  onError: (message: string) => void;
}) {
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();

  const settle = (updated: Scan) => {
    queryClient.setQueryData(["scan", scan.id], { scan: updated });
    void queryClient.invalidateQueries({ queryKey: ["scans"] });
  };

  const handleError = (error: unknown) => {
    onError(
      error instanceof ScanApiError
        ? error.message
        : error instanceof Error
          ? error.message
          : "The command was refused",
    );
  };

  const pause = useMutation({
    mutationFn: () => pauseScan(scan.id),
    onSuccess: ({ scan: updated }) => {
      settle(updated);
      toast.success("Scan paused");
    },
    onError: handleError,
  });
  const resume = useMutation({
    mutationFn: () => resumeScan(scan.id),
    onSuccess: ({ scan: updated }) => {
      settle(updated);
      toast.success("Scan resumed");
    },
    onError: handleError,
  });
  const cancel = useMutation({
    mutationFn: () => cancelScan(scan.id),
    onSuccess: ({ scan: updated }) => {
      settle(updated);
      toast.success("Scan cancelled");
    },
    onError: handleError,
  });

  if (!canWrite) return null;

  const busy = pause.isPending || resume.isPending || cancel.isPending;
  const finished = isTerminalScanStatus(scan.status);

  return (
    <div className="flex items-center gap-2">
      {scan.status === "RUNNING" && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => pause.mutate()}
        >
          {pause.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Pause data-icon="inline-start" />
          )}
          Pause
        </Button>
      )}

      {scan.status === "PAUSED" && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => resume.mutate()}
        >
          {resume.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <Play data-icon="inline-start" />
          )}
          Resume
        </Button>
      )}

      {!finished && (
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => cancel.mutate()}
        >
          {cancel.isPending ? (
            <Spinner data-icon="inline-start" />
          ) : (
            <CircleSlash data-icon="inline-start" />
          )}
          Cancel
        </Button>
      )}
    </div>
  );
}

function ReproCard({ scan }: { scan: Scan }) {
  const rows: [string, string][] = [
    ["Profile", scan.profile],
    ["Started by", scan.startedBy?.name ?? "Unknown"],
    [
      "Limits",
      `${scan.configuration.rateLimit} req/s · concurrency ${scan.configuration.concurrency} · depth ${scan.configuration.maxDepth}`,
    ],
    [
      "Ceilings",
      `${scan.configuration.maxPages} pages · ${scan.configuration.maxRequests} requests`,
    ],
    [
      "Scope snapshot",
      `${scan.includedPaths.length} included · ${scan.excludedPaths.length} excluded`,
    ],
    [
      "Detector versions",
      scan.detectorVersions
        ? JSON.stringify(scan.detectorVersions)
        : "not yet recorded",
    ],
    ["Queued", new Date(scan.queuedAt).toLocaleString()],
    [
      "Started",
      scan.startedAt ? new Date(scan.startedAt).toLocaleString() : "-",
    ],
    [
      "Finished",
      scan.completedAt ? new Date(scan.completedAt).toLocaleString() : "-",
    ],
  ];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">How this scan was produced</CardTitle>
        <CardDescription>
          Recorded at launch so the result can be accounted for afterwards.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="flex justify-between gap-4 border-b border-border py-1.5 text-sm last:border-b-0"
          >
            <span className="text-muted-foreground">{label}</span>
            <span className="text-right font-mono text-xs">{value}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export function ScanDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { status: socketStatus } = useWebSocket();
  const {
    scan,
    isLoading,
    error,
    findings,
    warnings,
    isPolling,
    isStalled,
    refresh,
  } = useLiveScan(id, socketStatus);

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Spinner className="size-8" />
      </div>
    );
  }

  if (error || !scan) {
    return (
      <div className="flex flex-col gap-4 p-6 max-w-6xl mx-auto">
        <Alert variant="destructive">
          <AlertTitle>Scan not found</AlertTitle>
          <AlertDescription>
            {error instanceof Error
              ? error.message
              : "This scan could not be loaded."}
          </AlertDescription>
        </Alert>
        <Button variant="outline" asChild className="w-fit">
          <Link to="/scans">
            <ArrowLeft data-icon="inline-start" />
            Back to Scans
          </Link>
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link
            to="/scans"
            className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft data-icon="inline-start" />
            Back to Scans
          </Link>
        </Button>
        <div className="flex items-center gap-2">
          <ConnectionBadge socketStatus={socketStatus} isPolling={isPolling} />
          <ControlButtons
            scan={scan}
            onError={(message) => toast.error(message)}
          />
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-6">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">
            {scan.target?.label ?? "Scan"}
          </h1>
          <ScanStatusBadge status={scan.status} />
        </div>
        {scan.target && (
          <a
            href={scan.target.origin}
            target="_blank"
            rel="noreferrer noopener"
            className="w-fit font-mono text-sm text-muted-foreground hover:text-foreground hover:underline"
          >
            {scan.target.origin}
          </a>
        )}
        <p className="font-mono text-xs text-muted-foreground">
          {scan.id} · updates {PROGRESS_INTERVAL_MS / 1000}s or faster while
          live
        </p>
      </div>

      {scan.failureReason && (
        <Alert variant="destructive">
          <AlertTriangle className="size-4" />
          <AlertTitle>Scan failed</AlertTitle>
          <AlertDescription>{scan.failureReason}</AlertDescription>
        </Alert>
      )}

      {isStalled && (
        <Alert className="border-amber-500/30 bg-amber-500/10">
          <AlertTriangle className="size-4 text-amber-600" />
          <AlertTitle>No update from the scan engine</AlertTitle>
          <AlertDescription>
            This scan has been {scan.status.toLowerCase()} with no progress for
            over five minutes. The worker may have stopped; a scan that is
            merely slow still updates.
            <Button variant="link" size="sm" className="px-1" onClick={refresh}>
              Refresh
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {warnings.length > 0 && (
        <Alert className="border-amber-500/30 bg-amber-500/10">
          <AlertTriangle className="size-4 text-amber-600" />
          <AlertTitle>Reduced coverage</AlertTitle>
          <AlertDescription>
            <ul className="list-disc pl-4">
              {warnings.map((warning) => (
                <li key={warning.code}>{warning.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Radio className="size-4 text-primary" />
            Progress
          </CardTitle>
          <CardDescription>
            {isPolling
              ? "The live connection is down; this view is polling instead."
              : "Streaming while the scan runs."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <ProgressBar value={scan.progressPercentage} />
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            {[
              ["Phase", scan.phase],
              ["Pages crawled", String(scan.pagesCrawled)],
              ["Requests made", String(scan.requestsMade)],
              ["Findings", String(scan.findingsCount)],
            ].map(([label, value]) => (
              <div key={label} className="flex flex-col">
                <span className="text-xs text-muted-foreground">{label}</span>
                <span className="font-mono text-lg font-semibold">{value}</span>
              </div>
            ))}
          </div>
          <div className="flex justify-between text-xs text-muted-foreground">
            <span>{Math.round(scan.progressPercentage)}% complete</span>
            <span>
              {scan.status === "PAUSED"
                ? "Paused - still holding its concurrency slot"
                : ""}
            </span>
          </div>
        </CardContent>
      </Card>

      {scan.status === "COMPLETED" ? (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Findings</CardTitle>
              <CardDescription>
                Everything this scan found, compared with the previous scan of
                the target.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <FindingsTable scanId={scan.id} />
            </CardContent>
          </Card>
          <ResolvedSinceCard scanId={scan.id} />
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Findings so far</CardTitle>
            <CardDescription>
              Live findings, and any recorded before this view was opened. The
              full list with triage appears when the scan completes.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <FindingTable findings={findings} />
          </CardContent>
        </Card>
      )}

      <ReproCard scan={scan} />
    </div>
  );
}

export type { ScanStatus };
