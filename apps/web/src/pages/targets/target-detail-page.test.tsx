import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ScannableVerdict, Target } from "@/services/targets";
import { aTarget, dnsInstructions } from "@/test-support/fixtures";
import { resetMocks, stub, TargetApiError, toasts } from "@/test-support/mocks";
import { currentPath, renderPage } from "@/test-support/render";

/**
 * The target detail page (F.2).
 *
 * Everything C.2 turns on is recorded here, so the page's job is to report it
 * rather than to decide it: the verdict, the attestation and the verified
 * address set all come from the API and are shown as they are. The one piece of
 * judgement the page does exercise is the expiry warning, which is the only
 * notice a user gets that scans are about to start being refused.
 *
 * The two destructive actions are deliberately unlike each other. Archiving is
 * reversible and goes through on one click; deleting takes the scans and their
 * findings with it, so it asks first and names the origin it is about to
 * remove.
 */

const NOW = new Date("2026-09-21T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

let target: Target = aTarget();
let scannable: ScannableVerdict = { scannable: true };
let loadFails: Error | null = null;
let loadHangs = false;

const archived: string[] = [];
const deleted: string[] = [];
let archiveFails: Error | null = null;
let deleteFails: Error | null = null;
let canWrite = true;

const { TargetDetailPage } = await import("./target-detail-page");

const renderDetail = () =>
  renderPage(<TargetDetailPage />, {
    path: "/targets/:id",
    route: "/targets/target-1",
  });

/** Render and wait for the target to arrive. */
async function renderLoaded(overrides: Partial<Target> = {}) {
  target = aTarget(overrides);
  const view = renderDetail();
  await waitFor(() =>
    expect(screen.getByRole("heading", { name: "Corporate site" })).toBeTruthy(),
  );
  return view;
}

const deleteTrigger = () =>
  screen.getByRole("button", { name: /Delete Target/ });

/** Open the confirmation and press the button that actually deletes. */
async function confirmDelete() {
  const user = userEvent.setup();
  await user.click(deleteTrigger());
  const dialog = await screen.findByRole("alertdialog");
  await user.click(within(dialog).getByRole("button", { name: "Delete" }));
}

beforeEach(() => {
  resetMocks();
  setSystemTime(NOW);
  target = aTarget();
  scannable = { scannable: true };
  loadFails = null;
  loadHangs = false;
  archived.length = 0;
  deleted.length = 0;
  archiveFails = null;
  deleteFails = null;
  canWrite = true;

  stub.role("useCanWrite", (() => canWrite) as never);
  stub.targets("getTarget", (async () => {
    if (loadHangs) return new Promise(() => {});
    if (loadFails) throw loadFails;
    return { target, instructions: dnsInstructions(), scannable };
  }) as never);
  stub.targets("archiveTarget", (async (id: string) => {
    archived.push(id);
    if (archiveFails) throw archiveFails;
    return { target: { ...target, isArchived: true } };
  }) as never);
  stub.targets("deleteTarget", (async (id: string) => {
    deleted.push(id);
    if (deleteFails) throw deleteFails;
  }) as never);
});

afterEach(() => {
  setSystemTime();
});

describe("loading", () => {
  test("shows a spinner rather than a half-built page", () => {
    loadHangs = true;
    renderDetail();

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("Verification Lifecycle")).toBeNull();
  });

  test("says so and offers a way back when the target cannot be loaded", async () => {
    loadFails = new TargetApiError(404, "Target not found.");
    renderDetail();

    await waitFor(() =>
      expect(screen.getByText("Error loading target")).toBeTruthy(),
    );
    expect(screen.getByText("Target not found.")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /Back to Targets/ }).getAttribute("href"),
    ).toBe("/targets");
  });

  test("offers no destructive action against a target it could not load", async () => {
    // The identifier from the URL would be enough to archive or delete, and a
    // target that failed to load is exactly the one the user knows least about.
    loadFails = new Error("Failed to fetch");
    renderDetail();

    await waitFor(() => expect(screen.getByText("Failed to fetch")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Delete Target/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /Archive Target/ })).toBeNull();
  });
});

