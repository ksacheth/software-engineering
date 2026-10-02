import {
  COMPARISON_STATUSES,
  FINDING_CONFIDENCES,
  FINDING_SEVERITIES,
  TRIAGE_STATES,
  type ComparisonStatus,
  type FindingConfidence,
  type FindingSeverity,
  type TriageState,
} from "@wvs/shared";
import { ArrowDownWideNarrow, ArrowUpNarrowWide } from "lucide-react";
import {
  FINDING_SORTS,
  type FindingFilters,
  type FindingSort,
} from "@/services/findings";
import type { Target } from "@/services/targets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  DIFF_LABELS,
  SeverityBadge,
  TRIAGE_LABELS,
} from "./finding-badges";

/**
 * The findings list's filter and sort controls, and how their state becomes
 * the query the server applies.
 */

const DEFAULT = "DEFAULT";
const ANY = "ANY";

export interface FilterState {
  search: string;
  detectorId: string;
  severities: FindingSeverity[];
  /** DEFAULT, "all", or a triage state. */
  triage: string;
  diff: string;
  confidence: string;
  targetId: string;
  owasp: string;
  sort: FindingSort;
  direction: "asc" | "desc";
}

export const INITIAL_FILTERS: FilterState = {
  search: "",
  detectorId: "",
  severities: [],
  triage: DEFAULT,
  diff: ANY,
  confidence: ANY,
  targetId: ANY,
  owasp: ANY,
  sort: "severity",
  direction: "desc",
};

const orUndefined = (value: string) => (value === ANY ? undefined : value);

/**
 * The server query for a filter state. In the posture the default triage
 * filter is left to the server, which applies "needs action"; one scan's
 * findings are shown whole.
 */
export function toFindingFilters(
  state: FilterState,
  scanId: string | undefined,
): FindingFilters {
  const defaultTriage = scanId ? "all" : undefined;
  return {
    scanId,
    search: state.search.trim() || undefined,
    detectorId: state.detectorId.trim() || undefined,
    severities: state.severities.length ? state.severities : undefined,
    triage:
      state.triage === DEFAULT
        ? defaultTriage
        : (state.triage as TriageState | "all"),
    diff: orUndefined(state.diff) as ComparisonStatus | undefined,
    confidence: orUndefined(state.confidence) as FindingConfidence | undefined,
    targetId: orUndefined(state.targetId),
    owaspCategory: orUndefined(state.owasp),
    sort: state.sort,
    direction: state.direction,
  };
}

const SORT_LABELS: Record<FindingSort, string> = {
  severity: "Severity",
  cvss: "CVSS",
  epss: "EPSS",
  name: "Name",
  detected: "Detected",
};

const OWASP_2021 = [
  ["A01:2021", "A01 Broken Access Control"],
  ["A02:2021", "A02 Cryptographic Failures"],
  ["A03:2021", "A03 Injection"],
  ["A04:2021", "A04 Insecure Design"],
  ["A05:2021", "A05 Security Misconfiguration"],
  ["A06:2021", "A06 Vulnerable Components"],
  ["A07:2021", "A07 Authentication Failures"],
  ["A08:2021", "A08 Integrity Failures"],
  ["A09:2021", "A09 Logging Failures"],
  ["A10:2021", "A10 SSRF"],
] as const;

const SEVERITY_ORDER = [...FINDING_SEVERITIES].reverse();

/** A finding row is never diff RESOLVED: the resolving scan writes no row. */
const ROW_DIFF_STATUSES = COMPARISON_STATUSES.filter(
  (status) => status !== "RESOLVED",
);

interface FilterSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly (readonly [string, string])[];
  className: string;
}

