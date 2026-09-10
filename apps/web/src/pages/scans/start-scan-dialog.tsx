import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  SCAN_CONFIGURATION_BOUNDS,
  SCAN_PROFILE_PRESETS,
  SCAN_PROFILES,
  type ScanConfiguration,
  type ScanProfile,
} from '@wvs/shared';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Checkbox } from '@/components/ui/checkbox';
import { Button } from '@/components/ui/button';
import { Alert, AlertTitle, AlertDescription } from '@/components/ui/alert';
import { Spinner } from '@/components/ui/spinner';
import { Play, AlertCircle } from 'lucide-react';
import { toast } from 'sonner';
import { startScan, ScanApiError } from '@/services/scans';
import type { ScannableVerdict, Target } from '@/services/targets';
import { formatNotScannableReason } from '../targets/components/scannable-badge';

/**
 * Start a scan from the target detail page.
 *
 * The profile presets come from `@wvs/shared`, the same module the API applies
 * authoritatively, so the limits a user sees here are the limits the scan
 * actually runs with. The dialog shows the effective configuration before the
 * user commits, and the server reports every refused value at once.
 */

const PROFILE_SUMMARY: Record<ScanProfile, string> = {
  PASSIVE: 'Gentlest. Small surface, minimum load on a production site.',
  STANDARD: 'The default balance of coverage and time.',
  THOROUGH: 'Widest crawl for a staging or low-traffic target.',
};

const LIMIT_FIELDS: { key: keyof ScanConfiguration; label: string }[] = [
  { key: 'rateLimit', label: 'Requests / second' },
  { key: 'concurrency', label: 'Concurrency' },
  { key: 'maxDepth', label: 'Crawl depth' },
  { key: 'maxPages', label: 'Page ceiling' },
  { key: 'maxRequests', label: 'Request ceiling' },
];

export interface StartScanDialogProps {
  target: Target;
  scannable: ScannableVerdict;
}

export function StartScanDialog({ target, scannable }: StartScanDialogProps) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [profile, setProfile] = useState<ScanProfile>('STANDARD');
  const [customise, setCustomise] = useState(false);
  const [overrides, setOverrides] = useState<Partial<Record<keyof ScanConfiguration, string>>>({});
  const [problems, setProblems] = useState<string[]>([]);

  const effective = useMemo((): ScanConfiguration => {
    const preset = SCAN_PROFILE_PRESETS[profile];
    if (!customise) return preset;

    const resolved = { ...preset };
    for (const { key } of LIMIT_FIELDS) {
      const raw = overrides[key];
      if (raw === undefined || raw.trim() === '') continue;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) resolved[key] = parsed;
    }
    return resolved;
  }, [customise, overrides, profile]);

  const mutation = useMutation({
    mutationFn: () =>
      startScan({
        targetId: target.id,
        profile,
        configuration: customise ? effective : undefined,
      }),
    onSuccess: ({ scan }) => {
      void queryClient.invalidateQueries({ queryKey: ['scans'] });
      setOpen(false);
      toast.success('Scan queued');
      navigate(`/scans/${scan.id}`);
    },
    onError: (error: unknown) => {
      if (error instanceof ScanApiError) {
        setProblems(
          error.errors && error.errors.length > 0
            ? error.errors.map((problem) => problem.detail)
            : [error.message],
        );
        return;
      }
      setProblems([error instanceof Error ? error.message : 'The scan could not be started']);
    },
  });

  const disabledReason = !scannable.scannable
    ? formatNotScannableReason(scannable.reason)
    : undefined;

  return (
    <Dialog
      open={open}
      onOpenChange={(isOpen) => {
        setOpen(isOpen);
        setProblems([]);
      }}
    >
      <DialogTrigger asChild>
        <Button disabled={Boolean(disabledReason)} title={disabledReason}>
          <Play data-icon="inline-start" />
          Start Scan
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Play className="size-5 text-primary" />
            Start a scan of {target.label}
          </DialogTitle>
          <DialogDescription>
            {target.origin}. The profile sets the crawl limits; you can lower them for a
            fragile target, but never above system policy.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            setProblems([]);
            mutation.mutate();
          }}
        >
          {problems.length > 0 && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Scan refused</AlertTitle>
              <AlertDescription>
                <ul className="list-disc pl-4">
                  {problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
              </AlertDescription>
            </Alert>
          )}

          <FieldSet>
            <FieldLegend variant="label">Profile</FieldLegend>
            <RadioGroup
              value={profile}
              onValueChange={(value) => setProfile(value as ScanProfile)}
            >
              {SCAN_PROFILES.map((option) => (
                <label
                  key={option}
                  htmlFor={`profile-${option}`}
                  className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3"
                >
                  <RadioGroupItem value={option} id={`profile-${option}`} className="mt-0.5" />
                  <span className="flex flex-col gap-1">
                    <span className="text-sm font-medium">{option}</span>
                    <span className="text-xs text-muted-foreground">
                      {PROFILE_SUMMARY[option]}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">
                      {SCAN_PROFILE_PRESETS[option].rateLimit} req/s ·{' '}
                      {SCAN_PROFILE_PRESETS[option].maxDepth} deep ·{' '}
                      {SCAN_PROFILE_PRESETS[option].maxPages} pages ·{' '}
                      {SCAN_PROFILE_PRESETS[option].maxRequests} requests
                    </span>
                  </span>
                </label>
              ))}
            </RadioGroup>
          </FieldSet>

          <Field orientation="horizontal">
            <Checkbox
              id="customise-limits"
              checked={customise}
              onCheckedChange={(checked) => setCustomise(checked === true)}
            />
            <div className="flex flex-col gap-1">
              <FieldLabel htmlFor="customise-limits">Customise limits</FieldLabel>
              <FieldDescription>
                Leave a field blank to keep the profile value. Bounds: rate 1-
                {SCAN_CONFIGURATION_BOUNDS.rateLimit.max}/s, depth 1-
                {SCAN_CONFIGURATION_BOUNDS.maxDepth.max}, pages 1-
                {SCAN_CONFIGURATION_BOUNDS.maxPages.max}, requests 1-
                {SCAN_CONFIGURATION_BOUNDS.maxRequests.max}.
              </FieldDescription>
            </div>
          </Field>

          {customise && (
            <FieldGroup>
              {LIMIT_FIELDS.map(({ key, label }) => (
                <Field key={key}>
                  <FieldLabel htmlFor={`limit-${key}`}>{label}</FieldLabel>
                  <Input
                    id={`limit-${key}`}
                    type="number"
                    min={SCAN_CONFIGURATION_BOUNDS[key].min}
                    max={SCAN_CONFIGURATION_BOUNDS[key].max}
                    placeholder={String(SCAN_PROFILE_PRESETS[profile][key])}
                    value={overrides[key] ?? ''}
                    onChange={(event) =>
                      setOverrides((current) => ({ ...current, [key]: event.target.value }))
                    }
                  />
                </Field>
              ))}
            </FieldGroup>
          )}

          <p className="rounded-lg bg-muted px-3 py-2 font-mono text-xs text-muted-foreground">
            Will run with: {effective.rateLimit} req/s · concurrency {effective.concurrency} ·
            depth {effective.maxDepth} · {effective.maxPages} pages · {effective.maxRequests}{' '}
            requests
          </p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={mutation.isPending}>
              {mutation.isPending ? <Spinner data-icon="inline-start" /> : <Play data-icon="inline-start" />}
              Start Scan
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
