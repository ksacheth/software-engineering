import {
  FINDING_SEVERITIES,
  REPORT_FORMATS,
  REPORT_TEMPLATES,
  TRIAGE_STATES,
  type FindingSeverity,
  type ReportFormat,
  type ReportTemplate,
  type TriageState,
} from "@wvs/shared";
import {
  Field,
  FieldDescription,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { TRIAGE_LABELS } from "../findings/components/finding-badges";
import {
  FORMAT_DESCRIPTIONS,
  TEMPLATE_DESCRIPTIONS,
  TEMPLATE_LABELS,
} from "./report-labels";

/** The choices a report request is made of, one controlled field each. */

interface FieldProps<T> {
  value: T;
  onChange: (value: T) => void;
}

export const ANY_SEVERITY = "ANY";
export type SeverityChoice = FindingSeverity | typeof ANY_SEVERITY;

const SEVERITY_OPTIONS = [...FINDING_SEVERITIES].reverse();

export function TemplateField({ value, onChange }: FieldProps<ReportTemplate>) {
  return (
    <FieldSet>
      <FieldLegend variant="label">Template</FieldLegend>
      <RadioGroup value={value} onValueChange={(next) => onChange(next as ReportTemplate)}>
        {REPORT_TEMPLATES.map((option) => (
          <label
            key={option}
            htmlFor={`template-${option}`}
            className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3"
          >
            <RadioGroupItem value={option} id={`template-${option}`} className="mt-0.5" />
            <span className="flex flex-col gap-1">
              <span className="text-sm font-medium">{TEMPLATE_LABELS[option]}</span>
              <span className="text-xs text-muted-foreground">
                {TEMPLATE_DESCRIPTIONS[option]}
              </span>
            </span>
          </label>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

export function FormatField({ value, onChange }: FieldProps<ReportFormat>) {
  return (
    <Field>
      <FieldLabel htmlFor="report-format">Format</FieldLabel>
      <Select value={value} onValueChange={(next) => onChange(next as ReportFormat)}>
        <SelectTrigger id="report-format" aria-label="Format">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {REPORT_FORMATS.map((option) => (
            <SelectItem key={option} value={option}>
              {FORMAT_DESCRIPTIONS[option]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function SeverityField({ value, onChange }: FieldProps<SeverityChoice>) {
  return (
    <Field>
      <FieldLabel htmlFor="report-severity">Severity threshold</FieldLabel>
      <Select value={value} onValueChange={(next) => onChange(next as SeverityChoice)}>
        <SelectTrigger id="report-severity" aria-label="Severity threshold">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ANY_SEVERITY}>Every severity</SelectItem>
          {SEVERITY_OPTIONS.map((option) => (
            <SelectItem key={option} value={option}>
              {option} and above
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

export function TriageField({ value, onChange }: FieldProps<TriageState[]>) {
  const toggle = (state: TriageState, checked: boolean) =>
    onChange(checked ? [...value, state] : value.filter((s) => s !== state));

  return (
    <FieldSet>
      <FieldLegend variant="label">Triage states</FieldLegend>
      <FieldDescription>Leave all unticked to include every state.</FieldDescription>
      <div className="grid grid-cols-2 gap-2">
        {TRIAGE_STATES.map((state) => (
          <Field key={state} orientation="horizontal">
            <Checkbox
              id={`triage-${state}`}
              checked={value.includes(state)}
              onCheckedChange={(checked) => toggle(state, checked === true)}
            />
            <FieldLabel htmlFor={`triage-${state}`} className="font-normal">
              {TRIAGE_LABELS[state]}
            </FieldLabel>
          </Field>
        ))}
      </div>
    </FieldSet>
  );
}
