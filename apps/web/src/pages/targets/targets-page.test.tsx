import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { TargetWithScannable } from "@/services/targets";
import { aListedTarget } from "@/test-support/fixtures";
import { resetMocks, stub, TargetApiError } from "@/test-support/mocks";
import { renderPage } from "@/test-support/render";

/**
 * The target list (F.2).
 *
 * This is where a user decides what to do next, so the list has to be honest
 * about two things the rest of the product refuses on: whether a target may be
 * scanned, and whether its proof of ownership is about to lapse. C.2 gives
 * ninety days, and a verification that expires unnoticed stops scans that were
 * running fine the day before. The warning band is the only notice there is.
 *
 * Archived targets are hidden by default and fetched, not filtered here: the
 * server decides what the organisation may see, and a client-side filter over a
 * default response would show an empty list rather than the archived rows.
 */

const NOW = new Date("2026-09-21T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

/** Arguments `fetchTargets` was called with, in order. */
const listCalls: boolean[] = [];
let listResult: TargetWithScannable[] = [];
let listFails: Error | null = null;
let listHangs = false;

const { TargetsPage } = await import("./targets-page");

const renderTargets = () =>
  renderPage(<TargetsPage />, { path: "/targets", route: "/targets" });

/** Render and wait for the first response to land. */
async function renderList(targets: TargetWithScannable[]) {
  listResult = targets;
  const view = renderTargets();
  await waitFor(() => expect(listCalls).toHaveLength(1));
  return view;
}

const rowFor = (label: string) =>
  screen.getByRole("link", { name: label }).closest("tr")!;

beforeEach(() => {
  resetMocks();
  setSystemTime(NOW);
  listCalls.length = 0;
  listResult = [];
  listFails = null;
  listHangs = false;
  stub.targets("fetchTargets", (async (includeArchived: boolean) => {
    listCalls.push(includeArchived);
    if (listHangs) return new Promise(() => {});
    if (listFails) throw listFails;
    return { targets: listResult };
  }) as never);
});

afterEach(() => {
  setSystemTime();
});

describe("while the list is loading", () => {
  test("shows a spinner and no empty state", () => {
    // The empty state invites the user to register a target. Showing it before
    // the response lands would tell someone with ten targets they have none.
    listHangs = true;
    renderTargets();

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("No targets registered")).toBeNull();
  });
});

describe("when the list cannot be loaded", () => {
  test("says so and keeps the message from the API", async () => {
    listFails = new TargetApiError(503, "The database is unavailable.");
    renderTargets();

    await waitFor(() =>
      expect(screen.getByText("Failed to load targets")).toBeTruthy(),
    );
    expect(screen.getByText("The database is unavailable.")).toBeTruthy();
  });

  test("does not fall back to the empty state", async () => {
    // An error and an empty organisation are different situations, and the
    // empty state's advice (register a target) is wrong for the first.
    listFails = new Error("Failed to fetch");
    renderTargets();

    await waitFor(() => expect(screen.getByText("Failed to fetch")).toBeTruthy());
    expect(screen.queryByText("No targets registered")).toBeNull();
  });
});

describe("when there are no targets", () => {
  test("invites the user to register one", async () => {
    await renderList([]);

    await waitFor(() =>
      expect(screen.getByText("No targets registered")).toBeTruthy(),
    );
    expect(screen.getByText(/Register a target origin/)).toBeTruthy();
  });

  test("blames the filter once archived targets are included", async () => {
    // With archived rows already included there is nothing left to reveal, so
    // repeating the registration advice would be a dead end.
    await renderList([]);
    await screen.findByText("No targets registered");

    await userEvent.setup().click(screen.getByLabelText("Show archived"));

    await waitFor(() =>
      expect(screen.getByText("No targets match the current filter.")).toBeTruthy(),
    );
  });
});

describe("the archived filter", () => {
  test("asks the server for the unarchived list first", async () => {
    await renderList([]);
    expect(listCalls).toEqual([false]);
  });

  test("re-asks the server rather than filtering what it already has", async () => {
    // Archived targets are absent from the default response, not hidden in it.
    await renderList([aListedTarget()]);

    await userEvent.setup().click(screen.getByLabelText("Show archived"));

    await waitFor(() => expect(listCalls).toEqual([false, true]));
  });
});

