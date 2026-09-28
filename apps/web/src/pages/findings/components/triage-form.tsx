import { useId, useState, type FormEvent } from "react";
import {
  JUSTIFIED_TRIAGE_STATES,
  TRIAGE_STATES,
  type TriageState,
} from "@wvs/shared";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { TriageInput } from "@/services/findings";
import { TRIAGE_LABELS } from "./finding-badges";

/**
 * Choose a triage state and, where it hides risk, say why.
 *
 * The justification rule mirrors the API's so the user is told before
 * submitting; the API still enforces it.
 */

const TRIAGE_HINTS: Record<TriageState, string> = {
  OPEN: "Not yet judged, or reopened.",
  CONFIRMED: "A real issue that needs fixing.",
  FALSE_POSITIVE: "Not a real issue. Hidden from the default list.",
  ACCEPTED_RISK: "Real, but accepted. Hidden from the default list.",
  RESOLVED: "You believe it is fixed. The next scan will show whether it is gone.",
};

export const MAX_JUSTIFICATION_LENGTH = 2000;

export function needsJustification(state: TriageState): boolean {
  return JUSTIFIED_TRIAGE_STATES.includes(state);
}

interface TriageFormProps {
  initialState?: TriageState;
  initialJustification?: string | null;
  submitLabel: string;
  pending: boolean;
  /** A refusal from the API, shown under the form. */
  error?: string | null;
  onSubmit: (input: TriageInput) => void;
}

export function TriageForm({
  initialState = "OPEN",
  initialJustification,
  submitLabel,
  pending,
  error,
  onSubmit,
}: TriageFormProps) {
  const id = useId();
  const [state, setState] = useState<TriageState>(initialState);
  const [justification, setJustification] = useState(
    initialJustification ?? "",
  );
  const [touched, setTouched] = useState(false);

  const required = needsJustification(state);
  const missing = required && justification.trim().length === 0;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (missing) return;
    const trimmed = justification.trim();
    onSubmit({ state, ...(trimmed ? { justification: trimmed } : {}) });
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={submit} noValidate>
      <FieldSet>
        <FieldLegend variant="label">Triage state</FieldLegend>
        <RadioGroup
          value={state}
          onValueChange={(value) => setState(value as TriageState)}
        >
          {TRIAGE_STATES.map((option) => (
            <label
              key={option}
              htmlFor={`${id}-${option}`}
              className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-2.5"
            >
              <RadioGroupItem
                value={option}
                id={`${id}-${option}`}
                className="mt-0.5"
              />
              <span className="flex flex-col gap-0.5">
                <span className="text-sm font-medium">
                  {TRIAGE_LABELS[option]}
                </span>
                <span className="text-xs text-muted-foreground">
                  {TRIAGE_HINTS[option]}
                </span>
              </span>
            </label>
          ))}
        </RadioGroup>
      </FieldSet>

      <Field data-invalid={touched && missing ? true : undefined}>
        <FieldLabel htmlFor={`${id}-justification`}>
          Justification{required ? " (required)" : " (optional)"}
        </FieldLabel>
        <Textarea
          id={`${id}-justification`}
          value={justification}
          maxLength={MAX_JUSTIFICATION_LENGTH}
          aria-invalid={touched && missing ? true : undefined}
          onChange={(event) => setJustification(event.target.value)}
          placeholder={
            required
              ? "Why is this safe to hide? This carries forward to later scans."
              : "Context for whoever reads this next."
          }
        />
        <FieldDescription>
          Recorded with your name in the triage history and the audit log.
        </FieldDescription>
        {touched && missing && (
          <FieldError>
            A justification is required to mark a finding{" "}
            {TRIAGE_LABELS[state].toLowerCase()}.
          </FieldError>
        )}
      </Field>

      {error && <FieldError>{error}</FieldError>}

      <Button type="submit" disabled={pending} className="w-fit">
        {pending && <Spinner data-icon="inline-start" />}
        {submitLabel}
      </Button>
    </form>
  );
}
