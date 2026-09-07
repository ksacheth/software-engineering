import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { NotScannableReason, ScannableVerdict } from '@/services/targets';

interface ScannableBadgeProps {
  scannable: ScannableVerdict;
  showReasonText?: boolean;
}

export function formatNotScannableReason(reason?: NotScannableReason | string): string {
  switch (reason) {
    case 'ARCHIVED':
      return 'Target is archived';
    case 'NOT_VERIFIED':
      return 'Ownership not verified';
    case 'VERIFICATION_FAILED':
      return 'Verification challenge failed';
    case 'VERIFICATION_EXPIRED':
      return 'Verification expired (>90 days)';
    case 'NO_VERIFIED_ADDRESSES':
      return 'No verified addresses recorded (fails closed)';
    case 'AUTHORISATION_NOT_ACKNOWLEDGED':
      return 'Authorisation not acknowledged';
    default:
      return reason ? reason.replace(/_/g, ' ') : 'Not scannable';
  }
}

export function ScannableBadge({ scannable, showReasonText = false }: ScannableBadgeProps) {
  const isScannable = scannable.scannable;
  const reasonText = !isScannable ? formatNotScannableReason(scannable.reason) : undefined;

  const badgeElement = (
    <Badge
      variant={isScannable ? 'default' : 'secondary'}
      className="cursor-default"
    >
      {isScannable ? 'Scannable' : 'Not Scannable'}
    </Badge>
  );

  return (
    <div className="inline-flex items-center gap-2">
      {reasonText ? (
        <Tooltip>
          <TooltipTrigger asChild>{badgeElement}</TooltipTrigger>
          <TooltipContent>
            <p className="text-xs">{reasonText}</p>
          </TooltipContent>
        </Tooltip>
      ) : (
        badgeElement
      )}
      {showReasonText && reasonText && (
        <span className="text-xs text-muted-foreground">{reasonText}</span>
      )}
    </div>
  );
}