describe("what the page reports", () => {
  test("shows the verdict the API reached, not one of its own", async () => {
    // C.2 is decided by the API against the verified address set. A second
    // opinion computed here would disagree with the refusal the user then meets.
    scannable = { scannable: false, reason: "NO_VERIFIED_ADDRESSES" };
    await renderLoaded({ verificationStatus: "VERIFIED" });

    expect(screen.getByText("Not Scannable")).toBeTruthy();
    expect(
      screen.getByText("No verified addresses recorded (fails closed)"),
    ).toBeTruthy();
  });

  test("names the challenge method in words rather than as a constant", async () => {
    await renderLoaded({ verificationMethod: "WELL_KNOWN" });

    expect(screen.getByText("Well-Known File")).toBeTruthy();
  });

  test("lists the verified addresses the Scope Guard is pinned to", async () => {
    await renderLoaded({ verifiedIpRanges: ["93.184.216.34/32", "2606:2800::1/128"] });

    expect(screen.getByText("93.184.216.34/32")).toBeTruthy();
    expect(screen.getByText("2606:2800::1/128")).toBeTruthy();
  });

  test("says the address set is empty rather than showing nothing", async () => {
    // ADR-0004 fails closed on an empty set, and an empty card would read as a
    // target with no restrictions rather than one that cannot be scanned.
    await renderLoaded({ verifiedIpRanges: [] });

    expect(
      screen.getByText("No Verified Addresses (Fails Closed)"),
    ).toBeTruthy();
  });

  test("reports the attestation that was actually recorded", async () => {
    // The attestation is a legal record. Stating it as a constant would have
    // the page vouch for a claim the row does not carry, and F.2 makes it
    // unamendable, so there is no way for the user to correct the difference.
    await renderLoaded({
      authorisationAck: false,
      authorisationAckAt: null,
      authorisationAckById: null,
    });

    expect(screen.getByText("Not acknowledged")).toBeTruthy();
    expect(screen.queryByText("Acknowledged")).toBeNull();
  });

  test("reports an attestation that was recorded", async () => {
    await renderLoaded({ authorisationAck: true });

    expect(screen.getByText("Acknowledged")).toBeTruthy();
  });
});

describe("the expiry warning", () => {
  test("warns while verification is within a fortnight of lapsing", async () => {
    // Re-running a DNS challenge can need a change request on someone else's
    // zone, so the notice has to arrive well before scans start failing.
    await renderLoaded({
      verificationStatus: "VERIFIED",
      verificationExpiresAt: new Date(NOW.getTime() + 3 * DAY).toISOString(),
    });

    expect(
      screen.getByText("Ownership Verification Expiring Soon"),
    ).toBeTruthy();
    expect(screen.getByText(/expires in 3 days/)).toBeTruthy();
  });

  test("counts the last day in the singular", async () => {
    await renderLoaded({
      verificationStatus: "VERIFIED",
      verificationExpiresAt: new Date(NOW.getTime() + 12 * 60 * 60 * 1000).toISOString(),
    });

    expect(screen.getByText(/expires in 1 day\b/)).toBeTruthy();
  });

  test("stays quiet when there are months left", async () => {
    await renderLoaded({
      verificationStatus: "VERIFIED",
      verificationExpiresAt: new Date(NOW.getTime() + 60 * DAY).toISOString(),
    });

    expect(screen.queryByText("Ownership Verification Expiring Soon")).toBeNull();
  });

  test("does not count down an expiry that has passed but is still recorded as verified", async () => {
    // The stored status lags the clock: it changes when the API next looks at
    // the target. Without a check that time is actually left, the band counts
    // down through zero and announces a negative number of days.
    await renderLoaded({
      verificationStatus: "VERIFIED",
      verificationExpiresAt: new Date(NOW.getTime() - DAY).toISOString(),
    });

    expect(screen.queryByText("Ownership Verification Expiring Soon")).toBeNull();
  });

  test("does not count down an expiry that has already passed", async () => {
    // The status badge says EXPIRED and the challenge card is already open. A
    // countdown beside them would suggest there is still time.
    scannable = { scannable: false, reason: "VERIFICATION_EXPIRED" };
    await renderLoaded({
      verificationStatus: "EXPIRED",
      verificationExpiresAt: new Date(NOW.getTime() - DAY).toISOString(),
    });

    expect(screen.queryByText("Ownership Verification Expiring Soon")).toBeNull();
  });
});

