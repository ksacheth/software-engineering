import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { fetchTargets } from '@/services/targets';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Label } from '@/components/ui/label';
import {
  Table,
  TableHeader,
  TableBody,
  TableHead,
  TableRow,
  TableCell,
} from '@/components/ui/table';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
  EmptyMedia,
} from '@/components/ui/empty';
import { Spinner } from '@/components/ui/spinner';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { ScannableBadge } from './components/scannable-badge';
import { VerificationStatusBadge } from './components/verification-status-badge';
import { RegisterTargetDialog } from './register-target-dialog';
import {
  Plus,
  ShieldAlert,
  ExternalLink,
  Clock,
  KeyRound,
  ArrowRight,
} from 'lucide-react';

export function TargetsPage() {
  const [includeArchived, setIncludeArchived] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['targets', { includeArchived }],
    queryFn: () => fetchTargets(includeArchived),
  });

  const targets = data?.targets ?? [];

  const now = Date.now();

  return (
    <div className="flex flex-col gap-6 p-6 max-w-7xl mx-auto">
      {/* Header Section */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Targets</h1>
          <p className="text-sm text-muted-foreground">
            Manage registered target origins, prove ownership, and configure scan scope.
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="include-archived"
              checked={includeArchived}
              onCheckedChange={setIncludeArchived}
            />
            <Label htmlFor="include-archived" className="text-xs text-muted-foreground cursor-pointer">
              Show archived
            </Label>
          </div>

          <Button onClick={() => setRegisterOpen(true)}>
            <Plus data-icon="inline-start" />
            Register Target
          </Button>
        </div>
      </div>

      {/* Error state */}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>Failed to load targets</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Could not fetch targets.'}
          </AlertDescription>
        </Alert>
      )}

      {/* Loading state */}
      {isLoading && (
        <div className="flex h-64 items-center justify-center">
          <Spinner className="size-8" />
        </div>
      )}

      {/* Empty State */}
      {!isLoading && !error && targets.length === 0 && (
        <div className="rounded-xl border border-dashed border-border bg-card p-12">
          <Empty>
            <EmptyMedia variant="icon">
              <ShieldAlert className="size-5 text-muted-foreground" />
            </EmptyMedia>
            <EmptyHeader>
              <EmptyTitle>No targets registered</EmptyTitle>
              <EmptyDescription>
                {includeArchived
                  ? 'No targets match the current filter.'
                  : 'Register a target origin to verify administrative control and begin scanning.'}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button onClick={() => setRegisterOpen(true)}>
                <Plus data-icon="inline-start" />
                Register Target
              </Button>
            </EmptyContent>
          </Empty>
        </div>
      )}

      {/* Targets Table */}
      {!isLoading && !error && targets.length > 0 && (
        <div className="rounded-xl border border-border bg-card overflow-hidden shadow-xs">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[240px]">Label</TableHead>
                <TableHead>Origin</TableHead>
                <TableHead className="w-[140px]">Verification</TableHead>
                <TableHead className="w-[180px]">Expiry</TableHead>
                <TableHead className="w-[160px]">Scannable</TableHead>
                <TableHead className="text-right w-[160px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {targets.map((target) => {
                const expiresAtMs = target.verificationExpiresAt
                  ? new Date(target.verificationExpiresAt).getTime()
                  : null;
                const msRemaining = expiresAtMs !== null ? expiresAtMs - now : null;
                const isExpiringSoon =
                  target.verificationStatus === 'VERIFIED' &&
                  msRemaining !== null &&
                  msRemaining > 0 &&
                  msRemaining <= 14 * 24 * 60 * 60 * 1000;

                return (
                  <TableRow key={target.id} className={target.isArchived ? 'opacity-60' : undefined}>
                    {/* Label */}
                    <TableCell className="font-medium">
                      <div className="flex flex-col">
                        <Link
                          to={`/targets/${target.id}`}
                          className="font-medium hover:text-primary transition-colors"
                        >
                          {target.label}
                        </Link>
                        {target.isArchived && (
                          <span className="text-[11px] text-muted-foreground italic">Archived</span>
                        )}
                      </div>
                    </TableCell>

                    {/* Origin */}
                    <TableCell>
                      <a
                        href={target.origin}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="font-mono text-xs text-muted-foreground hover:text-foreground hover:underline inline-flex items-center gap-1"
                      >
                        {target.origin}
                        <ExternalLink className="size-3" />
                      </a>
                    </TableCell>

                    {/* Verification Status */}
                    <TableCell>
                      <VerificationStatusBadge status={target.verificationStatus} />
                    </TableCell>

                    {/* Expiry */}
                    <TableCell>
                      {target.verificationExpiresAt ? (
                        <div className="flex items-center gap-1.5 text-xs">
                          {isExpiringSoon && (
                            <Clock className="size-3.5 text-amber-600 dark:text-amber-400 shrink-0" />
                          )}
                          <span
                            className={
                              isExpiringSoon
                                ? 'font-medium text-amber-700 dark:text-amber-300'
                                : 'text-muted-foreground'
                            }
                          >
                            {new Date(target.verificationExpiresAt).toLocaleDateString(undefined, {
                              dateStyle: 'medium',
                            })}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </TableCell>

                    {/* Scannable Badge */}
                    <TableCell>
                      <ScannableBadge scannable={target.scannable} />
                    </TableCell>

                    {/* Actions */}
                    <TableCell className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        {target.verificationStatus !== 'VERIFIED' && !target.isArchived && (
                          <Button variant="outline" size="sm" asChild>
                            <Link to={`/targets/${target.id}/verify`}>
                              <KeyRound data-icon="inline-start" />
                              Verify
                            </Link>
                          </Button>
                        )}
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/targets/${target.id}`}>
                            Details
                            <ArrowRight data-icon="inline-end" />
                          </Link>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Register Dialog */}
      <RegisterTargetDialog open={registerOpen} onOpenChange={setRegisterOpen} />
    </div>
  );
}
