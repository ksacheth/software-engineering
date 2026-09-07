import { useParams, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { getTarget } from '@/services/targets';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { VerificationStatusBadge } from './components/verification-status-badge';
import { ScannableBadge } from './components/scannable-badge';
import { VerificationInstructionsCard } from './components/verification-instructions-card';
import { ArrowLeft, ExternalLink } from 'lucide-react';

export function TargetVerifyPage() {
  const { id } = useParams<{ id: string }>();

  const { data, isLoading, error } = useQuery({
    queryKey: ['target', id],
    queryFn: () => getTarget(id!),
    enabled: Boolean(id),
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
      <div className="flex flex-col gap-4 p-6 max-w-4xl mx-auto">
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

  return (
    <div className="flex flex-col gap-6 p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between gap-4">
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/targets/${target.id}`} className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground">
            <ArrowLeft data-icon="inline-start" />
            Back to Target Details
          </Link>
        </Button>

        <Button variant="outline" size="sm" asChild>
          <Link to="/targets">
            All Targets
          </Link>
        </Button>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-border bg-card p-6 shadow-xs">
        <div className="flex flex-wrap items-center justify-between gap-4">
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
        </div>
      </div>

      <VerificationInstructionsCard
        target={target}
        instructions={instructions}
        scannable={scannable}
      />
    </div>
  );
}