describe("the verification challenge", () => {
  test("is open for a target that still needs it", async () => {
    await renderLoaded({ verificationStatus: "UNVERIFIED", verifiedAt: null });

    expect(screen.getByText("Ownership Verification")).toBeTruthy();
  });

  test("is out of the way for a target that is already verified", async () => {
    await renderLoaded({ verificationStatus: "VERIFIED" });

    expect(screen.queryByText("Ownership Verification")).toBeNull();
  });

  test("can be brought back to re-verify before expiry", async () => {
    // Re-verifying early is the only way to avoid the gap, and it has to be
    // possible before the verification has lapsed.
    await renderLoaded({ verificationStatus: "VERIFIED" });

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Re-verify/ }),
    );

    expect(await screen.findByText("Ownership Verification")).toBeTruthy();
  });
});

describe("starting a scan from here", () => {
  test("is offered to a user who may start one", async () => {
    await renderLoaded();

    expect(screen.getByRole("button", { name: /Start Scan/ })).toBeTruthy();
  });

  test("is not offered to a read-only user", async () => {
    // F.1. The API refuses a VIEWER either way, so this is a courtesy rather
    // than a control, but a control that only ever produces a refusal teaches
    // the user to distrust the interface.
    canWrite = false;
    await renderLoaded();

    expect(screen.queryByRole("button", { name: /Start Scan/ })).toBeNull();
  });
});

describe("archiving", () => {
  test("archives the target and says it happened", async () => {
    await renderLoaded();

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Archive Target/ }),
    );

    await waitFor(() => expect(archived).toEqual(["target-1"]));
    expect(toasts).toContainEqual({
      kind: "success",
      message: "Target archived",
    });
  });

  test("is not offered for a target that is already archived", async () => {
    await renderLoaded({ isArchived: true, archivedAt: NOW.toISOString() });

    expect(screen.queryByRole("button", { name: /Archive Target/ })).toBeNull();
    expect(screen.getByText("Target Archived")).toBeTruthy();
  });

  test("reports a refusal instead of claiming success", async () => {
    archiveFails = new TargetApiError(403, "Only an admin may archive a target.");
    await renderLoaded();

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Archive Target/ }),
    );

    await waitFor(() =>
      expect(toasts).toContainEqual({
        kind: "error",
        message: "Only an admin may archive a target.",
      }),
    );
    expect(toasts).not.toContainEqual({
      kind: "success",
      message: "Target archived",
    });
  });
});

describe("deleting", () => {
  test("asks first, and names what goes with it", async () => {
    // Deleting takes the scans and their findings, which are the evidence the
    // organisation keeps. One misplaced click should not be enough.
    await renderLoaded();

    await userEvent.setup().click(deleteTrigger());

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("https://a.test")).toBeTruthy();
    expect(within(dialog).getByText(/cannot be undone/)).toBeTruthy();
    expect(deleted).toHaveLength(0);
  });

  test("does nothing if the confirmation is dismissed", async () => {
    await renderLoaded();
    const user = userEvent.setup();

    await user.click(deleteTrigger());
    const dialog = await screen.findByRole("alertdialog");
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(deleted).toHaveLength(0);
  });

  test("deletes once confirmed and leaves the page behind", async () => {
    // The target no longer exists, so staying would leave the user looking at
    // a page whose next request is a 404.
    await renderLoaded();

    await confirmDelete();

    await waitFor(() => expect(deleted).toEqual(["target-1"]));
    await waitFor(() => expect(currentPath()).toBe("/targets"));
    expect(toasts).toContainEqual({
      kind: "success",
      message: "Target deleted",
    });
  });

  test("stays put when the deletion is refused", async () => {
    deleteFails = new TargetApiError(403, "Only an admin may delete a target.");
    await renderLoaded();

    await confirmDelete();

    await waitFor(() =>
      expect(toasts).toContainEqual({
        kind: "error",
        message: "Only an admin may delete a target.",
      }),
    );
    expect(currentPath()).toBe("/targets/target-1");
  });
});
