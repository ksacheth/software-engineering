import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  createBlocklistEntry,
  deleteBlocklistEntry,
  fetchBlocklist,
  updateBlocklistEntry,
  type BlocklistEntry,
  type BlocklistPatternType,
} from "@/services/admin";
import { ReasonDialog } from "./components/reason-dialog";
import { describeError, QueryError } from "./components/query-error";

/**
 * The network blocklist (F.8).
 *
 * Checked when a target is registered or verified, before a scan starts or
 * resumes, and by the Scope Guard on every request. A pattern is never edited
 * in place: blocking something else is a new entry, so the audit log reads
 * as what actually happened.
 */

const PATTERN_TYPES: {
  value: BlocklistPatternType;
  label: string;
  example: string;
}[] = [
  { value: "HOST_SUFFIX", label: "Host and subdomains", example: "gov.example" },
  { value: "CIDR", label: "CIDR network", example: "10.0.0.0/8" },
  { value: "IP_RANGE", label: "Address range", example: "10.0.0.1-10.0.0.9" },
];

export function BlocklistTab() {
  const queryClient = useQueryClient();
  const [deleting, setDeleting] = useState<BlocklistEntry | null>(null);
  const blocklist = useQuery({
    queryKey: ["admin", "blocklist"],
    queryFn: fetchBlocklist,
  });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin", "blocklist"] });

  const toggle = useMutation({
    mutationFn: (entry: BlocklistEntry) =>
      updateBlocklistEntry(entry.id, { isActive: !entry.isActive }),
    onSuccess: ({ entry }) => {
      refresh();
      toast.success(
        `${entry.pattern} ${entry.isActive ? "is blocked again" : "no longer blocks anything"}`,
      );
    },
    onError: (error) => toast.error(describeError(error)),
  });

  const remove = useMutation({
    mutationFn: (entry: BlocklistEntry) => deleteBlocklistEntry(entry.id),
    onSuccess: () => {
      setDeleting(null);
      refresh();
      toast.success("Entry deleted");
    },
  });

  if (blocklist.error) return <QueryError error={blocklist.error} />;

  return (
    <div className="flex flex-col gap-6">
      <AddEntryCard onAdded={refresh} />

      {!blocklist.data ? (
        <Spinner aria-label="Loading" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Pattern</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>Added by</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Delete</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {blocklist.data.entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="font-mono">{entry.pattern}</TableCell>
                <TableCell>{entry.patternType}</TableCell>
                <TableCell>{entry.reason}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  {entry.createdBy?.email ?? "Unknown"}
                  <br />
                  {new Date(entry.createdAt).toLocaleString()}
                </TableCell>
                <TableCell>
                  <Switch
                    aria-label={`Active: ${entry.pattern}`}
                    checked={entry.isActive}
                    disabled={toggle.isPending}
                    onCheckedChange={() => toggle.mutate(entry)}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={`Delete ${entry.pattern}`}
                    onClick={() => {
                      remove.reset();
                      setDeleting(entry);
                    }}
                  >
                    <Trash2 />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      <ReasonDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.pattern}?`}
        description="The entry stops blocking immediately. The audit log keeps a record of what it was. To stop it blocking but keep it listed, switch it off instead."
        confirmLabel="Delete entry"
        requireReason={false}
        destructive
        pending={remove.isPending}
        error={remove.error ? describeError(remove.error) : null}
        onConfirm={() => deleting && remove.mutate(deleting)}
      />
    </div>
  );
}

function AddEntryCard({ onAdded }: { onAdded: () => void }) {
  const [patternType, setPatternType] =
    useState<BlocklistPatternType>("HOST_SUFFIX");
  const [pattern, setPattern] = useState("");
  const [reason, setReason] = useState("");

  const add = useMutation({
    mutationFn: () =>
      createBlocklistEntry({ patternType, pattern: pattern.trim(), reason: reason.trim() }),
    onSuccess: ({ entry }) => {
      setPattern("");
      setReason("");
      onAdded();
      toast.success(`${entry.pattern} added to the blocklist`);
    },
  });

  const example = PATTERN_TYPES.find((t) => t.value === patternType)!.example;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Block a host or network</CardTitle>
        <CardDescription>
          Targets already verified against a blocked host stay registered but
          can no longer be scanned.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          className="grid gap-4 md:grid-cols-[12rem_1fr_1fr_auto] md:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            add.mutate();
          }}
        >
          <Field>
            <FieldLabel htmlFor="blocklist-type">Type</FieldLabel>
            <Select
              value={patternType}
              onValueChange={(value) =>
                setPatternType(value as BlocklistPatternType)
              }
            >
              <SelectTrigger id="blocklist-type" aria-label="Pattern type">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PATTERN_TYPES.map((type) => (
                  <SelectItem key={type.value} value={type.value}>
                    {type.label} ({type.value})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor="blocklist-pattern">Pattern</FieldLabel>
            <Input
              id="blocklist-pattern"
              placeholder={example}
              value={pattern}
              onChange={(event) => setPattern(event.target.value)}
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="blocklist-reason">Why is it blocked?</FieldLabel>
            <Input
              id="blocklist-reason"
              maxLength={500}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <Button
            type="submit"
            disabled={add.isPending || !pattern.trim() || !reason.trim()}
          >
            {add.isPending ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <Plus data-icon="inline-start" />
            )}
            Add to blocklist
          </Button>
        </form>
        {add.error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {describeError(add.error)}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
