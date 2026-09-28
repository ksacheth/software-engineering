import {
  Circle,
  Diamond,
  Info,
  OctagonAlert,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import type {
  ComparisonStatus,
  FindingSeverity,
  TriageState,
} from "@wvs/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * Severity, triage state and diff status, each rendered so it can be read
 * without colour: severity carries a label and a distinct shape (SRS §3.2.1),
 * and the other two are always spelled out.
 */

const SEVERITY_STYLE: Record<
  FindingSeverity,
  { icon: LucideIcon; label: string; className: string }
> = {
  CRITICAL: {
    icon: OctagonAlert,
    label: "Critical",
    className: "border-destructive/30 bg-destructive/10 text-destructive",
  },
  HIGH: {
    icon: TriangleAlert,
    label: "High",
    className:
      "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  },
  MEDIUM: {
    icon: Diamond,
    label: "Medium",
    className:
      "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  LOW: {
    icon: Circle,
    label: "Low",
    className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  INFO: {
    icon: Info,
    label: "Info",
    className:
      "border-slate-500/30 bg-slate-500/10 text-slate-700 dark:text-slate-300",
  },
};

/**
 * A worker running ahead of a deployed dashboard can send a severity the
 * dashboard has never seen. Dropping it would hide a finding, so it is shown
 * with its own label, styled as INFO.
 */
export function SeverityBadge({ severity }: { severity: string }) {
  const known = severity in SEVERITY_STYLE;
  const style = SEVERITY_STYLE[(known ? severity : "INFO") as FindingSeverity];
  const Icon = style.icon;
  return (
    <Badge variant="outline" className={cn("cursor-default", style.className)}>
      <Icon data-icon="inline-start" aria-hidden="true" />
      {known ? style.label : severity}
    </Badge>
  );
}

export const TRIAGE_LABELS: Record<TriageState, string> = {
  OPEN: "Open",
  CONFIRMED: "Confirmed",
  FALSE_POSITIVE: "False positive",
  ACCEPTED_RISK: "Accepted risk",
  RESOLVED: "Resolved (claimed)",
};

const TRIAGE_CLASSES: Record<TriageState, string> = {
  OPEN: "",
  CONFIRMED:
    "border-orange-500/30 bg-orange-500/10 text-orange-700 dark:text-orange-300",
  FALSE_POSITIVE: "border-slate-500/30 text-muted-foreground",
  ACCEPTED_RISK: "border-slate-500/30 text-muted-foreground",
  RESOLVED:
    "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
};

export function TriageBadge({ state }: { state: TriageState }) {
  return (
    <Badge variant="outline" className={cn("cursor-default", TRIAGE_CLASSES[state])}>
      {TRIAGE_LABELS[state]}
    </Badge>
  );
}

export const DIFF_LABELS: Record<ComparisonStatus, string> = {
  NEW: "New",
  PERSISTING: "Persisting",
  RESOLVED: "Gone in rescan",
};

/**
 * The machine's comparison with the previous scan. Worded differently from
 * triage RESOLVED on purpose: one is a person's claim, the other is what the
 * rescan observed (CONTEXT.md).
 */
export function DiffBadge({ status }: { status: ComparisonStatus | null }) {
  if (!status) return <span className="text-xs text-muted-foreground">-</span>;
  return (
    <Badge
      variant={status === "NEW" ? "default" : "secondary"}
      className="cursor-default"
    >
      {DIFF_LABELS[status]}
    </Badge>
  );
}
