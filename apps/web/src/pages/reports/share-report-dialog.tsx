import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { REPORT_SHARE_BOUNDS } from "@wvs/shared";
import { AlertCircle, Link2, Link2Off } from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { revokeReportShare, shareReport, type Report } from "@/services/reports";
import { CopyButton } from "../targets/components/copy-button";

/**
 * A time-limited link to one report file (F.7, ADR-0011).
 *
 * Anyone holding the link can download the file until it expires, so the link
 * is shown once, right after it is made: only its hash is stored, and the
 * dashboard could not show it again if it tried. Making a new link retires the
 * old one.
 */

const LIFETIMES = [1, 7, 14, REPORT_SHARE_BOUNDS.maxDays];

function ShareLinkField({ link }: { link: string }) {
  return (
    <Field>
      <FieldLabel htmlFor="share-link">Share link</FieldLabel>
      <div className="flex gap-2">
        <Input id="share-link" readOnly value={link} className="font-mono text-xs" />
        <CopyButton value={link} label="Copy share link" variant="outline" />
      </div>
      <FieldDescription>
        Copy it now: it will not be shown again. Creating a new link stops this
        one working.
      </FieldDescription>
    </Field>
  );
}

function LifetimeField({
  report,
  days,
  onChange,
}: {
  report: Report;
  days: number;
  onChange: (days: number) => void;
}) {
  const activeUntil = report.share.active ? report.share.expiresAt : null;
  return (
    <Field>
      <FieldLabel htmlFor="share-lifetime">Expires after</FieldLabel>
      <Select value={String(days)} onValueChange={(value) => onChange(Number(value))}>
        <SelectTrigger id="share-lifetime" aria-label="Expires after">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {LIFETIMES.map((option) => (
            <SelectItem key={option} value={String(option)}>
              {option} {option === 1 ? "day" : "days"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {activeUntil && (
        <FieldDescription>
          A link is active until {new Date(activeUntil).toLocaleString()}. A new
          one replaces it.
        </FieldDescription>
      )}
      {report.expiresAt && (
        <FieldDescription>
          The link cannot outlast the evidence in this report, which expires{" "}
          {new Date(report.expiresAt).toLocaleString()}.
        </FieldDescription>
      )}
    </Field>
  );
}

interface ShareReportDialogProps {
  report: Report;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ShareReportDialog({ report, open, onOpenChange }: ShareReportDialogProps) {
  const queryClient = useQueryClient();
  const [days, setDays] = useState<number>(REPORT_SHARE_BOUNDS.defaultDays);
  const [link, setLink] = useState<string | null>(null);

  const refresh = () => void queryClient.invalidateQueries({ queryKey: ["reports"] });

  const create = useMutation({
    mutationFn: () => shareReport(report.id, days),
    onSuccess: ({ sharePath }) => {
      setLink(new URL(sharePath, window.location.origin).toString());
      refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: () => revokeReportShare(report.id),
    onSuccess: () => {
      toast.success("Share link revoked");
      setLink(null);
      refresh();
    },
  });

  const error = create.error ?? revoke.error;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setLink(null);
          create.reset();
          revoke.reset();
        }
      }}
    >
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this report</DialogTitle>
          <DialogDescription>
            Anyone with the link can download the file, without signing in,
            until it expires.
            {report.includesEvidence &&
              " This report contains raw evidence from the scanned site."}
          </DialogDescription>
        </DialogHeader>

        {error instanceof Error && (
          <Alert variant="destructive">
            <AlertCircle className="size-4" />
            <AlertTitle>Could not update the link</AlertTitle>
            <AlertDescription>{error.message}</AlertDescription>
          </Alert>
        )}

        {link ? (
          <ShareLinkField link={link} />
        ) : (
          <LifetimeField report={report} days={days} onChange={setDays} />
        )}

        <DialogFooter>
          {report.share.active && (
            <Button
              type="button"
              variant="outline"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {revoke.isPending ? <Spinner data-icon="inline-start" /> : <Link2Off data-icon="inline-start" />}
              Revoke link
            </Button>
          )}
          {!link && (
            <Button type="button" disabled={create.isPending} onClick={() => create.mutate()}>
              {create.isPending ? <Spinner data-icon="inline-start" /> : <Link2 data-icon="inline-start" />}
              {report.share.active ? "Create new link" : "Create link"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
