import { Link } from "react-router-dom";
import { AlertCircle, KeyRound } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { AdminApiError } from "@/services/admin";

/**
 * An admin request that failed.
 *
 * Every admin endpoint requires two-factor authentication (ADR-0009), so the
 * most likely failure for a new administrator is not an error at all but a
 * missing setup step, and it gets a way to fix it rather than a message.
 */
export function QueryError({ error }: { error: unknown }) {
  if (error instanceof AdminApiError && error.code === "TWO_FACTOR_REQUIRED") {
    return (
      <Alert>
        <KeyRound className="size-4" />
        <AlertTitle>Two-factor authentication required</AlertTitle>
        <AlertDescription>
          <p>
            Administration can stop every scan and change anyone's account, so
            it needs a second factor.{" "}
            <Link className="underline" to="/settings/security">
              Enable it in your security settings
            </Link>
            , then come back.
          </p>
        </AlertDescription>
      </Alert>
    );
  }

  return (
    <Alert variant="destructive">
      <AlertCircle className="size-4" />
      <AlertTitle>Could not load this section</AlertTitle>
      <AlertDescription>
        {error instanceof Error ? error.message : "The request failed."}
      </AlertDescription>
    </Alert>
  );
}

/** The message to show for a failed admin action. */
export function describeError(error: unknown): string {
  if (error instanceof AdminApiError && error.errors?.length) {
    return error.errors.map((problem) => problem.detail).join(" ");
  }
  return error instanceof Error ? error.message : "The request failed.";
}
