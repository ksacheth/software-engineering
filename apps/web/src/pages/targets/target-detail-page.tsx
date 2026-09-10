import { useState } from 'react';
import { useParams, Link, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getTarget,
  archiveTarget,
  deleteTarget,
} from '@/services/targets';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import { Spinner } from '@/components/ui/spinner';
import { ScannableBadge } from './components/scannable-badge';
import { VerificationStatusBadge } from './components/verification-status-badge';
import { VerificationInstructionsCard } from './components/verification-instructions-card';
import { ScopeEditor } from './components/scope-editor';
import { VerifiedIpSetCard } from './components/verified-ip-set-card';
import { StartScanDialog } from '../scans/start-scan-dialog';
import { useCanWrite } from '@/lib/use-role';
import {
  ArrowLeft,
  ExternalLink,
  Archive,
  Trash2,
  Clock,
  ShieldCheck,
  KeyRound,
} from 'lucide-react';
import { toast } from 'sonner';

export function TargetDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const canWrite = useCanWrite();
  const [showReverify, setShowReverify] = useState(false);

  const { data, isLoading, error } = useQuery({
    queryKey: ['target', id],
    queryFn: () => getTarget(id!),
    enabled: Boolean(id),
  });

  const archiveMutation = useMutation({
    mutationFn: () => archiveTarget(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['target', id] });
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      toast.success('Target archived');
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to archive target');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteTarget(id!),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      toast.success('Target deleted');
      navigate('/targets');
    },
    onError: (err: unknown) => {
      toast.error(err instanceof Error ? err.message : 'Failed to delete target');
    },
  });

  if (isLoading) {
    return (
      <div className="flex h-96 items-center justify-center">
        <Spinner className="size-8" />
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex flex-col gap-4 p-6 max-w-6xl mx-auto">
        <Alert variant="destructive">
          <AlertTitle>Error loading target</AlertTitle>
          <AlertDescription>
            {error instanceof Error ? error.message : 'Target could not be found.'}
          </AlertDescription>
        </Alert>
        <Button variant="outline" asChild className="w-fit">
          <Link to="/targets">
            <ArrowLeft data-icon="inline-start" />
            Back to Targets
          </Link>
        </Button>
      </div>
    );
  }

  const { target, instructions, scannable } = data;

  // Expiry check: show warning band when verificationExpiresAt is under 14 days away (display only, not a verdict)
  const now = Date.now();
  const expiresAtMs = target.verificationExpiresAt ? new Date(target.verificationExpiresAt).getTime() : null;
  const msRemaining = expiresAtMs !== null ? expiresAtMs - now : null;
  const daysRemaining = msRemaining !== null ? Math.ceil(msRemaining / (1000 * 60 * 60 * 24)) : null;
  const isExpiringSoon =
    target.verificationStatus === 'VERIFIED' &&
    msRemaining !== null &&
    msRemaining > 0 &&
    msRemaining <= 14 * 24 * 60 * 60 * 1000;

  const isVerified = target.verificationStatus === 'VERIFIED';

  return (
    <div className="flex flex-col gap-6 p-6 max-w-6xl mx-auto">
      {/* Top Navigation & Actions Bar */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to="/targets" className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <ArrowLeft data-icon="inline-start" />
            Back to Targets
          </Link>
        </Button>

        <div className="flex items-center gap-2">
          {!target.isArchived && (
            <Button
              variant="outline"
              size="sm"
              onClick={() => archiveMutation.mutate()}
              disabled={archiveMutation.isPending}
            >
              {archiveMutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <Archive data-icon="inline-start" />
              )}
              Archive Target
            </Button>
          )}

          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="sm" className="text-destructive hover:bg-destructive/10 border-destructive/30">
                <Trash2 data-icon="inline-start" />
                Delete Target
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete target?</AlertDialogTitle>
                <AlertDialogDescription>
                  This action is permanent and cannot be undone. Target <span className="font-semibold">{target.origin}</span>, along with all associated scan records and findings, will be removed.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => deleteMutation.mutate()}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  {deleteMutation.isPending && <Spinner data-icon="inline-start" />}
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </div>
      </div>

      {/* Target Title & Metadata Header */}
      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-bold tracking-tight">{target.label}</h1>
              <VerificationStatusBadge status={target.verificationStatus} />
              <ScannableBadge scannable={scannable} showReasonText />
            </div>
            <a
              href={target.origin}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1 text-sm font-mono text-muted-foreground hover:text-foreground hover:underline w-fit"
            >
              {target.origin}
              <ExternalLink className="size-3.5" />
            </a>
          </div>

          <div className="flex items-center gap-2">
            {canWrite && <StartScanDialog target={target} scannable={scannable} />}
            <Button variant="secondary" size="sm" asChild>
              <Link to={`/targets/${target.id}/verify`}>
                <KeyRound data-icon="inline-start" />
                Verification Instructions
              </Link>
            </Button>
          </div>
        </div>

        {target.isArchived && (
          <Alert variant="destructive" className="mt-4">
            <Archive className="size-4" />
            <AlertTitle>Target Archived</AlertTitle>
            <AlertDescription>
              This target is archived. Scanning and verification operations are disabled.
            </AlertDescription>
          </Alert>
        )}

        {/* 14-day Expiry Warning Band */}
        {isExpiringSoon && (
          <Alert className="mt-4 border-amber-500/30 bg-amber-500/10 text-amber-950 dark:text-amber-200">
            <Clock className="size-4 text-amber-600 dark:text-amber-400" />
            <AlertTitle className="font-semibold text-amber-900 dark:text-amber-300">
              Ownership Verification Expiring Soon
            </AlertTitle>
            <AlertDescription className="text-amber-800 dark:text-amber-200">
              Ownership verification expires in {daysRemaining} day{daysRemaining === 1 ? '' : 's'} (on{' '}
              {new Date(target.verificationExpiresAt!).toLocaleDateString(undefined, {
                dateStyle: 'medium',
              })}
              ). Per C.2, scanning is refused once verification lapses. Re-verify ownership to avoid interruption.
            </AlertDescription>
          </Alert>
        )}
      </div>

      {/* Verification Instructions & Challenge (Shown when not verified or when toggled) */}
      {(!isVerified || showReverify) && (
        <VerificationInstructionsCard
          target={target}
          instructions={instructions}
          scannable={scannable}
          onVerified={() => setShowReverify(false)}
        />
      )}

      {/* Overview Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Verification & Expiry Summary Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Clock className="size-5 text-primary" />
              Verification Lifecycle
            </CardTitle>
            <CardDescription>
              Ownership proof validity and challenge details.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex justify-between py-1.5 border-b border-border text-sm">
              <span className="text-muted-foreground">Method</span>
              <span className="font-mono text-xs font-medium">
                {target.verificationMethod === 'DNS_TXT' ? 'DNS TXT Record' : 'Well-Known File'}
              </span>
            </div>

            <div className="flex justify-between py-1.5 border-b border-border text-sm">
              <span className="text-muted-foreground">Status</span>
              <VerificationStatusBadge status={target.verificationStatus} />
            </div>

            <div className="flex justify-between py-1.5 border-b border-border text-sm">
              <span className="text-muted-foreground">Verified At</span>
              <span className="text-xs font-mono">
                {target.verifiedAt
                  ? new Date(target.verifiedAt).toLocaleString()
                  : '—'}
              </span>
            </div>

            <div className="flex justify-between py-1.5 border-b border-border text-sm">
              <span className="text-muted-foreground">Verification Expiry</span>
              <span className="text-xs font-mono">
                {target.verificationExpiresAt
                  ? new Date(target.verificationExpiresAt).toLocaleString()
                  : '—'}
              </span>
            </div>

            {isVerified && !showReverify && (
              <div className="pt-2 flex justify-end">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowReverify(true)}
                >
                  <KeyRound data-icon="inline-start" />
                  Re-verify / View Instructions
                </Button>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Legal Attestation Card */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <ShieldCheck className="size-5 text-primary" />
              Authorisation Acknowledgement
            </CardTitle>
            <CardDescription>
              Recorded legal attestation of authority to scan this target.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex justify-between py-1.5 border-b border-border text-sm">
              <span className="text-muted-foreground">Attestation</span>
              <span className="font-medium text-emerald-600 dark:text-emerald-400">
                Acknowledged
              </span>
            </div>

            <div className="flex justify-between py-1.5 border-b border-border text-sm">
              <span className="text-muted-foreground">Attested At</span>
              <span className="text-xs font-mono">
                {target.authorisationAckAt
                  ? new Date(target.authorisationAckAt).toLocaleString()
                  : '—'}
              </span>
            </div>

            <p className="text-xs text-muted-foreground leading-relaxed pt-1">
              The user has legally attested that they own or have written permission from the owner to conduct security tests against this target, and acknowledged that unauthorised scanning is a criminal offence. Recorded once at registration and not editable.
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Verified IP Set */}
      <VerifiedIpSetCard target={target} />

      {/* Scope Editor */}
      <ScopeEditor target={target} />
    </div>
  );
}
