"use client";

import type { EmailOtpAuthClient } from "@better-auth-ui/core/plugins/email-otp";
import { useAuth, useSendVerificationEmail } from "@better-auth-ui/react";
import { useVerifyEmailOtp } from "@better-auth-ui/react/plugins/email-otp";
import { EMAIL_VERIFICATION_CODE } from "@wvs/shared";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { FieldDescription } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { absoluteAppUrl } from "@/lib/auth/app-url";
import { cn } from "@/lib/utils";
import { OpenEmailButton } from "./open-email-button";
import { OtpField } from "./otp-field";
import { useIsHydrated } from "./use-is-hydrated";

export type VerifyEmailProps = {
  className?: string;
};

/** Seconds the resend button stays disabled to prevent spamming the endpoint. */
const RESEND_COOLDOWN_SECONDS = 60;

const CODE_LENGTH = EMAIL_VERIFICATION_CODE.length;

/** Key sign-up and sign-in use to hand the address to this view. */
const EMAIL_STORAGE_KEY = "better-auth-ui.verify-email";

/**
 * F.1 email confirmation (ADR-0013): the user types the code from the email.
 *
 * The address comes from `sessionStorage`, set when sign-up or an attempt to
 * sign in to an unconfirmed account redirects here; both of those have just
 * sent a code. A confirmed address still has to sign in with its password, so
 * success leads to the sign-in view rather than into the app.
 *
 * @param className - Additional CSS classes applied to the card
 * @returns The verify-email card React element
 */
export function VerifyEmail({ className }: VerifyEmailProps) {
  const { basePaths, localization, navigate, viewPaths, Link } = useAuth();

  const isHydrated = useIsHydrated();
  const [email, setEmail] = useState(
    (isHydrated && sessionStorage.getItem(EMAIL_STORAGE_KEY)) || "",
  );

  useEffect(() => {
    setEmail(sessionStorage.getItem(EMAIL_STORAGE_KEY) ?? "");
  }, []);

  const signInPath = `${basePaths.auth}/${viewPaths.auth.signIn}`;

  const onConfirmed = () => {
    sessionStorage.removeItem(EMAIL_STORAGE_KEY);
    toast.success("Email confirmed. Sign in to continue.");
    navigate({ to: signInPath });
  };

  return (
    <Card className={cn("w-full max-w-sm", className)}>
      <CardHeader>
        <CardTitle className="text-xl font-semibold">
          {localization.auth.verifyEmail}
        </CardTitle>
      </CardHeader>

      <CardContent>
        {email ? (
          <div className="flex flex-col gap-4">
            <FieldDescription>
              We sent a {CODE_LENGTH}-digit code to{" "}
              <span className="font-medium text-foreground">{email}</span>. It
              expires in {EMAIL_VERIFICATION_CODE.expiresInMinutes} minutes.
            </FieldDescription>

            <ConfirmationCodeForm email={email} onConfirmed={onConfirmed} />
            <OpenEmailButton email={email} variant="secondary" />
            <ResendCodeButton email={email} />
          </div>
        ) : (
          <FieldDescription>
            Sign in with your email and password, and we will send a
            confirmation code to your inbox.
          </FieldDescription>
        )}

        <div className="flex flex-col gap-3 items-center w-full mt-4">
          <FieldDescription className="text-center">
            {localization.auth.alreadyVerifiedYourEmail}{" "}
            <Link href={signInPath} className="underline underline-offset-4">
              {localization.auth.signIn}
            </Link>
          </FieldDescription>
        </div>
      </CardContent>
    </Card>
  );
}

/** The code field. Submits on its own once every digit is in. */
function ConfirmationCodeForm({
  email,
  onConfirmed,
}: {
  email: string;
  onConfirmed: () => void;
}) {
  const { authClient } = useAuth();
  const emailOtpClient = authClient as EmailOtpAuthClient;
  const [code, setCode] = useState("");

  // A wrong or expired code is reported by the shared auth error toaster;
  // clearing the field readies it for the next try.
  const { mutate: verifyEmailOtp, isPending } = useVerifyEmailOtp(emailOtpClient, {
    onError: () => setCode(""),
    onSuccess: onConfirmed,
  });

  const submit = (value: string) => {
    if (isPending || value.length !== CODE_LENGTH) return;
    verifyEmailOtp({ email, otp: value });
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(code);
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={onSubmit}>
      <OtpField
        autoFocus
        disabled={isPending}
        label="Confirmation code"
        length={CODE_LENGTH}
        name="code"
        value={code}
        onChange={setCode}
        onComplete={submit}
      />
      <Button type="submit" disabled={isPending || code.length !== CODE_LENGTH}>
        {isPending && <Spinner />}
        Confirm email
      </Button>
    </form>
  );
}

/**
 * Sends a fresh code. Starts cooling down, because arriving here means a code
 * was sent a moment ago.
 */
function ResendCodeButton({ email }: { email: string }) {
  const { authClient, redirectTo } = useAuth();
  const [cooldown, setCooldown] = useState(RESEND_COOLDOWN_SECONDS);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timeout = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timeout);
  }, [cooldown]);

  // The API answers the standard resend route with a code (ADR-0013).
  const { mutate: sendVerificationEmail, isPending } = useSendVerificationEmail(
    authClient,
    {
      onSuccess: () => {
        toast.success("A new code is on its way.");
        setCooldown(RESEND_COOLDOWN_SECONDS);
      },
    },
  );

  return (
    <Button
      type="button"
      variant="outline"
      disabled={cooldown > 0 || isPending}
      onClick={() =>
        sendVerificationEmail({ email, callbackURL: absoluteAppUrl(redirectTo) })
      }
    >
      {isPending && <Spinner />}
      {cooldown > 0 ? `Send a new code in ${cooldown}s` : "Send a new code"}
    </Button>
  );
}