function FilterSelect({ label, value, onChange, options, className }: FilterSelectProps) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className={className} aria-label={label}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map(([option, text]) => (
          <SelectItem key={option} value={option}>
            {text}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function SeverityToggles({
  selected,
  onToggle,
}: {
  selected: FindingSeverity[];
  onToggle: (severity: FindingSeverity) => void;
}) {
  return (
    <div role="group" aria-label="Filter by severity" className="flex flex-wrap items-center gap-1">
      {SEVERITY_ORDER.map((severity) => {
        const active = selected.includes(severity);
        return (
          <button
            key={severity}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(severity)}
            className={cn(
              "rounded-full outline-none focus-visible:ring-3 focus-visible:ring-ring/50",
              !active && selected.length > 0 && "opacity-40",
            )}
          >
            <SeverityBadge severity={severity} />
          </button>
        );
      })}
    </div>
  );
}

interface FindingsFilterBarProps {
  value: FilterState;
  onChange: (change: Partial<FilterState>) => void;
  /** Present in the posture, where findings span targets. */
  targets?: Pick<Target, "id" | "label">[];
}

export function FindingsFilterBar({ value, onChange, targets }: FindingsFilterBarProps) {
  const isPosture = targets !== undefined;

  const toggleSeverity = (severity: FindingSeverity) =>
    onChange({
      severities: value.severities.includes(severity)
        ? value.severities.filter((s) => s !== severity)
        : [...value.severities, severity],
    });

  const triageOptions: [string, string][] = [
    [DEFAULT, isPosture ? "Needs action" : "All triage states"],
    ...(isPosture ? [["all", "All triage states"] as [string, string]] : []),
    ...TRIAGE_STATES.map((state): [string, string] => [state, TRIAGE_LABELS[state]]),
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          value={value.search}
          onChange={(event) => onChange({ search: event.target.value })}
          placeholder="Search name or URL"
          aria-label="Search findings by name or URL"
          className="w-64"
        />
        <Input
          value={value.detectorId}
          onChange={(event) => onChange({ detectorId: event.target.value })}
          placeholder="Detector, e.g. A-01"
          aria-label="Filter by detector"
          className="w-40"
        />
        <SeverityToggles selected={value.severities} onToggle={toggleSeverity} />
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <FilterSelect
          label="Filter by triage state"
          className="w-52"
          value={value.triage}
          onChange={(triage) => onChange({ triage })}
          options={triageOptions}
        />
        <FilterSelect
          label="Filter by diff status"
          className="w-44"
          value={value.diff}
          onChange={(diff) => onChange({ diff })}
          options={[
            [ANY, "Any diff status"],
            ...ROW_DIFF_STATUSES.map((status): [string, string] => [status, DIFF_LABELS[status]]),
          ]}
        />
        <FilterSelect
          label="Filter by confidence"
          className="w-40"
          value={value.confidence}
          onChange={(confidence) => onChange({ confidence })}
          options={[
            [ANY, "Any confidence"],
            ...FINDING_CONFIDENCES.map((option): [string, string] => [option, option]),
          ]}
        />
        <FilterSelect
          label="Filter by OWASP category"
          className="w-56"
          value={value.owasp}
          onChange={(owasp) => onChange({ owasp })}
          options={[[ANY, "Any OWASP category"], ...OWASP_2021]}
        />
        {isPosture && (
          <FilterSelect
            label="Filter by target"
            className="w-52"
            value={value.targetId}
            onChange={(targetId) => onChange({ targetId })}
            options={[
              [ANY, "All targets"],
              ...targets.map((target): [string, string] => [target.id, target.label]),
            ]}
          />
        )}

        <div className="ml-auto flex items-center gap-1">
          <FilterSelect
            label="Sort by"
            className="w-36"
            value={value.sort}
            onChange={(sort) =>
              onChange({
                sort: sort as FindingSort,
                direction: sort === "name" ? "asc" : "desc",
              })
            }
            options={FINDING_SORTS.map((option): [string, string] => [option, SORT_LABELS[option]])}
          />
          <Button
            variant="outline"
            size="icon"
            onClick={() =>
              onChange({ direction: value.direction === "asc" ? "desc" : "asc" })
            }
            aria-label={value.direction === "asc" ? "Sorted ascending" : "Sorted descending"}
          >
            {value.direction === "asc" ? <ArrowUpNarrowWide /> : <ArrowDownWideNarrow />}
          </Button>
        </div>
      </div>
    </div>
  );
}
