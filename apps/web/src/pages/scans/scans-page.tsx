import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { SCAN_STATUSES, type ScanStatus } from '@wvs/shared';
import { fetchScans } from '@/services/scans';
import { fetchTargets } from '@/services/targets';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { ScanStatusBadge } from './components/scan-status-badge';
import { Radar, ArrowRight } from 'lucide-react';

const ALL = 'ALL';

function formatStarted(scan: { startedAt: string | null; queuedAt: string }): string {
  const value = scan.startedAt ?? scan.queuedAt;
  return new Date(value).toLocaleString(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

export function ScansPage() {
  const navigate = useNavigate();
  const [targetId, setTargetId] = useState<string>(ALL);
  const [status, setStatus] = useState<string>(ALL);

  const targetsQuery = useQuery({
    queryKey: ['targets'],
    queryFn: () => fetchTargets(true),
  });

  const scansQuery = useInfiniteQuery({
    queryKey: ['scans', { targetId, status }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      fetchScans(
        {
          targetId: targetId === ALL ? undefined : targetId,
          status: status === ALL ? undefined : (status as ScanStatus),
        },
        pageParam,
      ),
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    // A scan list shows work in progress, so it refreshes without a socket.
    refetchInterval: 10_000,
  });

  const scans = scansQuery.data?.pages.flatMap((page) => page.scans) ?? [];

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Scans</h1>
          <p className="text-sm text-muted-foreground">
            Every scan this organisation has run, newest first.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <Select value={targetId} onValueChange={setTargetId}>
            <SelectTrigger className="w-56" aria-label="Filter by target">
              <SelectValue placeholder="All targets" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All targets</SelectItem>
              {(targetsQuery.data?.targets ?? []).map((target) => (
                <SelectItem key={target.id} value={target.id}>
                  {target.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-44" aria-label="Filter by status">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>All statuses</SelectItem>
              {SCAN_STATUSES.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {scansQuery.error && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load scans</AlertTitle>
          <AlertDescription>
            {scansQuery.error instanceof Error
              ? scansQuery.error.message
              : 'Could not fetch scans.'}
          </AlertDescription>
        </Alert>
      )}

      {scansQuery.isLoading && (
        <div className="flex h-64 items-center justify-center">
          <Spinner className="size-8" />
        </div>
      )}

      {!scansQuery.isLoading && !scansQuery.error && scans.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-12">
          <Empty>
            <EmptyMedia variant="icon">
              <Radar className="size-5 text-muted-foreground" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No scans yet</EmptyTitle>
              <EmptyDescription>
                Open a verified target and start a scan to see its progress here.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link to="/targets">
                  Go to Targets
                  <ArrowRight data-icon="inline-end" />
                </Link>
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      )}

      {scans.length > 0 && (
        <div className="rounded-xl border border-border bg-card">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Target</TableHead>
                <TableHead>Profile</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Started</TableHead>
                <TableHead className="text-right">Findings</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {scans.map((scan) => (
                <TableRow
                  key={scan.id}
                  className="cursor-pointer"
                  onClick={() => navigate(`/scans/${scan.id}`)}
                >
                  <TableCell>
                    <div className="flex flex-col">
                      <span className="text-sm font-medium">
                        {scan.target?.label ?? 'Deleted target'}
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {scan.target?.origin ?? scan.targetId}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-sm">{scan.profile}</TableCell>
                  <TableCell>
                    <ScanStatusBadge status={scan.status} />
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatStarted(scan)}
                  </TableCell>
                  <TableCell className="text-right text-sm">
                    {scan.findingsCount}
                    {scan.failureReason ? (
                      <span className="ml-2 text-xs text-destructive">failed</span>
                    ) : null}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>

          {scansQuery.hasNextPage && (
            <div className="flex justify-center border-t border-border p-4">
              <Button
                variant="outline"
                onClick={() => void scansQuery.fetchNextPage()}
                disabled={scansQuery.isFetchingNextPage}
              >
                {scansQuery.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
