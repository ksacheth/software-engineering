import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil } from "lucide-react";
import { toast } from "sonner";
import { ORGANIZATION_QUOTA_BOUNDS } from "@wvs/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  fetchOrganizations,
  updateQuota,
  type AdminOrganization,
} from "@/services/admin";
import { describeError, QueryError } from "./components/query-error";

/**
 * Organisations and their quotas (F.8).
 *
 * Lowering a quota refuses new scans; it never stops one already running.
 */

const { maxConcurrentScans, scanRateLimit } = ORGANIZATION_QUOTA_BOUNDS;

export function OrganizationsTab() {
  const [editing, setEditing] = useState<AdminOrganization | null>(null);
  const organizations = useQuery({
    queryKey: ["admin", "organizations"],
    queryFn: fetchOrganizations,
  });

  if (organizations.error) return <QueryError error={organizations.error} />;
  if (!organizations.data) return <Spinner aria-label="Loading" />;

  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Organisation</TableHead>
            <TableHead>Members</TableHead>
            <TableHead>Active / allowed scans</TableHead>
            <TableHead>Request rate cap</TableHead>
            <TableHead className="text-right">Quota</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {organizations.data.organizations.map((organization) => (
            <TableRow key={organization.id}>
              <TableCell className="font-medium">{organization.name}</TableCell>
              <TableCell>{organization.memberCount}</TableCell>
              <TableCell>
                {organization.maxConcurrentScans === 0
                  ? `${organization.activeScans} / 0 (suspended)`
                  : `${organization.activeScans} / ${organization.maxConcurrentScans}`}
              </TableCell>
              <TableCell>{organization.scanRateLimit} req/s</TableCell>
              <TableCell className="text-right">
                <Button
                  size="sm"
                  variant="outline"
                  aria-label={`Edit quota for ${organization.name}`}
                  onClick={() => setEditing(organization)}
                >
                  <Pencil data-icon="inline-start" />
                  Edit
                </Button>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {editing && (
        <QuotaDialog
          organization={editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function QuotaDialog({
  organization,
  onClose,
}: {
  organization: AdminOrganization;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [concurrent, setConcurrent] = useState(
    String(organization.maxConcurrentScans),
  );
  const [rate, setRate] = useState(String(organization.scanRateLimit));

  const save = useMutation({
    mutationFn: () =>
      updateQuota(organization.id, {
        maxConcurrentScans: Number(concurrent),
        scanRateLimit: Number(rate),
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["admin", "organizations"],
      });
      toast.success(`Quota for ${organization.name} saved`);
      onClose();
    },
  });

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Quota for {organization.name}</DialogTitle>
          <DialogDescription>
            Applies to scans started from now on. Scans already running are not
            stopped.
          </DialogDescription>
        </DialogHeader>
        <form
          id="quota-form"
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            save.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor="quota-concurrent">Concurrent scans</FieldLabel>
            <Input
              id="quota-concurrent"
              type="number"
              min={maxConcurrentScans.min}
              max={maxConcurrentScans.max}
              value={concurrent}
              onChange={(event) => setConcurrent(event.target.value)}
            />
            <FieldDescription>
              {Number(concurrent) === 0
                ? "Zero suspends scanning for this organisation."
                : `Between ${maxConcurrentScans.min} and ${maxConcurrentScans.max}. Zero suspends scanning.`}
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor="quota-rate">Request rate (req/s)</FieldLabel>
            <Input
              id="quota-rate"
              type="number"
              min={scanRateLimit.min}
              max={scanRateLimit.max}
              value={rate}
              onChange={(event) => setRate(event.target.value)}
            />
            <FieldDescription>
              At most {scanRateLimit.max}, the safety limit F.8 sets for every
              scan.
            </FieldDescription>
          </Field>
          {save.error && (
            <p role="alert" className="text-sm text-destructive">
              {describeError(save.error)}
            </p>
          )}
        </form>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" form="quota-form" disabled={save.isPending}>
            {save.isPending && <Spinner data-icon="inline-start" />}
            Save quota
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
