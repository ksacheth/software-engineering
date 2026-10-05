import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReportFormat, ReportTemplate, TriageState } from "@wvs/shared";
import { AlertCircle, FileText } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { fetchScans } from "@/services/scans";
import { createReport, type CreateReportInput } from "@/services/reports";
import {
  ANY_SEVERITY,
  FormatField,
  SeverityField,
  TemplateField,
  TriageField,
  type SeverityChoice,
} from "./report-option-fields";

/**
 * Request a report (F.7): template, format, and the optional severity
 * threshold and triage filter. Generation is asynchronous; the dialog closes
 * once the report is queued, and the reports list shows it arrive.
 *
 * Opened from a scan, the scan is fixed. Opened from the reports page, the
 * user picks one of the organisation's completed scans.
 */

interface GenerateReportDialogProps {
  /** Fixes the scan. Absent, the dialog offers completed scans to pick from. */
  scanId?: string;
}

interface ReportChoices {
  template: ReportTemplate;
  format: ReportFormat;
  minSeverity: SeverityChoice;
  triageStates: TriageState[];
}

const DEFAULT_CHOICES: ReportChoices = {
  template: "EXECUTIVE_SUMMARY",
  format: "PDF",
  minSeverity: ANY_SEVERITY,
  triageStates: [],
};

/** Optional filters are sent only when set, so the server applies its defaults. */
function toRequest(scanId: string, choices: ReportChoices): CreateReportInput {
  const { minSeverity, triageStates, ...rest } = choices;
  return {
    scanId,
    ...rest,
    ...(minSeverity !== ANY_SEVERITY ? { minSeverity } : {}),
    ...(triageStates.length > 0 ? { triageStates } : {}),
  };
}

function CompletedScanSelect({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["scans", { status: "COMPLETED" }],
    queryFn: () => fetchScans({ status: "COMPLETED" }),
  });
  const scans = data?.scans ?? [];

  return (
    <Field>
      <FieldLabel htmlFor="report-scan">Scan</FieldLabel>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id="report-scan" aria-label="Scan">
          <SelectValue placeholder={isLoading ? "Loading scans" : "Choose a completed scan"} />
        </SelectTrigger>
        <SelectContent>
          {scans.map((scan) => (
            <SelectItem key={scan.id} value={scan.id}>
              {scan.target?.label ?? scan.targetId} ·{" "}
              {scan.completedAt ? new Date(scan.completedAt).toLocaleString() : scan.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {!isLoading && scans.length === 0 && (
        <FieldDescription>Reports need a completed scan, and there are none yet.</FieldDescription>
      )}
    </Field>
  );
}

export function GenerateReportDialog({ scanId }: GenerateReportDialogProps) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [chosenScan, setChosenScan] = useState("");
  const [choices, setChoices] = useState<ReportChoices>(DEFAULT_CHOICES);
  const targetScan = scanId ?? chosenScan;

  const choose =
    <K extends keyof ReportChoices>(key: K) =>
    (value: ReportChoices[K]) =>
      setChoices((current) => ({ ...current, [key]: value }));

  const mutation = useMutation({
    mutationFn: () => createReport(toRequest(targetScan, choices)),
    onSuccess: () => {
      toast.success("Report queued. You will be notified when it is ready.");
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
      setOpen(false);
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) mutation.reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>
          <FileText data-icon="inline-start" />
          Generate report
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Generate a report</DialogTitle>
          <DialogDescription>
            Every report states the scan's scope, timing, detector versions and
            coverage limitations.
          </DialogDescription>
        </DialogHeader>

        <form
          className="flex flex-col gap-6"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          {mutation.error instanceof Error && (
            <Alert variant="destructive">
              <AlertCircle className="size-4" />
              <AlertTitle>Report not queued</AlertTitle>
              <AlertDescription>{mutation.error.message}</AlertDescription>
            </Alert>
          )}

          {!scanId && <CompletedScanSelect value={chosenScan} onChange={setChosenScan} />}
          <TemplateField value={choices.template} onChange={choose("template")} />
          <FormatField value={choices.format} onChange={choose("format")} />
          <SeverityField value={choices.minSeverity} onChange={choose("minSeverity")} />
          <TriageField value={choices.triageStates} onChange={choose("triageStates")} />

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!targetScan || mutation.isPending}>
              {mutation.isPending ? (
                <Spinner data-icon="inline-start" />
              ) : (
                <FileText data-icon="inline-start" />
              )}
              Generate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
