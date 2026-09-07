import { useState, useEffect } from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { FieldGroup, Field, FieldLabel, FieldDescription } from '@/components/ui/field';
import { InputGroup, InputGroupInput, InputGroupAddon } from '@/components/ui/input-group';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { CopyButton } from './copy-button';
import { ShieldCheck, AlertCircle, Clock, ExternalLink } from 'lucide-react';
import {
  type VerificationInstructions,
  type Target,
  type ScannableVerdict,
  TargetApiError,
  verifyTarget,
} from '@/services/targets';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';

interface VerificationInstructionsCardProps {
  target: Target;
  instructions: VerificationInstructions;
  scannable?: ScannableVerdict;
  onVerified?: (data: { target: Target; scannable: ScannableVerdict }) => void;
}

export function VerificationInstructionsCard({
  target,
  instructions,
  scannable,
  onVerified,
}: VerificationInstructionsCardProps) {
  const queryClient = useQueryClient();
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number>(0);
  const [verifiedSuccess, setVerifiedSuccess] = useState(false);

  // 429 countdown ticker
  useEffect(() => {
    if (countdown <= 0) return;
    const interval = setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearInterval(interval);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => clearInterval(interval);
  }, [countdown]);

  const verifyMutation = useMutation({
    mutationFn: () => verifyTarget(target.id),
    onSuccess: (data) => {
      setErrorMessage(null);
      setVerifiedSuccess(true);
      toast.success('Target ownership verified successfully!');
      // Invalidate queries per spec
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      queryClient.invalidateQueries({ queryKey: ['target', target.id] });
      onVerified?.(data);
    },
    onError: (err: unknown) => {
      setVerifiedSuccess(false);
      if (err instanceof TargetApiError) {
        setErrorMessage(err.message);

        // 429 rate limit handling
        if (err.status === 429) {
          const retrySec =
            typeof err.rule?.retryAfterSeconds === 'number'
              ? err.rule.retryAfterSeconds
              : 30;
          setCountdown(retrySec);
        }
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Verification request failed');
      }
    },
  });

  const isAlreadyVerified = target.verificationStatus === 'VERIFIED' && scannable?.scannable;

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="text-primary size-5" />
          Ownership Verification
        </CardTitle>
        <CardDescription>
          {instructions.method === 'DNS_TXT'
            ? 'Prove administrative control by creating a DNS TXT record with your DNS provider. Verification will resolve this record and commit the origin’s IP addresses.'
            : 'Prove administrative control by uploading a static verification file to your web server at the well-known URI.'}
        </CardDescription>
      </CardHeader>

      <CardContent className="flex flex-col gap-6">
        {/* Success Alert */}
        {(verifiedSuccess || isAlreadyVerified) && (
          <Alert>
            <ShieldCheck className="size-4 text-emerald-600" />
            <AlertTitle>Target Verified</AlertTitle>
            <AlertDescription>
              Ownership verification is active. The verified IP set has been committed to the Scope Guard and this target is scannable.
            </AlertDescription>
          </Alert>
        )}

        {/* Server Refusal / Failure Message Verbatim */}
        {errorMessage && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>
              {countdown > 0 ? 'Verification Throttled (429)' : 'Verification Failed (422)'}
            </AlertTitle>
            <AlertDescription className="flex flex-col gap-1">
              <span>{errorMessage}</span>
              {countdown > 0 && (
                <span className="font-mono text-xs">
                  Countdown: {countdown}s remaining before you can retry.
                </span>
              )}
            </AlertDescription>
          </Alert>
        )}

        {/* Rate limit warning if active */}
        {countdown > 0 && !errorMessage && (
          <Alert>
            <Clock className="size-4" />
            <AlertTitle>Cooldown Active</AlertTitle>
            <AlertDescription>
              Please wait {countdown}s before retrying verification.
            </AlertDescription>
          </Alert>
        )}

        {/* Instructions Form Fields with Copy Buttons */}
        <FieldGroup>
          {instructions.method === 'DNS_TXT' ? (
            <>
              <Field>
                <FieldLabel htmlFor="record-name">Record Name</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="record-name"
                    readOnly
                    value={instructions.recordName}
                    className="font-mono text-xs"
                  />
                  <InputGroupAddon align="inline-end">
                    <CopyButton value={instructions.recordName} label="Copy Record Name" />
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>
                  Create this TXT record at your DNS host (subdomain under {target.origin}).
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="record-type">Record Type</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="record-type"
                    readOnly
                    value={instructions.recordType}
                    className="font-mono text-xs font-semibold"
                  />
                  <InputGroupAddon align="inline-end">
                    <CopyButton value={instructions.recordType} label="Copy Record Type" />
                  </InputGroupAddon>
                </InputGroup>
              </Field>

              <Field>
                <FieldLabel htmlFor="record-value">Record Value (Token)</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="record-value"
                    readOnly
                    value={instructions.recordValue}
                    className="font-mono text-xs"
                  />
                  <InputGroupAddon align="inline-end">
                    <CopyButton value={instructions.recordValue} label="Copy Token" />
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>
                  Exact CSPRNG proof token. Do not include extra whitespace or quotes.
                </FieldDescription>
              </Field>
            </>
          ) : (
            <>
              <Field>
                <FieldLabel htmlFor="file-url">Verification URL</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="file-url"
                    readOnly
                    value={instructions.url}
                    className="font-mono text-xs"
                  />
                  <InputGroupAddon align="inline-end">
                    <CopyButton value={instructions.url} label="Copy URL" />
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription className="flex items-center gap-1">
                  File must be publicly accessible via HTTP GET at this URL.
                  <a
                    href={instructions.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex items-center gap-0.5 text-primary hover:underline"
                  >
                    Open <ExternalLink className="size-3" />
                  </a>
                </FieldDescription>
              </Field>

              <Field>
                <FieldLabel htmlFor="file-content">File Content (Token)</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="file-content"
                    readOnly
                    value={instructions.content}
                    className="font-mono text-xs"
                  />
                  <InputGroupAddon align="inline-end">
                    <CopyButton value={instructions.content} label="Copy Content" />
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>
                  Serve this exact string with Content-Type: text/plain.
                </FieldDescription>
              </Field>
            </>
          )}
        </FieldGroup>
      </CardContent>

      <CardFooter className="flex items-center justify-between gap-4">
        <p className="text-xs text-muted-foreground">
          {instructions.method === 'DNS_TXT'
            ? 'DNS propagation can take a few moments depending on your TTL.'
            : 'Ensure the endpoint does not redirect to private or internal addresses.'}
        </p>

        <Button
          type="button"
          onClick={() => verifyMutation.mutate()}
          disabled={verifyMutation.isPending || countdown > 0}
        >
          {verifyMutation.isPending && <Spinner data-icon="inline-start" />}
          {countdown > 0 ? `Verify (wait ${countdown}s)` : 'Verify ownership'}
        </Button>
      </CardFooter>
    </Card>
  );
}
