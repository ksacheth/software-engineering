import { Badge } from '@/components/ui/badge';
import type { TargetVerificationStatus } from '@/services/targets';

interface VerificationStatusBadgeProps {
  status: TargetVerificationStatus;
}

export function VerificationStatusBadge({ status }: VerificationStatusBadgeProps) {
  switch (status) {
    case 'VERIFIED':
      return <Badge variant="default">Verified</Badge>;
    case 'PENDING':
      return <Badge variant="outline">Pending</Badge>;
    case 'FAILED':
      return <Badge variant="destructive">Failed</Badge>;
    case 'EXPIRED':
      return <Badge variant="destructive">Expired</Badge>;
    case 'UNVERIFIED':
    default:
      return <Badge variant="secondary">Unverified</Badge>;
  }
}
