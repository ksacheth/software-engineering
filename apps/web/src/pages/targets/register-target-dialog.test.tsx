import { beforeEach, describe, expect, test } from "bun:test";
import { useState } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

type User = ReturnType<typeof userEvent.setup>;
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import type { RegisterTargetInput } from "@/services/targets";
import { resetMocks, stub, TargetApiError } from "@/test-support/mocks";

/**
 * Registering a target (F.2).
 *
 * The attestation is the point of this dialog. F.2 records it once, at
 * registration, and never lets it be edited, so it has to be a deliberate act
 * against a particular origin rather than a box that happened to be ticked. The
 * two properties that matter are that nothing is submitted without it, and that
 * it does not survive the dialog closing: a tick carried over from an abandoned
 * attempt would attest to something the user never read.
 *
 * The refusal path matters nearly as much. A registration refused because the
 * origin resolves somewhere it must not is the most security-relevant thing
 * this screen says, and it has to be legible rather than swallowed.
 */

const submissions: RegisterTargetInput[] = [];
let failWith: Error | null = null;

const { RegisterTargetDialog } = await import("./register-target-dialog");

function CurrentPath() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

/** The dialog is controlled, so the open state lives in a host like this. */
function Host() {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open register
      </button>
      <RegisterTargetDialog open={open} onOpenChange={setOpen} />
    </>
  );
}

function renderDialog() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/targets"]}>
        <Routes>
          <Route path="*" element={<Host />} />
        </Routes>
        <CurrentPath />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const labelField = () => screen.getByLabelText("Target Label");
const originField = () => screen.getByLabelText("Origin URL");
const acknowledgement = () =>
  screen.getByLabelText(/Authorisation Acknowledgement/);
const registerButton = () =>
  screen.getByRole("button", { name: /Register & Continue/ });

/**
 * The attestation control is a button with `aria-checked`, not an `<input>`,
 * so `.checked` is undefined on it. Reading the accessible state is what a
 * screen reader would announce and therefore the thing worth asserting.
 */
const isAcknowledged = () =>
  acknowledgement().getAttribute("aria-checked") === "true";

async function fillIn({
  label = "Corporate site",
  origin = "https://a.test",
  acknowledge = true,
}: { label?: string; origin?: string; acknowledge?: boolean } = {}) {
  const user = userEvent.setup();
  if (label) {
    await user.click(labelField());
    await user.keyboard(label);
  }
  if (origin) {
    await user.click(originField());
    await user.keyboard(origin);
  }
  if (acknowledge) await user.click(acknowledgement());
  return user;
}

beforeEach(() => {
  resetMocks();
  submissions.length = 0;
  failWith = null;
  stub.targets("registerTarget", (async (input: RegisterTargetInput) => {
    submissions.push(input);
    if (failWith) throw failWith;
    return { target: { id: "target-9" } };
  }) as never);
});

describe("the authorisation acknowledgement", () => {
  test("is required before anything can be registered", async () => {
    // F.2 makes the attestation a precondition of the target existing. Without
    // it the product is an anonymous scanner with a form in front of it.
    renderDialog();
    await fillIn({ acknowledge: false });

    expect(registerButton().hasAttribute("disabled")).toBe(true);
  });

  test("is not enough on its own", async () => {
    renderDialog();
    await fillIn({ label: "", origin: "", acknowledge: true });

    expect(registerButton().hasAttribute("disabled")).toBe(true);
  });

  test("starts unticked", () => {
    renderDialog();
    expect(isAcknowledged()).toBe(false);
  });

  /**
   * Every way out of the dialog, because they were not equivalent.
   *
   * Cancel called the parent's handler directly and skipped the reset, so the
   * attestation survived it while Escape cleared it. The routes are listed
   * rather than one being chosen, since the bug was that one of them differed.
   */
  const closeRoutes: [string, (user: User) => Promise<void>][] = [
    [
      "the Cancel button",
      async (user) => user.click(screen.getByRole("button", { name: "Cancel" })),
    ],
    ["Escape", async (user) => user.keyboard("{Escape}")],
  ];

  for (const [route, close] of closeRoutes) {
    test(`does not survive closing with ${route}`, async () => {
      // The attestation is about one origin. Carrying a tick over to the next
      // attempt would record an attestation the user never made for that
      // target, and it cannot be edited afterwards.
      renderDialog();
      const user = await fillIn();
      expect(registerButton().hasAttribute("disabled")).toBe(false);

      await close(user);
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

      await user.click(screen.getByRole("button", { name: "Open register" }));
      await screen.findByRole("dialog");

      expect(isAcknowledged()).toBe(false);
      expect((labelField() as HTMLInputElement).value).toBe("");
      expect((originField() as HTMLInputElement).value).toBe("");
      expect(registerButton().hasAttribute("disabled")).toBe(true);
    });
  }
});

