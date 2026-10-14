import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  Crosshair,
  FileSearch,
  Globe,
  Plus,
  Radar,
  type LucideIcon,
} from "lucide-react";
import type { FindingSeverity } from "@wvs/shared";
import { fetchDashboardSummary, type DashboardSummary } from "@/services/dashboard";
import { fetchScans, type Scan } from "@/services/scans";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { SeverityBadge } from "@/pages/findings/components/finding-badges";
import { ScanStatusBadge } from "@/pages/scans/components/scan-status-badge";

const RECENT_SCANS = 5;

/** Most severe first, the order a reader triages in. */
const SEVERITY_ORDER: FindingSeverity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];

const SEVERITY_BAR: Record<FindingSeverity, string> = {
  CRITICAL: "bg-destructive",
  HIGH: "bg-orange-500",
  MEDIUM: "bg-amber-500",
  LOW: "bg-sky-500",
  INFO: "bg-slate-500",
};

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function formatWhen(scan: Scan): string {
  return new Date(scan.completedAt ?? scan.startedAt ?? scan.queuedAt).toLocaleString(
    undefined,
    { dateStyle: "medium", timeStyle: "short" },
  );
}

export function DashboardPage() {
  const summaryQuery = useQuery({
    queryKey: ["dashboard"],
    queryFn: fetchDashboardSummary,
  });

  return (
    <div className="mx-auto flex max-w-7xl flex-col gap-6 p-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dashboard</h1>
          <p className="text-muted-foreground">
            Your organisation&apos;s security posture at a glance.
          </p>
        </div>
        <Button asChild>
          <Link to="/targets">
            <Plus data-icon="inline-start" />
            Register a target
          </Link>
        </Button>
      </div>

      {summaryQuery.isPending ? (
        <div className="flex justify-center py-16">
          <Spinner className="size-8 text-primary" />
        </div>
      ) : summaryQuery.isError ? (
        <Alert variant="destructive">
          <AlertTitle>The dashboard could not be loaded</AlertTitle>
          <AlertDescription>{summaryQuery.error.message}</AlertDescription>
        </Alert>
      ) : summaryQuery.data.summary.targets.total === 0 ? (
        <GettingStarted />
      ) : (
        <Overview summary={summaryQuery.data.summary} />
      )}
    </div>
  );
}

function Overview({ summary }: { summary: DashboardSummary }) {
  const { scans, findings, targets } = summary;
  const activeScans = scans.QUEUED + scans.RUNNING + scans.PAUSED;
  const stoppedScans = scans.FAILED + scans.CANCELLED + scans.ABORTED_SAFETY;
  const openFindings = sum(Object.values(findings));

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          icon={Globe}
          label="Targets"
          value={targets.total}
          detail={`${targets.scannable} ready to scan`}
          href="/targets"
        />
        <StatCard
          icon={Radar}
          label="Scans in progress"
          value={activeScans}
          detail={`${scans.QUEUED} queued, ${scans.PAUSED} paused`}
          href="/scans"
        />
        <StatCard
          icon={Crosshair}
          label="Completed scans"
          value={scans.COMPLETED}
          detail={`${stoppedScans} failed or stopped`}
          href="/scans"
        />
        <StatCard
          icon={FileSearch}
          label="Open findings"
          value={openFindings}
          detail={`${findings.CRITICAL + findings.HIGH} critical or high`}
          href="/findings"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[2fr_3fr]">
        <SeverityCard findings={findings} total={openFindings} />
        <RecentScansCard />
      </div>
    </>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  detail,
  href,
}: {
  icon: LucideIcon;
  label: string;
  value: number;
  detail: string;
  href: string;
}) {
  return (
    <Link
      to={href}
      className="rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <Card className="h-full transition-colors hover:bg-muted/50">
        <CardHeader>
          <CardDescription className="flex items-center gap-2">
            <Icon className="size-4" aria-hidden="true" />
            {label}
          </CardDescription>
          <CardTitle className="text-2xl tabular-nums">{value}</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-muted-foreground">{detail}</CardContent>
      </Card>
    </Link>
  );
}

