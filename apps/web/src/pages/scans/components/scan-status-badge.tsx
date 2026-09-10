import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { isTerminalScanStatus, type ScanStatus } from '@wvs/shared';

const LABELS: Record<ScanStatus, string> = {
  QUEUED: 'Queued',
  RUNNING: 'Running',
  PAUSED: 'Paused',
  COMPLETED: 'Completed',
  FAILED: 'Failed',
  CANCELLED: 'Cancelled',
  ABORTED_SAFETY: 'Aborted (safety)',
};

const CLASSES: Record<ScanStatus, string> = {
  QUEUED: '',
  RUNNING: 'border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300',
  PAUSED: 'border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300',
  COMPLETED:
    'border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300',
  FAILED: 'border-destructive/30 bg-destructive/10 text-destructive',
  CANCELLED: 'text-muted-foreground',
  ABORTED_SAFETY: 'border-destructive/30 bg-destructive/10 text-destructive',
};

export function ScanStatusBadge({ status }: { status: ScanStatus }) {
  return (
    <Badge
      variant={status === 'QUEUED' || status === 'CANCELLED' ? 'secondary' : 'outline'}
      className={cn('cursor-default', CLASSES[status])}
    >
      {LABELS[status]}
    </Badge>
  );
}

export function isFinished(status: ScanStatus): boolean {
  return isTerminalScanStatus(status);
}
