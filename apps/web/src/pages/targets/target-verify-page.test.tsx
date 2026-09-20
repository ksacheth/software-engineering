import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor } from "@testing-library/react";
import type { Target, VerificationInstructions } from "@/services/targets";
import {
  aTarget,
  dnsInstructions,
  wellKnownInstructions,
} from "@/test-support/fixtures";
import { resetMocks, stub, TargetApiError } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * The verification page (F.2).
 *
 * It exists so the challenge can be sent to whoever actually controls the DNS
 * zone or the web root, who is often not the person who registered the target.
 * That makes the URL the deliverable, and the page has to stand on its own: it
 * loads the target itself rather than taking it from the list, and says so
 * plainly when the identifier in the URL means nothing.
 */

let response: {
  target: Target;
  instructions: VerificationInstructions;
  scannable: { scannable: boolean; reason?: "NOT_VERIFIED" };
} | null = null;
let loadFails: Error | null = null;
let loadHangs = false;
const loaded: string[] = [];

const { TargetVerifyPage } = await import("./target-verify-page");

const renderVerify = () =>
  renderPage(<TargetVerifyPage />, {
    path: "/targets/:id/verify",
    route: "/targets/target-1/verify",
  });

/** Render and wait for the target to arrive. */
async function renderLoaded(overrides: Partial<Target> = {}) {
  response = {
    target: aTarget({
      verificationStatus: "UNVERIFIED",
      verifiedAt: null,
      ...overrides,
    }),
    instructions: dnsInstructions(),
    scannable: { scannable: false, reason: "NOT_VERIFIED" },
  };
  const view = renderVerify();
  await waitFor(() => expect(screen.getByText("Corporate site")).toBeTruthy());
  return view;
}

beforeEach(() => {
  resetMocks();
  loaded.length = 0;
  loadFails = null;
  loadHangs = false;
  response = null;
  stub.targets("getTarget", (async (id: string) => {
    loaded.push(id);
    if (loadHangs) return new Promise(() => {});
    if (loadFails) throw loadFails;
    return response;
  }) as never);
});

describe("loading the target named in the URL", () => {
  test("asks for the identifier from the path", async () => {
    // The page is reached by a link that was pasted to someone else, so there
    // is no list in memory to take the target from.
    await renderLoaded();

    expect(loaded).toEqual(["target-1"]);
  });

  test("shows a spinner rather than an empty challenge", () => {
    loadHangs = true;
    renderVerify();

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByLabelText("Record Name")).toBeNull();
  });
});

describe("when the target cannot be loaded", () => {
  test("says so and offers a way back", async () => {
    // Nothing on this page works without the target, so a bare error with no
    // exit leaves the recipient of the link stranded.
    loadFails = new TargetApiError(404, "Target not found.");
    renderVerify();

    await waitFor(() =>
      expect(screen.getByText("Error loading target")).toBeTruthy(),
    );
    expect(screen.getByText("Target not found.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Back to Targets/ }).getAttribute("href"),
    ).toBe("/targets");
  });

  test("does not show the challenge alongside the error", async () => {
    loadFails = new Error("Failed to fetch");
    renderVerify();

    await waitFor(() => expect(screen.getByText("Failed to fetch")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Verify ownership/ })).toBeNull();
  });
});

describe("the header", () => {
  test("names the target and where it stands", async () => {
    await renderLoaded();

    expect(screen.getByRole("heading", { name: "Corporate site" })).toBeTruthy();
    expect(screen.getByText("Unverified")).toBeTruthy();
  });

  test("spells out why the target is not scannable yet", async () => {
    // This page is the answer to that question, so the reason belongs in the
    // open rather than behind a tooltip.
    await renderLoaded();

    expect(screen.getByText("Ownership not verified")).toBeTruthy();
  });

  test("links back to the target and to the list", async () => {
    await renderLoaded();

    expect(
      screen
        .getByRole("link", { name: /Back to Target Details/ })
        .getAttribute("href"),
    ).toBe("/targets/target-1");
    expect(
      screen.getByRole("link", { name: "All Targets" }).getAttribute("href"),
    ).toBe("/targets");
  });
});

describe("the challenge itself", () => {
  test("shows the instructions the API issued for this target", async () => {
    await renderLoaded();

    expect(
      (screen.getByLabelText("Record Name") as HTMLInputElement).value,
    ).toBe("_wvs-challenge.a.test");
    expect(screen.getByRole("button", { name: /Verify ownership/ })).toBeTruthy();
  });

  test("shows the well-known challenge when that is the method on the target", async () => {
    // The method is chosen at registration and cannot be swapped here, so the
    // page has to render whichever one the API issued.
    response = {
      target: aTarget({
        verificationMethod: "WELL_KNOWN",
        verificationStatus: "UNVERIFIED",
        verifiedAt: null,
      }),
      instructions: wellKnownInstructions(),
      scannable: { scannable: false, reason: "NOT_VERIFIED" },
    };
    renderVerify();

    await waitFor(() =>
      expect(screen.getByLabelText("Verification URL")).toBeTruthy(),
    );
    expect(screen.queryByLabelText("Record Name")).toBeNull();
  });
});
