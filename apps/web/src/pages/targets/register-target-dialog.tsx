import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { FieldGroup, Field, FieldLabel, FieldDescription, FieldSet, FieldLegend, FieldContent } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { AlertCircle, Plus, ShieldCheck } from 'lucide-react';
import {
  registerTarget,
  type VerificationMethod,
  TargetApiError,
} from '@/services/targets';

interface RegisterTargetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function RegisterTargetDialog({ open, onOpenChange }: RegisterTargetDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [origin, setOrigin] = useState('');
  const [label, setLabel] = useState('');
  const [verificationMethod, setVerificationMethod] = useState<VerificationMethod>('DNS_TXT');
  const [authorisationAck, setAuthorisationAck] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const resetForm = () => {
    setOrigin('');
    setLabel('');
    setVerificationMethod('DNS_TXT');
    setAuthorisationAck(false);
    setErrorMessage(null);
  };

  const registerMutation = useMutation({
    mutationFn: registerTarget,
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ['targets'] });
      resetForm();
      onOpenChange(false);
      // On 201, go straight to the verification screen
      navigate(`/targets/${data.target.id}/verify`);
    },
    onError: (err: unknown) => {
      if (err instanceof TargetApiError) {
        setErrorMessage(err.message);
      } else {
        setErrorMessage(err instanceof Error ? err.message : 'Registration failed');
      }
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!authorisationAck || !origin.trim() || !label.trim()) return;

    setErrorMessage(null);
    registerMutation.mutate({
      origin: origin.trim(),
      label: label.trim(),
      verificationMethod,
      authorisationAck: true,
      includedPaths: [],
      excludedPaths: [],
    });
  };

  const isSubmitDisabled =
    !authorisationAck ||
    !origin.trim() ||
    !label.trim() ||
    registerMutation.isPending;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        if (!isOpen) resetForm();
        onOpenChange(isOpen);
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Plus className="size-5 text-primary" />
            Register Target
          </DialogTitle>
          <DialogDescription>
            Register a new web origin for ownership verification and security testing.
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          {errorMessage && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Registration Refused</AlertTitle>
              <AlertDescription>{errorMessage}</AlertDescription>
            </Alert>
          )}

          <FieldGroup>
            {/* Target Label */}
            <Field>
              <FieldLabel htmlFor="target-label">Target Label</FieldLabel>
              <Input
                id="target-label"
                placeholder="e.g. Production Application, Staging API"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
              />
              <FieldDescription>
                A human-friendly name to identify this target.
              </FieldDescription>
            </Field>

            {/* Target Origin */}
            <Field>
              <FieldLabel htmlFor="target-origin">Origin URL</FieldLabel>
              <Input
                id="target-origin"
                placeholder="https://example.com"
                value={origin}
                onChange={(e) => setOrigin(e.target.value)}
                required
              />
              <FieldDescription>
                Canonical URL scheme and host (http:// or https://). No path, query parameters, or IP literals.
              </FieldDescription>
            </Field>

            {/* Verification Method Radio Group */}
            <FieldSet>
              <FieldLegend variant="label">Verification Method</FieldLegend>
              <RadioGroup
                value={verificationMethod}
                onValueChange={(val) => setVerificationMethod(val as VerificationMethod)}
              >
                <Field orientation="horizontal" className="items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted/50 cursor-pointer">
                  <RadioGroupItem value="DNS_TXT" id="method-dns" className="mt-0.5" />
                  <FieldContent>
                    <FieldLabel htmlFor="method-dns" className="font-medium cursor-pointer">
                      DNS TXT Record (Recommended)
                    </FieldLabel>
                    <FieldDescription className="text-xs">
                      Publish a TXT record at _wvs-verification.&lt;hostname&gt;. Works for all hosting providers.
                    </FieldDescription>
                  </FieldContent>
                </Field>

                <Field orientation="horizontal" className="items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted/50 cursor-pointer">
                  <RadioGroupItem value="WELL_KNOWN" id="method-wellknown" className="mt-0.5" />
                  <FieldContent>
                    <FieldLabel htmlFor="method-wellknown" className="font-medium cursor-pointer">
                      Well-Known File
                    </FieldLabel>
                    <FieldDescription className="text-xs">
                      Host a static verification token file at /.well-known/wvs-verification.txt.
                    </FieldDescription>
                  </FieldContent>
                </Field>
              </RadioGroup>
            </FieldSet>

            {/* Authorisation Acknowledgement Legal Attestation */}
            <Field
              orientation="horizontal"
              className="items-start gap-3 rounded-lg border border-border bg-muted/20 p-3.5"
            >
              <Checkbox
                id="authorisation-ack"
                checked={authorisationAck}
                onCheckedChange={(checked) => setAuthorisationAck(checked === true)}
                className="mt-0.5"
              />
              <FieldContent>
                <FieldLabel
                  htmlFor="authorisation-ack"
                  className="font-medium cursor-pointer flex items-center gap-1.5"
                >
                  <ShieldCheck className="size-4 text-primary" />
                  Authorisation Acknowledgement
                </FieldLabel>
                <FieldDescription className="text-xs leading-relaxed text-foreground/90">
                  I attest that I own this target or possess explicit written permission from the owner to conduct security scanning against it. I acknowledge that unauthorised security testing and scanning of computer systems is a criminal offence.
                </FieldDescription>
                <span className="text-[11px] text-muted-foreground mt-1">
                  This attestation is permanently recorded once upon registration and cannot be edited.
                </span>
              </FieldContent>
            </Field>
          </FieldGroup>

          <DialogFooter className="gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={isSubmitDisabled}
            >
              {registerMutation.isPending && <Spinner data-icon="inline-start" />}
              Register & Continue
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
