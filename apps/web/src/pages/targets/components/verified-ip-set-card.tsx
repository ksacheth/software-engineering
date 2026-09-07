import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Network, AlertCircle, ShieldCheck } from 'lucide-react';
import type { Target } from '@/services/targets';

interface VerifiedIpSetCardProps {
  target: Target;
}

export function VerifiedIpSetCard({ target }: VerifiedIpSetCardProps) {
  const addresses = target.verifiedIpRanges ?? [];
  const hasAddresses = addresses.length > 0;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Network className="size-5 text-primary" />
          Verified IP Set
        </CardTitle>
        <CardDescription>
          Literal IPv4 (/32) and IPv6 (/128) addresses resolved during ownership verification. The Scope Guard pins outgoing scan traffic strictly to these addresses to prevent DNS rebinding attacks (ADR 0004).
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {hasAddresses ? (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap gap-2">
              {addresses.map((cidr) => (
                <Badge
                  key={cidr}
                  variant="outline"
                  className="font-mono text-xs px-2.5 py-1 bg-muted/40 border-border"
                >
                  <ShieldCheck className="size-3 text-emerald-600 mr-1" />
                  {cidr}
                </Badge>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              If the target&apos;s hosting or DNS configuration changes, ownership must be re-verified to update this set.
            </p>
          </div>
        ) : (
          <Alert>
            <AlertCircle className="size-4 text-muted-foreground" />
            <AlertTitle>No Verified Addresses (Fails Closed)</AlertTitle>
            <AlertDescription>
              This target does not yet have any recorded addresses. Per C.2 and ADR 0004, the Scope Guard fails closed and disallows all scans until ownership verification succeeds.
            </AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
