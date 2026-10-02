import { useEffect, useState, type ReactNode } from "react";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ui/spinner";

/**
 * Confirmation for an administrative action the audit log must explain.
 *
 * The reason is required because the audit record is how anyone later learns
 * why every scan stopped or an account was locked out. A confirmation phrase
 * can be added for the actions with the widest reach, so a stray click cannot
 * take them. The dialog stays open until the action settles, so a refusal is
 * shown where it was made rather than lost behind a closed dialog.
 */

export interface ReasonDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  /** When set, the user must type this exactly before confirming. */
  confirmPhrase?: string;
  /** Some confirmations (deleting a blocklist entry) need no reason. */
  requireReason?: boolean;
  destructive?: boolean;
  pending: boolean;
  error?: string | null;
  onConfirm: (reason: string) => void;
}

export function ReasonDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  confirmPhrase,
  requireReason = true,
  destructive = false,
  pending,
  error,
  onConfirm,
}: ReasonDialogProps) {
  const [reason, setReason] = useState("");
  const [phrase, setPhrase] = useState("");

  // Cleared on every close, not only the ones the dialog starts itself: a
  // successful action is closed by the parent, and a parent that keeps one
  // instance mounted would otherwise reopen it with the last reason and the
  // confirmation phrase already typed.
  useEffect(() => {
    if (!open) {
      setReason("");
      setPhrase("");
    }
  }, [open]);

  const ready =
    (!requireReason || reason.trim().length > 0) &&
    (!confirmPhrase || phrase === confirmPhrase);

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>

        <form
          id="reason-dialog-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (ready && !pending) onConfirm(reason.trim());
          }}
        >
          {requireReason && (
            <Field>
              <FieldLabel htmlFor="admin-reason">Reason</FieldLabel>
              <Textarea
                id="admin-reason"
                value={reason}
                maxLength={500}
                onChange={(event) => setReason(event.target.value)}
              />
            </Field>
          )}
          {confirmPhrase && (
            <Field>
              <FieldLabel htmlFor="admin-confirm-phrase">
                Type {confirmPhrase} to confirm
              </FieldLabel>
              <Input
                id="admin-confirm-phrase"
                autoComplete="off"
                value={phrase}
                onChange={(event) => setPhrase(event.target.value)}
              />
            </Field>
          )}
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
        </form>

        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            type="submit"
            form="reason-dialog-form"
            variant={destructive ? "destructive" : "default"}
            disabled={!ready || pending}
          >
            {pending && <Spinner data-icon="inline-start" />}
            {confirmLabel}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
