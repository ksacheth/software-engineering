import { beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { SCAN_PROFILE_PRESETS } from "@wvs/shared";
import { ScanApiError, type StartScanInput } from "@/services/scans";
import { aTarget } from "@/test-support/fixtures";
import { resetMocks, stub, toasts } from "@/test-support/mocks";

/**
 * Starting a scan (F.3).
 *
 * Two things here are not cosmetic. The trigger is disabled for a target that
 * may not be scanned, which is C.2 showing up in the interface: the API refuses
 * it regardless, but offering a button that cannot work teaches the user the
 * check is arbitrary. And the limits shown come from the same presets the API
 * applies, so what the dialog promises is what the scan runs with.
 *
 * The request body is asserted directly. Whether `configuration` is sent at all
 * decides whether the server applies the preset or the user's numbers, and
 * getting that backwards is invisible until a scan runs at the wrong rate.
 */

const requests: StartScanInput[] = [];
let failWith: Error | null = null;

const { StartScanDialog } = await import("./start-scan-dialog");

function CurrentPath() {
  return <span data-testid="path">{useLocation().pathname}</span>;
}

function renderDialog({
  scannable = true,
  reason,
}: { scannable?: boolean; reason?: string } = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/targets/target-1"]}>
        <Routes>
          <Route path="*" element={<>{children}</>} />
        </Routes>
        <CurrentPath />
      </MemoryRouter>
    </QueryClientProvider>
  );

  return render(
    <StartScanDialog
      target={aTarget()}
      scannable={
        scannable
          ? { scannable: true }
          : { scannable: false, reason: reason as never }
      }
    />,
    { wrapper },
  );
}

const trigger = () => screen.getByRole("button", { name: /Start Scan/ });
const submit = () =>
  screen.getAllByRole("button", { name: /Start Scan/ }).at(-1)!;

async function open() {
  await userEvent.setup().click(trigger());
  await screen.findByRole("dialog");
}

beforeEach(() => {
  resetMocks();
  requests.length = 0;
  failWith = null;
  stub.scans("startScan", (async (input: StartScanInput) => {
    requests.push(input);
    if (failWith) throw failWith;
    return { scan: { id: "scan-42" } };
  }) as never);
});

describe("the trigger", () => {
  test("is offered for a target that may be scanned", () => {
    renderDialog();
    expect(trigger().hasAttribute("disabled")).toBe(false);
  });

  test("is refused for a target that may not, and says why", async () => {
    // C.2 in the interface. The API refuses it either way, so the value here is
    // that the user learns the reason instead of meeting a rejection.
    renderDialog({ scannable: false, reason: "NOT_VERIFIED" });

    expect(trigger().hasAttribute("disabled")).toBe(true);
    expect(trigger().getAttribute("title")).toBe("Ownership not verified");
  });

  test("explains an expired verification as its own reason", async () => {
    // Distinct from never having been verified: the user has to re-verify
    // rather than start from scratch.
    renderDialog({ scannable: false, reason: "VERIFICATION_EXPIRED" });

    expect(trigger().getAttribute("title")).toContain("expired");
  });
});

describe("choosing a profile", () => {
  test("starts on the standard profile and shows what it will run with", async () => {
    await renderDialogAndOpen();

    const standard = SCAN_PROFILE_PRESETS.STANDARD;
    expect(
      screen.getByText(
        new RegExp(`Will run with: ${standard.rateLimit} req/s`),
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(new RegExp(`depth ${standard.maxDepth}`)),
    ).toBeTruthy();
  });

  test("updates the summary when another profile is picked", async () => {
    await renderDialogAndOpen();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /PASSIVE/ }));

    const passive = SCAN_PROFILE_PRESETS.PASSIVE;
    await waitFor(() =>
      expect(
        screen.getByText(new RegExp(`Will run with: ${passive.rateLimit} req/s`)),
      ).toBeTruthy(),
    );
  });

  test("sends the profile and leaves the limits to the server", async () => {
    // Without `configuration`, the API applies the preset itself. Sending a
    // copy would freeze today's preset into every scan started from this
    // dialog, so a later change to the preset would not reach them.
    await renderDialogAndOpen();
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /THOROUGH/ }));
    await user.click(submit());

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toEqual({
      targetId: "target-1",
      profile: "THOROUGH",
      configuration: undefined,
    });
  });
});

