import { useEffect, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ShieldCheck } from "lucide-react";
import { fetchFindings } from "@/services/findings";
import { fetchTargets } from "@/services/targets";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { useCanWrite } from "@/lib/use-role";
import {
  FindingsFilterBar,
  INITIAL_FILTERS,
  toFindingFilters,
  type FilterState,
} from "./findings-filter-bar";
import { FindingsResultTable } from "./findings-result-table";
import { BulkTriageDialog } from "./bulk-triage-dialog";

/**
 * The findings list (F.6): the current posture, or one scan's findings.
 *
 * Every filter goes to the server rather than sifting the page on screen. The
 * list is paged, so a client-side filter would search one page and report
 * nothing for a finding two pages down.
 *
 * In the posture the default triage filter is "needs action" (OPEN and
 * CONFIRMED), with one control to show every state, so nothing a user hid is
 * lost. One scan's findings are shown whole by default: that view is a record
 * of what the scan saw.
 */

function useDebounced<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

function useSelection(resetKey: string) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // A selection only means something for the rows it was made on.
  useEffect(() => setSelected(new Set()), [resetKey]);

  const toggle = (id: string) =>
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return { selected, setSelected, toggle };
}

function NoFindings({ isPosture }: { isPosture: boolean }) {
  return (
    <div className="rounded-xl border border-dashed border-border bg-card p-10">
      <Empty>
        <EmptyMedia variant="icon">
          <ShieldCheck className="size-5 text-muted-foreground" />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle>No findings match</EmptyTitle>
          <EmptyDescription>
            {isPosture
              ? "Nothing in the latest completed scan of any target matches these filters. Findings you marked false positive or accepted are hidden unless you choose All triage states."
              : "This scan recorded no findings that match these filters."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </div>
  );
}

interface FindingsTableProps {
  /** Present: that scan's findings. Absent: the current posture. */
  scanId?: string;
}

export function FindingsTable({ scanId }: FindingsTableProps) {
  const canWrite = useCanWrite();
  const isPosture = !scanId;

  const [state, setState] = useState<FilterState>(INITIAL_FILTERS);
  const [bulkOpen, setBulkOpen] = useState(false);
  const change = (next: Partial<FilterState>) =>
    setState((current) => ({ ...current, ...next }));

  // Text is sent once typing pauses, not on every keystroke.
  const search = useDebounced(state.search);
  const detectorId = useDebounced(state.detectorId);
  const filters = toFindingFilters({ ...state, search, detectorId }, scanId);

  const targetsQuery = useQuery({
    queryKey: ["targets"],
    queryFn: () => fetchTargets(true),
    enabled: isPosture,
  });

  const findingsQuery = useInfiniteQuery({
    queryKey: ["findings", filters],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => fetchFindings(filters, pageParam),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
  });

  const findings = findingsQuery.data?.pages.flatMap((page) => page.findings) ?? [];
  const { selected, setSelected, toggle } = useSelection(JSON.stringify(filters));

  const allSelected = findings.length > 0 && findings.every((f) => selected.has(f.id));
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(findings.map((f) => f.id)));

  const isEmpty =
    !findingsQuery.isLoading && !findingsQuery.error && findings.length === 0;

  return (
    <div className="flex flex-col gap-4">
      <FindingsFilterBar
        value={state}
        onChange={change}
        targets={isPosture ? (targetsQuery.data?.targets ?? []) : undefined}
      />

      {canWrite && selected.size > 0 && (
        <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/40 px-4 py-2">
          <span className="text-sm">{selected.size} selected</span>
          <Button size="sm" onClick={() => setBulkOpen(true)}>
            Set triage…
          </Button>
        </div>
      )}

      {findingsQuery.error && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load findings</AlertTitle>
          <AlertDescription>
            {findingsQuery.error instanceof Error
              ? findingsQuery.error.message
              : "Could not fetch findings."}
          </AlertDescription>
        </Alert>
      )}

      {findingsQuery.isLoading && (
        <div className="flex h-48 items-center justify-center">
          <Spinner className="size-8" />
        </div>
      )}

      {isEmpty && <NoFindings isPosture={isPosture} />}

      {findings.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <FindingsResultTable
            findings={findings}
            showTarget={isPosture}
            selection={
              canWrite ? { selected, onToggle: toggle, onToggleAll: toggleAll } : undefined
            }
          />

          {findingsQuery.hasNextPage && (
            <div className="flex justify-center border-t border-border p-4">
              <Button
                variant="outline"
                onClick={() => void findingsQuery.fetchNextPage()}
                disabled={findingsQuery.isFetchingNextPage}
              >
                {findingsQuery.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}

      <BulkTriageDialog
        findingIds={[...selected]}
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        onRecorded={() => {
          setBulkOpen(false);
          setSelected(new Set());
        }}
      />
    </div>
  );
}
