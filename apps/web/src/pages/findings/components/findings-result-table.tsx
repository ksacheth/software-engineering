import { Link, useNavigate } from "react-router-dom";
import type { FindingSummary } from "@/services/findings";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { DiffBadge, SeverityBadge, TriageBadge } from "./finding-badges";

/**
 * The rows of the findings list. Selection is offered only when a
 * `selection` is passed, which the list does for write roles.
 */

export interface RowSelection {
  selected: ReadonlySet<string>;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
}

function formatCvss(value: number | null): string {
  return value === null ? "-" : value.toFixed(1);
}

function formatEpss(value: number | null): string {
  return value === null ? "-" : `${(value * 100).toFixed(1)}%`;
}

interface FindingsResultTableProps {
  findings: FindingSummary[];
  showTarget: boolean;
  selection?: RowSelection;
}

export function FindingsResultTable({
  findings,
  showTarget,
  selection,
}: FindingsResultTableProps) {
  const navigate = useNavigate();
  const allSelected =
    selection !== undefined && findings.every((f) => selection.selected.has(f.id));

  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selection && (
            <TableHead className="w-10">
              <Checkbox
                checked={allSelected}
                onCheckedChange={selection.onToggleAll}
                aria-label="Select all shown findings"
              />
            </TableHead>
          )}
          <TableHead>Severity</TableHead>
          <TableHead>Finding</TableHead>
          {showTarget && <TableHead>Target</TableHead>}
          <TableHead>Diff</TableHead>
          <TableHead>Triage</TableHead>
          <TableHead className="text-right">CVSS</TableHead>
          <TableHead className="text-right">EPSS</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {findings.map((finding) => (
          <TableRow
            key={finding.id}
            className="cursor-pointer"
            onClick={() => navigate(`/findings/${finding.id}`)}
          >
            {selection && (
              <TableCell onClick={(event) => event.stopPropagation()}>
                <Checkbox
                  checked={selection.selected.has(finding.id)}
                  onCheckedChange={() => selection.onToggle(finding.id)}
                  aria-label={`Select ${finding.name}`}
                />
              </TableCell>
            )}
            <TableCell>
              <SeverityBadge severity={finding.severity} />
            </TableCell>
            <TableCell className="max-w-md">
              <div className="flex flex-col">
                {/* The row click is a pointer affordance only; the link is
                    what reaches the finding by keyboard (SRS 3.2.1). */}
                <Link
                  to={`/findings/${finding.id}`}
                  className="text-sm font-medium transition-colors hover:text-primary"
                  onClick={(event) => event.stopPropagation()}
                >
                  {finding.name}
                </Link>
                <span className="truncate font-mono text-xs text-muted-foreground">
                  {finding.detectorId} · {finding.affectedUrl}
                </span>
              </div>
            </TableCell>
            {showTarget && (
              <TableCell className="text-sm">{finding.target.label}</TableCell>
            )}
            <TableCell>
              <DiffBadge status={finding.diffStatus} />
            </TableCell>
            <TableCell>
              <TriageBadge state={finding.triage.state} />
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {formatCvss(finding.cvssScore)}
            </TableCell>
            <TableCell className="text-right font-mono text-sm">
              {formatEpss(finding.epssScore)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