describe("customising the limits", () => {
  async function customise() {
    await renderDialogAndOpen();
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("Customise limits"));
    return user;
  }

  test("offers the profile value as the placeholder for each field", async () => {
    await customise();

    expect(
      (screen.getByLabelText("Crawl depth") as HTMLInputElement).placeholder,
    ).toBe(String(SCAN_PROFILE_PRESETS.STANDARD.maxDepth));
  });

  test("keeps the profile value for a field left blank", async () => {
    // "Leave a field blank to keep the profile value" is what the dialog
    // promises, and a blank parsed as zero would mean a scan that does nothing.
    const user = await customise();

    await user.click(screen.getByLabelText("Requests / second"));
    await user.keyboard("3");
    await user.click(submit());

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.configuration).toEqual({
      ...SCAN_PROFILE_PRESETS.STANDARD,
      rateLimit: 3,
    });
  });

  test("keeps the profile value for a field the user typed into and cleared", async () => {
    // The only way a blank reaches the parser, and the case that matters:
    // `Number("")` is zero, so a cleared field would silently ask for a scan
    // bounded at zero rather than one that keeps the preset.
    const user = await customise();
    const depth = screen.getByLabelText("Crawl depth");

    await user.click(depth);
    await user.keyboard("9");
    await user.clear(depth);
    await user.click(submit());

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]!.configuration!.maxDepth).toBe(
      SCAN_PROFILE_PRESETS.STANDARD.maxDepth,
    );
  });

  test("shows the effective limits before the user commits", async () => {
    const user = await customise();

    await user.click(screen.getByLabelText("Crawl depth"));
    await user.keyboard("2");

    await waitFor(() =>
      expect(screen.getByText(/depth 2/)).toBeTruthy(),
    );
  });

  test("bounds each field at system policy", async () => {
    // F.8 caps the request rate at ten per second. The input carries the bound
    // so the browser refuses before the server has to.
    await customise();

    const rate = screen.getByLabelText("Requests / second") as HTMLInputElement;
    expect(rate.max).toBe("10");
    expect(rate.min).toBe("1");
  });
});

describe("when the server refuses", () => {
  test("lists every refused value at once", async () => {
    // One field at a time turns a configuration mistake into a guessing game.
    failWith = new ScanApiError(400, "The scan configuration is invalid.", {
      code: "INVALID_CONFIGURATION",
      errors: [
        { pointer: "/configuration/rateLimit", detail: "Rate above policy." },
        { pointer: "/configuration/maxDepth", detail: "Depth above policy." },
      ],
    });
    await renderDialogAndOpen();

    await userEvent.setup().click(submit());

    await waitFor(() => expect(screen.getByText("Scan refused")).toBeTruthy());
    expect(screen.getByText("Rate above policy.")).toBeTruthy();
    expect(screen.getByText("Depth above policy.")).toBeTruthy();
  });

  test("falls back to the message when there are no field errors", async () => {
    failWith = new ScanApiError(409, "This target already has a scan running.");
    await renderDialogAndOpen();

    await userEvent.setup().click(submit());

    await waitFor(() =>
      expect(
        screen.getByText("This target already has a scan running."),
      ).toBeTruthy(),
    );
  });

  test("still says something when the failure is not from the API", async () => {
    // A network error has no problem document, and an empty alert would read
    // as the scan having started.
    failWith = new Error("Failed to fetch");
    await renderDialogAndOpen();

    await userEvent.setup().click(submit());

    await waitFor(() =>
      expect(screen.getByText("Failed to fetch")).toBeTruthy(),
    );
  });

  test("keeps the dialog open so the user can correct it", async () => {
    failWith = new ScanApiError(409, "Already running.");
    await renderDialogAndOpen();

    await userEvent.setup().click(submit());

    await waitFor(() => expect(screen.getByText("Already running.")).toBeTruthy());
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByTestId("path").textContent).toBe("/targets/target-1");
  });
});

describe("when the scan is queued", () => {
  test("goes to the new scan", async () => {
    // The scan is the thing the user now wants to watch, and finding it by
    // hand in the list is busywork.
    await renderDialogAndOpen();

    await userEvent.setup().click(submit());

    await waitFor(() =>
      expect(screen.getByTestId("path").textContent).toBe("/scans/scan-42"),
    );
    expect(toasts).toContainEqual({ kind: "success", message: "Scan queued" });
  });

  test("closes the dialog", async () => {
    await renderDialogAndOpen();

    await userEvent.setup().click(submit());

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

/** Render with a scannable target and open the dialog. */
async function renderDialogAndOpen() {
  const view = renderDialog();
  await open();
  return view;
}
