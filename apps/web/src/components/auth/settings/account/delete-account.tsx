"use client";

import { useAuth } from "@better-auth-ui/react";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
import { Spinner } from "@/components/ui/spinner";
import { queryClient } from "@/lib/query-client";
import { cn } from "@/lib/utils";

export type DeleteAccountProps = {
  className?: string;
};

/**
 * F.1 (should): permanently delete the signed-in account.
 *
 * Deletion is gated on the current password, which also satisfies Better Auth's
 * fresh-session requirement without depending on when the user last signed in.
 * The query cache is cleared afterwards so a cached session cannot bounce the
 * user back into the authenticated shell.
 */
export function DeleteAccount({ className }: DeleteAccountProps) {
  const { authClient, basePaths, viewPaths, navigate } = useAuth();
  const [password, setPassword] = useState("");
  const [isPending, setIsPending] = useState(false);

  async function handleDelete() {
    setIsPending(true);
    try {
      const { error } = await authClient.deleteUser({ password });

      if (error) {
        toast.error(error.message ?? "Could not delete your account.");
        return;
      }

      setPassword("");
      queryClient.clear();
      toast.success("Your account has been deleted.");
      navigate({ to: `${basePaths.auth}/${viewPaths.auth.signIn}` });
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : "Could not delete your account.",
      );
    } finally {
      setIsPending(false);
    }
  }

  return (
    <Card className={cn("border-destructive/40", className)}>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Permanently delete your account and its data. This cannot be undone.
        </CardDescription>
      </CardHeader>

      <CardContent>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">Delete account</Button>
          </AlertDialogTrigger>

          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete this account?</AlertDialogTitle>
              <AlertDialogDescription>
                Your account and everything belonging to your organisation will
                be removed permanently. Enter your password to confirm.
              </AlertDialogDescription>
            </AlertDialogHeader>

            <Field>
              <FieldLabel htmlFor="delete-account-password">
                Password
              </FieldLabel>
              <Input
                id="delete-account-password"
                type="password"
                autoComplete="current-password"
                value={password}
                disabled={isPending}
                onChange={(event) => setPassword(event.target.value)}
              />
            </Field>

            <AlertDialogFooter>
              <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
              <AlertDialogAction
                disabled={isPending || password.length === 0}
                onClick={(event) => {
                  // Keep the dialog open while the request is in flight so the
                  // error, if any, lands somewhere the user is still looking.
                  event.preventDefault();
                  void handleDelete();
                }}
              >
                {isPending && <Spinner />}
                Delete account
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