function SeverityCard({
  findings,
  total,
}: {
  findings: Record<FindingSeverity, number>;
  total: number;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Findings by severity</CardTitle>
        <CardDescription>
          From each target&apos;s latest completed scan, leaving out findings
          triaged as false positive, accepted risk or resolved.
        </CardDescription>
        <CardAction>
          <ViewAll to="/findings" label="View findings" />
        </CardAction>
      </CardHeader>
      <CardContent>
        {total === 0 ? (
          <p className="text-muted-foreground">No open findings.</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {SEVERITY_ORDER.map((severity) => (
              <li
                key={severity}
                className="grid grid-cols-[6.5rem_1fr_2.5rem] items-center gap-3"
              >
                <SeverityBadge severity={severity} />
                <div className="h-2 overflow-hidden rounded-full bg-muted" aria-hidden="true">
                  <div
                    className={`h-full rounded-full ${SEVERITY_BAR[severity]}`}
                    style={{ width: `${(findings[severity] / total) * 100}%` }}
                  />
                </div>
                <span className="text-right tabular-nums">{findings[severity]}</span>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function RecentScansCard() {
  const scansQuery = useQuery({
    queryKey: ["scans", "recent"],
    queryFn: () => fetchScans({}),
  });

  let body: ReactNode;
  if (scansQuery.isPending) {
    body = <Spinner className="size-6 text-primary" />;
  } else if (scansQuery.isError) {
    body = <p className="text-destructive">Recent scans could not be loaded.</p>;
  } else if (scansQuery.data.scans.length === 0) {
    body = (
      <p className="text-muted-foreground">
        No scans yet. Start one from a verified target.
      </p>
    );
  } else {
    body = (
      <ul className="flex flex-col divide-y divide-border">
        {scansQuery.data.scans.slice(0, RECENT_SCANS).map((scan) => (
          <li key={scan.id} className="flex items-center justify-between gap-4 py-3">
            <div className="flex min-w-0 flex-col">
              <Link
                to={`/scans/${scan.id}`}
                className="truncate font-medium hover:underline"
              >
                {scan.target?.label ?? "Deleted target"}
              </Link>
              <span className="text-xs text-muted-foreground">
                {scan.profile} · {formatWhen(scan)}
              </span>
            </div>
            <div className="flex shrink-0 items-center gap-3">
              <span className="text-xs text-muted-foreground tabular-nums">
                {scan.findingsCount} findings
              </span>
              <ScanStatusBadge status={scan.status} />
            </div>
          </li>
        ))}
      </ul>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Recent scans</CardTitle>
        <CardDescription>The latest scans across your targets.</CardDescription>
        <CardAction>
          <ViewAll to="/scans" label="View all scans" />
        </CardAction>
      </CardHeader>
      <CardContent>{body}</CardContent>
    </Card>
  );
}

function ViewAll({ to, label }: { to: string; label: string }) {
  return (
    <Button variant="ghost" size="sm" asChild>
      <Link to={to}>
        {label}
        <ArrowRight data-icon="inline-end" />
      </Link>
    </Button>
  );
}

function GettingStarted() {
  const steps = [
    "Register the website you want to test.",
    "Prove you own it with a DNS record or a file on the site.",
    "Start a scan and watch its progress live.",
    "Review the findings, triage them and export a report.",
  ];
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Globe />
        </EmptyMedia>
        <EmptyTitle>Scan your first website</EmptyTitle>
        <EmptyDescription>
          Nothing to summarise yet. Four steps take you from a website to a
          report.
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <ol className="flex list-decimal flex-col gap-1 pl-5 text-left">
          {steps.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <Button asChild>
          <Link to="/targets">
            <Plus data-icon="inline-start" />
            Register a target
          </Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
