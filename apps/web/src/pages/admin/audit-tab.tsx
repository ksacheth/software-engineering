import { useState } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { fetchAudit, type AuditEntry, type AuditFilters } from "@/services/admin";
import { QueryError } from "./components/query-error";

/**
 * Filtered audit review (F.8 "should").
 *
 * Read-only by construction: the log is append-only at the database level
 * (DC-9), and nothing here offers to change it.
 */

// Mirrors the AuditAction enum. The API rejects anything else, so a stale list
// here shows as a validation error rather than a silently empty result.
const AUDIT_ACTIONS = [
  "AUTH_REGISTER",
  "AUTH_LOGIN",
  "AUTH_LOGOUT",
  "AUTH_FAILED",
  "AUTH_LOCKOUT",
  "AUTH_MFA_ENABLED",
  "TARGET_CREATED",
  "TARGET_VERIFIED",
  "TARGET_VERIFICATION_FAILED",
  "TARGET_REFUSED",
  "TARGET_SCOPE_CHANGED",
  "TARGET_ARCHIVED",
  "TARGET_DELETED",
  "SCAN_QUEUED",
  "SCAN_STARTED",
  "SCAN_PAUSED",
  "SCAN_RESUMED",
  "SCAN_CANCELLED",
  "SCAN_ABORTED_SAFETY",
  "SCAN_FAILED",
  "FINDING_TRIAGED",
  "EVIDENCE_PURGED",
  "REPORT_EXPORTED",
  "ADMIN_KILL_SWITCH_ENGAGED",
  "ADMIN_KILL_SWITCH_DISENGAGED",
  "ADMIN_BLOCKLIST_CREATED",
  "ADMIN_BLOCKLIST_UPDATED",
  "ADMIN_BLOCKLIST_DELETED",
  "ADMIN_QUOTA_CHANGED",
  "ADMIN_ROLE_GRANTED",
  "ADMIN_USER_ROLE_CHANGED",
  "ADMIN_USER_SUSPENDED",
  "ADMIN_USER_UNSUSPENDED",
] as const;

const ANY = "__any__";

function summarise(entry: AuditEntry): string {
  if (!entry.metadata) return "";
  const { reason, ...rest } = entry.metadata as Record<string, unknown>;
  const detail = Object.keys(rest).length ? JSON.stringify(rest) : "";
  return [typeof reason === "string" ? `“${reason}”` : "", detail]
    .filter(Boolean)
    .join(" ");
}

export function AuditTab() {
  const [filters, setFilters] = useState<AuditFilters>({});
  const [resourceId, setResourceId] = useState("");

  const audit = useInfiniteQuery({
    queryKey: ["admin", "audit", filters],
    queryFn: ({ pageParam }) => fetchAudit(filters, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const entries = audit.data?.pages.flatMap((page) => page.entries) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          setFilters((current) => ({
            ...current,
            resourceId: resourceId.trim() || undefined,
          }));
        }}
      >
        <Field className="w-72">
          <FieldLabel htmlFor="audit-action">Action</FieldLabel>
          <Select
            value={filters.action ?? ANY}
            onValueChange={(value) =>
              setFilters((current) => ({
                ...current,
                action: value === ANY ? undefined : value,
              }))
            }
          >
            <SelectTrigger id="audit-action" aria-label="Filter by action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any action</SelectItem>
              {AUDIT_ACTIONS.map((action) => (
                <SelectItem key={action} value={action}>
                  {action}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="w-72">
          <FieldLabel htmlFor="audit-resource">Resource id</FieldLabel>
          <Input
            id="audit-resource"
            value={resourceId}
            onChange={(event) => setResourceId(event.target.value)}
          />
        </Field>
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      {audit.error && <QueryError error={audit.error} />}
      {!audit.data && !audit.error && <Spinner aria-label="Loading" />}

      {audit.data && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>When (UTC)</TableHead>
              <TableHead>Action</TableHead>
              <TableHead>Actor</TableHead>
              <TableHead>Organisation</TableHead>
              <TableHead>Resource</TableHead>
              <TableHead>Details</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {entries.map((entry) => (
              <TableRow key={entry.id}>
                <TableCell className="whitespace-nowrap font-mono text-xs">
                  {entry.timestamp.replace("T", " ").replace(/\.\d+Z$/, "")}
                </TableCell>
                <TableCell className="font-mono text-xs">{entry.action}</TableCell>
                <TableCell className="text-xs">
                  {entry.user?.email ??
                    (entry.userId ? `Deleted user (${entry.userId})` : "System")}
                </TableCell>
                <TableCell className="text-xs">
                  {entry.organization?.name ?? (entry.organizationId ? entry.organizationId : "Deployment")}
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {entry.resourceType}
                  {entry.resourceId && `:${entry.resourceId}`}
                </TableCell>
                <TableCell className="max-w-md break-words text-xs text-muted-foreground">
                  {summarise(entry)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {audit.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={audit.isFetchingNextPage}
          onClick={() => void audit.fetchNextPage()}
        >
          Load older
        </Button>
      )}
    </div>
  );
}