describe("what gets submitted", () => {
  test("needs a label and an origin as well", async () => {
    renderDialog();

    await fillIn({ origin: "", acknowledge: true });
    expect(registerButton().hasAttribute("disabled")).toBe(true);
  });

  test("ignores whitespace-only input", async () => {
    // Trimming happens on submit, so a field of spaces would otherwise look
    // filled to the button and empty to the API.
    renderDialog();
    const user = userEvent.setup();

    await user.click(labelField());
    await user.keyboard("   ");
    await user.click(originField());
    await user.keyboard("   ");
    await user.click(acknowledgement());

    expect(registerButton().hasAttribute("disabled")).toBe(true);
  });

  test("trims what it sends", async () => {
    renderDialog();
    const user = await fillIn({
      label: "  Corporate site  ",
      origin: "  https://a.test  ",
    });

    await user.click(registerButton());

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]).toMatchObject({
      label: "Corporate site",
      origin: "https://a.test",
      authorisationAck: true,
    });
  });

  test("defaults to the DNS challenge", async () => {
    // It works for every hosting provider, whereas the well-known file needs
    // the user to be able to serve one.
    renderDialog();
    const user = await fillIn();

    await user.click(registerButton());

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]!.verificationMethod).toBe("DNS_TXT");
  });

  test("sends the well-known method when that is chosen", async () => {
    renderDialog();
    const user = await fillIn();

    await user.click(screen.getByRole("radio", { name: /Well-Known File/ }));
    await user.click(registerButton());

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]!.verificationMethod).toBe("WELL_KNOWN");
  });

  test("starts with an empty scope, which means the whole origin", async () => {
    renderDialog();
    const user = await fillIn();

    await user.click(registerButton());

    await waitFor(() => expect(submissions).toHaveLength(1));
    expect(submissions[0]!.includedPaths).toEqual([]);
    expect(submissions[0]!.excludedPaths).toEqual([]);
  });
});

describe("when the origin is refused", () => {
  test("shows what the API said", async () => {
    // The most security-relevant message this screen carries: the origin
    // resolves somewhere the scanner must never be pointed.
    failWith = new TargetApiError(
      422,
      "Refused: the hostname resolves to a cloud metadata address (169.254.169.254).",
      { kind: "ADDRESS", reason: "CLOUD_METADATA" },
    );
    renderDialog();
    const user = await fillIn({ origin: "https://evil.test" });

    await user.click(registerButton());

    await waitFor(() =>
      expect(screen.getByText("Registration Refused")).toBeTruthy(),
    );
    expect(screen.getByText(/cloud metadata address/)).toBeTruthy();
  });

  test("keeps the form so the user can correct the origin", async () => {
    failWith = new TargetApiError(422, "The origin is not a valid absolute URL.");
    renderDialog();
    const user = await fillIn({ origin: "example.com" });

    await user.click(registerButton());

    await waitFor(() =>
      expect(screen.getByText(/not a valid absolute URL/)).toBeTruthy(),
    );
    expect((originField() as HTMLInputElement).value).toBe("example.com");
    expect(isAcknowledged()).toBe(true);
    expect(screen.getByTestId("path").textContent).toBe("/targets");
  });

  test("says something useful when the failure is not from the API", async () => {
    failWith = new Error("Failed to fetch");
    renderDialog();
    const user = await fillIn();

    await user.click(registerButton());

    await waitFor(() =>
      expect(screen.getByText("Failed to fetch")).toBeTruthy(),
    );
  });
});

describe("when registration succeeds", () => {
  test("goes straight to verifying ownership", async () => {
    // A registered target is useless until it is verified, so leaving the user
    // on the list would leave every new target one step short of scannable.
    renderDialog();
    const user = await fillIn();

    await user.click(registerButton());

    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe(
        "/targets/target-9/verify",
      ),
    );
  });

  test("closes the dialog and clears it", async () => {
    renderDialog();
    const user = await fillIn();

    await user.click(registerButton());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(screen.getByRole("button", { name: "Open register" }));
    await screen.findByRole("dialog");
    expect((labelField() as HTMLInputElement).value).toBe("");
    expect(isAcknowledged()).toBe(false);
  });
});
