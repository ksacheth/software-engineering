import { useState } from "react";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { Search } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Spinner } from "@/components/ui/spinner";
import { useMe } from "@/lib/use-role";
import {
  changeUserRole,
  fetchUsers,
  ROLES,
  suspendUser,
  unsuspendUser,
  type AdminUser,
  type Role,
} from "@/services/admin";
import { ReasonDialog } from "./components/reason-dialog";
import { describeError, QueryError } from "./components/query-error";

/**
 * Accounts across every organisation (F.8, ADR-0009).
 *
 * Your own row has no controls: the API refuses any change an administrator
 * makes to their own account, which is also what keeps at least one
 * administrator in the deployment.
 */

export function UsersTab() {
  const me = useMe();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState("");
  const [search, setSearch] = useState("");
  const [pending, setPending] = useState<{
    user: AdminUser;
    action: "suspend" | "unsuspend";
  } | null>(null);

  const users = useInfiniteQuery({
    queryKey: ["admin", "users", search],
    queryFn: ({ pageParam }) => fetchUsers(search, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });

  const refresh = () =>
    void queryClient.invalidateQueries({ queryKey: ["admin", "users"] });

  const role = useMutation({
    mutationFn: ({ user, next }: { user: AdminUser; next: Role }) =>
      changeUserRole(user.id, next),
    onSuccess: ({ user }) => {
      refresh();
      toast.success(`${user.email} is now ${user.role}`);
    },
    onError: (error) => toast.error(describeError(error)),
  });

  const suspension = useMutation({
    mutationFn: ({ reason }: { reason: string }) =>
      pending!.action === "suspend"
        ? suspendUser(pending!.user.id, reason)
        : unsuspendUser(pending!.user.id, reason),
    onSuccess: ({ user }) => {
      setPending(null);
      refresh();
      toast.success(
        user.suspendedAt ? `${user.email} suspended` : `${user.email} restored`,
      );
    },
  });

  if (users.error) return <QueryError error={users.error} />;

  const rows = users.data?.pages.flatMap((page) => page.users) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex max-w-md items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          setSearch(draft);
        }}
      >
        <Input
          aria-label="Search accounts"
          placeholder="Email or name"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
        />
        <Button type="submit" variant="outline">
          <Search data-icon="inline-start" />
          Search
        </Button>
      </form>

      {!users.data ? (
        <Spinner aria-label="Loading" />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Account</TableHead>
              <TableHead>Organisation</TableHead>
              <TableHead>Role</TableHead>
              <TableHead>Security</TableHead>
              <TableHead>Last sign-in</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((user) => (
              <UserRow
                key={user.id}
                user={user}
                isSelf={user.id === me?.user.id}
                roleBusy={role.isPending}
                onRoleChange={(next) => role.mutate({ user, next })}
                onSuspension={() => {
                  suspension.reset();
                  setPending({
                    user,
                    action: user.suspendedAt ? "unsuspend" : "suspend",
                  });
                }}
              />
            ))}
          </TableBody>
        </Table>
      )}

      {users.hasNextPage && (
        <Button
          variant="outline"
          className="self-center"
          disabled={users.isFetchingNextPage}
          onClick={() => void users.fetchNextPage()}
        >
          Load more
        </Button>
      )}

      <ReasonDialog
        open={pending !== null}
        onOpenChange={(open) => !open && setPending(null)}
        title={
          pending?.action === "suspend"
            ? `Suspend ${pending.user.email}?`
            : `Lift the suspension on ${pending?.user.email}?`
        }
        description={
          pending?.action === "suspend"
            ? "They are signed out everywhere and cannot sign in until an administrator lifts the suspension."
            : "They will be able to sign in again."
        }
        confirmLabel={
          pending?.action === "suspend" ? "Suspend account" : "Lift suspension"
        }
        destructive={pending?.action === "suspend"}
        pending={suspension.isPending}
        error={suspension.error ? describeError(suspension.error) : null}
        onConfirm={(reason) => suspension.mutate({ reason })}
      />
    </div>
  );
}

function UserRow({
  user,
  isSelf,
  roleBusy,
  onRoleChange,
  onSuspension,
}: {
  user: AdminUser;
  isSelf: boolean;
  roleBusy: boolean;
  onRoleChange: (role: Role) => void;
  onSuspension: () => void;
}) {
  return (
    <TableRow>
      <TableCell>
        <div className="font-medium">{user.email}</div>
        <div className="text-xs text-muted-foreground">{user.name}</div>
      </TableCell>
      <TableCell>{user.organization?.name ?? "None"}</TableCell>
      <TableCell>
        {isSelf ? (
          <Badge variant="outline">{user.role} (you)</Badge>
        ) : (
          <Select
            value={user.role}
            disabled={roleBusy}
            onValueChange={(next) => onRoleChange(next as Role)}
          >
            <SelectTrigger className="w-36" aria-label={`Role for ${user.email}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {ROLES.map((option) => (
                <SelectItem key={option} value={option}>
                  {option}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </TableCell>
      <TableCell>
        <SecurityBadges user={user} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {user.lastSignInAt
          ? new Date(user.lastSignInAt).toLocaleString()
          : "No live session"}
      </TableCell>
      <TableCell className="text-right">
        {!isSelf && (
          <Button
            size="sm"
            variant={user.suspendedAt ? "outline" : "destructive"}
            onClick={onSuspension}
          >
            {user.suspendedAt ? "Lift suspension" : "Suspend"}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function SecurityBadges({ user }: { user: AdminUser }) {
  return (
    <div className="flex flex-wrap gap-1">
      <Badge variant={user.twoFactorEnabled ? "secondary" : "outline"}>
        {user.twoFactorEnabled ? "2FA on" : "2FA off"}
      </Badge>
      {user.suspendedAt && <Badge variant="destructive">Suspended</Badge>}
      {!user.emailVerified && <Badge variant="outline">Unconfirmed email</Badge>}
    </div>
  );
}
