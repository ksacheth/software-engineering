import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { triageFindings, type TriageInput } from "@/services/findings";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TriageForm } from "./triage-form";

/** One triage decision applied to every selected finding, all or nothing. */

interface BulkTriageDialogProps {
  findingIds: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRecorded: () => void;
}

export function BulkTriageDialog({
  findingIds,
  open,
  onOpenChange,
  onRecorded,
}: BulkTriageDialogProps) {
  const queryClient = useQueryClient();
  const count = findingIds.length;

  const bulk = useMutation({
    mutationFn: (input: TriageInput) => triageFindings(findingIds, input),
    onSuccess: ({ updated, unchanged }) => {
      toast.success(
        `Triage recorded for ${updated} finding${updated === 1 ? "" : "s"}` +
          (unchanged ? `, ${unchanged} already in that state` : ""),
      );
      void queryClient.invalidateQueries({ queryKey: ["findings"] });
      void queryClient.invalidateQueries({ queryKey: ["finding"] });
      onRecorded();
    },
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) bulk.reset();
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Set triage for {count} finding{count === 1 ? "" : "s"}
          </DialogTitle>
          <DialogDescription>
            Applies to these findings in every scan of their targets, now and
            in later scans.
          </DialogDescription>
        </DialogHeader>
        <TriageForm
          submitLabel="Record triage"
          pending={bulk.isPending}
          error={bulk.error instanceof Error ? bulk.error.message : null}
          onSubmit={(input) => bulk.mutate(input)}
        />
      </DialogContent>
    </Dialog>
  );
}