describe("a row", () => {
  const target = aListedTarget({
    label: "Corporate site",
    origin: "https://a.test",
  });

  test("links to the target and to the origin itself", async () => {
    await renderList([target]);
    const row = await waitFor(() => rowFor("Corporate site"));

    expect(
      within(row).getByRole("link", { name: "Corporate site" }).getAttribute("href"),
    ).toBe("/targets/target-1");
    expect(
      within(row).getByRole("link", { name: /https:\/\/a.test/ }).getAttribute("href"),
    ).toBe("https://a.test");
  });

  test("opens the origin without handing it the dashboard window", async () => {
    // `target=_blank` without `noopener` gives the opened page a handle on the
    // dashboard through `window.opener`, and the origin here is by definition
    // one nobody has audited.
    await renderList([target]);
    const row = await waitFor(() => rowFor("Corporate site"));
    const origin = within(row).getByRole("link", { name: /https:\/\/a.test/ });

    expect(origin.getAttribute("target")).toBe("_blank");
    expect(origin.getAttribute("rel")).toContain("noopener");
  });

  test("shows the verification status and the verdict", async () => {
    await renderList([
      aListedTarget({
        label: "Unproven",
        verificationStatus: "UNVERIFIED",
        scannable: { scannable: false, reason: "NOT_VERIFIED" },
      }),
    ]);
    const row = await waitFor(() => rowFor("Unproven"));

    expect(within(row).getByText("Unverified")).toBeTruthy();
    expect(within(row).getByText("Not Scannable")).toBeTruthy();
  });

  test("marks an archived target and drops its verify action", async () => {
    // Nothing can be done to an archived target until it is restored, so
    // offering the challenge would walk the user into a refusal.
    await renderList([
      aListedTarget({
        label: "Old site",
        isArchived: true,
        verificationStatus: "UNVERIFIED",
        scannable: { scannable: false, reason: "ARCHIVED" },
      }),
    ]);
    const row = await waitFor(() => rowFor("Old site"));

    expect(within(row).getByText("Archived")).toBeTruthy();
    expect(within(row).queryByRole("link", { name: /Verify/ })).toBeNull();
  });

  test("offers the challenge for a target that still needs one", async () => {
    await renderList([
      aListedTarget({ label: "Unproven", verificationStatus: "PENDING" }),
    ]);
    const row = await waitFor(() => rowFor("Unproven"));

    expect(
      within(row).getByRole("link", { name: /Verify/ }).getAttribute("href"),
    ).toBe("/targets/target-1/verify");
  });

  test("does not offer the challenge for a verified target", async () => {
    await renderList([target]);
    const row = await waitFor(() => rowFor("Corporate site"));

    expect(within(row).queryByRole("link", { name: /Verify/ })).toBeNull();
    expect(within(row).getByRole("link", { name: /Details/ })).toBeTruthy();
  });
});

describe("the expiry column", () => {
  /** Read the rendered expiry cell of the only row. */
  const expiryCell = () =>
    screen.getAllByRole("row")[1]!.querySelectorAll("td")[3]!;

  test("warns when verification lapses within a fortnight", async () => {
    // C.2 refuses a scan the moment verification expires. Two weeks is the
    // notice the user gets to re-run a DNS challenge that may need a change
    // request, so the row has to look different rather than only read
    // differently.
    await renderList([
      aListedTarget({
        verificationExpiresAt: new Date(NOW.getTime() + 10 * DAY).toISOString(),
      }),
    ]);
    await waitFor(() => rowFor("Corporate site"));

    expect(expiryCell().innerHTML).toContain("amber");
  });

  test("leaves a verification with months left alone", async () => {
    await renderList([
      aListedTarget({
        verificationExpiresAt: new Date(NOW.getTime() + 60 * DAY).toISOString(),
      }),
    ]);
    await waitFor(() => rowFor("Corporate site"));

    expect(expiryCell().innerHTML).not.toContain("amber");
  });

  test("does not warn about an expiry that has already passed", async () => {
    // The status badge already says EXPIRED. A countdown alongside it would
    // suggest there is still time.
    await renderList([
      aListedTarget({
        verificationStatus: "EXPIRED",
        verificationExpiresAt: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ]);
    await waitFor(() => rowFor("Corporate site"));

    expect(expiryCell().innerHTML).not.toContain("amber");
  });

  test("does not warn about an expiry that has passed but is still recorded as verified", async () => {
    // The status column is only re-evaluated when the API next looks at the
    // target, so a verification can be past its expiry while the row still
    // reads VERIFIED. The warning is about time remaining, and there is none.
    await renderList([
      aListedTarget({
        verificationExpiresAt: new Date(NOW.getTime() - DAY).toISOString(),
      }),
    ]);
    await waitFor(() => rowFor("Corporate site"));

    expect(expiryCell().innerHTML).not.toContain("amber");
  });

  test("shows a dash for a target that has never been verified", async () => {
    await renderList([
      aListedTarget({
        verificationStatus: "UNVERIFIED",
        verifiedAt: null,
        verificationExpiresAt: null,
      }),
    ]);
    await waitFor(() => rowFor("Corporate site"));

    expect(expiryCell().textContent).toBe("—");
  });
});

describe("registering from this page", () => {
  test("opens the dialog from the header", async () => {
    await renderList([aListedTarget()]);
    await waitFor(() => rowFor("Corporate site"));

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Register Target/ }),
    );

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  test("opens the same dialog from the empty state", async () => {
    // The empty state is where a first-time user starts, and its button is a
    // second call site that has to reach the same place.
    await renderList([]);
    await screen.findByText("No targets registered");

    await userEvent.setup().click(
      screen.getAllByRole("button", { name: /Register Target/ }).at(-1)!,
    );

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });
});
