import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createAuthClient } from "better-auth/react";
import { emailOTPClient } from "better-auth/client/plugins";
import type { ReactNode } from "react";

import { AuthProvider } from "@/components/auth/auth-provider";
import { renderPage } from "@/test-support/render";
import { VerifyEmail } from "./verify-email";

/**
 * F.1 confirmation by code (ADR-0013), against a real auth client with the
 * network replaced: what the page sends, and where it goes after.
 */

const EMAIL = "new.user@example.test";

let requests: { path: string; body: unknown }[] = [];
let verifyStatus = 200;
let navigate: ReturnType<typeof mock>;

beforeEach(() => {
  requests = [];
  verifyStatus = 200;
  navigate = mock();
  sessionStorage.setItem("better-auth-ui.verify-email", EMAIL);
});

afterEach(() => {
  sessionStorage.clear();
});

/** Records each call and answers as the API would. */
async function fakeApi(input: RequestInfo | URL, init?: RequestInit) {
  const request = new Request(input, init);
  const path = new URL(request.url).pathname;
  const body = request.method === "POST" ? await request.json() : null;
  requests.push({ path, body });

  if (path.endsWith("/email-otp/verify-email")) {
    return verifyStatus === 200
      ? Response.json({ status: true, token: null, user: { email: EMAIL } })
      : Response.json(
          { code: "INVALID_OTP", message: "Invalid OTP" },
          { status: verifyStatus },
        );
  }
  if (path.endsWith("/get-session")) return Response.json(null);
  return Response.json({ status: true });
}

const authClient = createAuthClient({
  baseURL: "http://localhost:3000",
  plugins: [emailOTPClient()],
  fetchOptions: { customFetchImpl: fakeApi },
});

function renderVerifyEmail() {
  const providers = ({ children }: { children: ReactNode }) => (
    <AuthProvider
      authClient={authClient}
      navigate={navigate}
      Link={({ href, children: label, ...props }) => (
        <a href={href} {...props}>
          {label}
        </a>
      )}
      redirectTo="/targets"
      emailAndPassword={{ enabled: true, requireEmailVerification: true }}
    >
      {children}
    </AuthProvider>
  );
  return renderPage(providers({ children: <VerifyEmail /> }) as never);
}

const codeInput = () => screen.getByLabelText("Confirmation code");

describe("VerifyEmail", () => {
  test("says where the code went and how long it lasts", () => {
    renderVerifyEmail();

    expect(screen.getByText(EMAIL)).toBeTruthy();
    expect(screen.getByText(/expires in 10 minutes/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send a new code in/ })).toBeTruthy();
  });

  test("sends the typed code with the address, then leads to sign-in", async () => {
    renderVerifyEmail();

    await userEvent.type(codeInput(), "482913");

    await waitFor(() =>
      expect(navigate).toHaveBeenCalledWith({ to: "/auth/sign-in" }),
    );
    const verify = requests.find((r) => r.path.endsWith("/email-otp/verify-email"));
    expect(verify?.body).toEqual({ email: EMAIL, otp: "482913" });
    expect(sessionStorage.getItem("better-auth-ui.verify-email")).toBeNull();
  });

  test("a refused code clears the field and stays on the page", async () => {
    verifyStatus = 400;
    renderVerifyEmail();

    await userEvent.type(codeInput(), "000000");

    await waitFor(() => expect((codeInput() as HTMLInputElement).value).toBe(""));
    expect(navigate).not.toHaveBeenCalled();
  });

  test("without an address it explains how to get a code instead", () => {
    sessionStorage.clear();
    renderVerifyEmail();

    expect(screen.queryByLabelText("Confirmation code")).toBeNull();
    expect(screen.getByText(/we will send a\s+confirmation code/)).toBeTruthy();
  });
});
