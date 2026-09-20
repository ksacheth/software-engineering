import { beforeEach, describe, expect, test } from "bun:test";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Scan, ScanListFilters } from "@/services/scans";
import { aListedTarget, aScan } from "@/test-support/fixtures";
import { resetMocks, stub, ScanApiError } from "@/test-support/mocks";
import { currentPath, renderPage } from "@/test-support/render";

/**
 * The scan list (F.3).
 *
 * The list is the only view of work in flight across the whole organisation, so
 * the two filters have to reach the server rather than sift what is already on
 * screen: the list is paged, and a client-side filter would search one page and
 * report nothing for a scan two pages down.
 *
 * A row is clickable and also carries a link. The click is a convenience and
 * the link is what makes a scan reachable by keyboard and by a screen reader,
 * which SRS §3.2.1 requires, so the link has to survive and must not open the
 * scan twice by letting its own click reach the row.
 */

interface Call {
  filters: ScanListFilters;
  cursor: string | undefined;
}

const calls: Call[] = [];
let pages: { scans: Scan[]; nextCursor: string | null }[] = [];
let listFails: Error | null = null;
let listHangs = false;

const { ScansPage } = await import("./scans-page");

const renderScans = () =>
  renderPage(<ScansPage />, { path: "/scans", route: "/scans" });

/** Render and wait for the first page of scans to land. */
async function renderScanList(scans: Scan[]) {
  pages = [{ scans, nextCursor: null }];
  const view = renderScans();
  await waitFor(() => expect(calls.length).toBeGreaterThan(0));
  return view;
}

const rowFor = (label: string) =>
  screen.getByRole("link", { name: label }).closest("tr")!;

/** Pick an option from one of the two filters, as a mouse user would. */
async function choose(filter: string, option: string) {
  const user = userEvent.setup();
  await user.click(screen.getByLabelText(filter));
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  resetMocks();
  calls.length = 0;
  pages = [{ scans: [], nextCursor: null }];
  listFails = null;
  listHangs = false;

  stub.scans("fetchScans", (async (filters: ScanListFilters, cursor?: string) => {
    calls.push({ filters, cursor });
    if (listHangs) return new Promise(() => {});
    if (listFails) throw listFails;
    return pages[cursor ? 1 : 0] ?? { scans: [], nextCursor: null };
  }) as never);

  stub.targets("fetchTargets", (async () => ({
    targets: [
      aListedTarget({ id: "target-1", label: "Corporate site" }),
      aListedTarget({ id: "target-2", label: "Docs site" }),
    ],
  })) as never);
});

describe("while the list is loading", () => {
  test("shows a spinner rather than an empty list", () => {
    listHangs = true;
    renderScans();

    expect(screen.getByRole("status", { name: "Loading" })).toBeTruthy();
    expect(screen.queryByText("No scans yet")).toBeNull();
  });
});

describe("when the list cannot be loaded", () => {
  test("says so and keeps the message from the API", async () => {
    listFails = new ScanApiError(500, "Scan history is unavailable.");
    renderScans();

    await waitFor(() =>
      expect(screen.getByText("Failed to load scans")).toBeTruthy(),
    );
    expect(screen.getByText("Scan history is unavailable.")).toBeTruthy();
  });

  test("does not offer the empty state as well", async () => {
    listFails = new Error("Failed to fetch");
    renderScans();

    await waitFor(() => expect(screen.getByText("Failed to fetch")).toBeTruthy());
    expect(screen.queryByText("No scans yet")).toBeNull();
  });
});

describe("when there are no scans", () => {
  test("points at the targets list, which is where a scan starts", async () => {
    // A scan cannot be started from this page: it needs a verified target, so
    // the only useful next step is the one the empty state offers.
    await renderScanList([]);

    await waitFor(() => expect(screen.getByText("No scans yet")).toBeTruthy());
    expect(
      screen.getByRole("link", { name: /Go to Targets/ }).getAttribute("href"),
    ).toBe("/targets");
  });
});

describe("a row", () => {
  test("shows the target, the profile, the status and the findings count", async () => {
    await renderScanList([
      aScan({
        id: "scan-1",
        profile: "THOROUGH",
        status: "RUNNING",
        findingsCount: 7,
      }),
    ]);
    const row = await waitFor(() => rowFor("Corporate site"));

    expect(within(row).getByText("THOROUGH")).toBeTruthy();
    expect(within(row).getByText("Running")).toBeTruthy();
    expect(within(row).getByText("7")).toBeTruthy();
  });

  test("links to the scan, so it is reachable without a mouse", async () => {
    // SRS §3.2.1. The row's click handler is not reachable by keyboard, so the
    // link is the only way in for anyone not using a pointer.
    await renderScanList([aScan({ id: "scan-1" })]);
    const row = await waitFor(() => rowFor("Corporate site"));

    expect(
      within(row).getByRole("link", { name: "Corporate site" }).getAttribute("href"),
    ).toBe("/scans/scan-1");
  });

  test("opens the scan when the row is clicked", async () => {
    await renderScanList([aScan({ id: "scan-1" })]);
    await waitFor(() => rowFor("Corporate site"));

    await userEvent.setup().click(screen.getByText("STANDARD"));

    await waitFor(() => expect(currentPath()).toBe("/scans/scan-1"));
  });

  test("names a scan whose target is gone rather than showing a blank", async () => {
    // Scans outlive targets: a deleted target leaves its scans behind, and a
    // row with no label reads as a rendering fault rather than a deletion.
    await renderScanList([
      aScan({ id: "scan-1", target: undefined, targetId: "target-gone" }),
    ]);

    await waitFor(() => expect(screen.getByText("Deleted target")).toBeTruthy());
    expect(screen.getByText("target-gone")).toBeTruthy();
  });

  test("dates a queued scan by when it was queued", async () => {
    // A scan that has not started has no start time, and an empty column would
    // suggest the row is broken rather than that the scan is waiting.
    const queuedAt = "2026-09-20T08:30:00.000Z";
    await renderScanList([
      aScan({ id: "scan-1", status: "QUEUED", startedAt: null, queuedAt }),
    ]);
    const row = await waitFor(() => rowFor("Corporate site"));

    expect(
      within(row).getByText(
        new Date(queuedAt).toLocaleString(undefined, {
          dateStyle: "medium",
          timeStyle: "short",
        }),
      ),
    ).toBeTruthy();
  });

  test("dates a running scan by when it started", async () => {
    // A scan can sit in the queue behind others for a long time, so the queue
    // time answers a different question from the one the column asks, and a
    // scan that looks hours old is read as a scan that has stalled.
    const queuedAt = "2026-09-20T08:00:00.000Z";
    const startedAt = "2026-09-20T11:45:00.000Z";
    await renderScanList([
      aScan({ id: "scan-1", status: "RUNNING", queuedAt, startedAt }),
    ]);
    const row = await waitFor(() => rowFor("Corporate site"));
    const shown = (value: string) =>
      new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      });

    expect(within(row).getByText(shown(startedAt))).toBeTruthy();
    expect(within(row).queryByText(shown(queuedAt))).toBeNull();
  });

  test("marks a scan that failed", async () => {
    // The findings count of a failed scan is a partial result, not a verdict,
    // so it needs saying next to the number.
    await renderScanList([
      aScan({
        id: "scan-1",
        status: "FAILED",
        findingsCount: 2,
        failureReason: "The worker was lost.",
      }),
    ]);
    const row = await waitFor(() => rowFor("Corporate site"));

    expect(within(row).getByText("failed")).toBeTruthy();
    expect(within(row).getByText("Failed")).toBeTruthy();
  });
});

describe("filtering", () => {
  test("asks the server for everything to begin with", async () => {
    await renderScanList([aScan()]);

    expect(calls[0]).toEqual({
      filters: { targetId: undefined, status: undefined },
      cursor: undefined,
    });
  });

  test("sends the chosen target to the server", async () => {
    // The list is paged, so a filter applied here would only ever search the
    // page already fetched.
    await renderScanList([aScan()]);
    await waitFor(() => rowFor("Corporate site"));

    await choose("Filter by target", "Docs site");

    await waitFor(() =>
      expect(calls.at(-1)!.filters.targetId).toBe("target-2"),
    );
  });

  test("sends the chosen status to the server", async () => {
    await renderScanList([aScan()]);
    await waitFor(() => rowFor("Corporate site"));

    await choose("Filter by status", "RUNNING");

    await waitFor(() => expect(calls.at(-1)!.filters.status).toBe("RUNNING"));
  });

  test("keeps both filters at once", async () => {
    await renderScanList([aScan()]);
    await waitFor(() => rowFor("Corporate site"));

    await choose("Filter by target", "Docs site");
    await choose("Filter by status", "COMPLETED");

    await waitFor(() =>
      expect(calls.at(-1)!.filters).toEqual({
        targetId: "target-2",
        status: "COMPLETED",
      }),
    );
  });

  test("drops the filter again rather than sending the word ALL", async () => {
    // "ALL" is the select's own sentinel. Sending it as a status would ask the
    // API for scans in a state that does not exist.
    await renderScanList([aScan()]);
    await waitFor(() => rowFor("Corporate site"));

    await choose("Filter by status", "RUNNING");
    await waitFor(() => expect(calls.at(-1)!.filters.status).toBe("RUNNING"));

    await choose("Filter by status", "All statuses");

    await waitFor(() => expect(calls.at(-1)!.filters.status).toBeUndefined());
  });

  test("can be driven from the keyboard", async () => {
    // SRS §3.2.1 again, and the filters are the part of this page a keyboard
    // user cannot work around.
    await renderScanList([aScan()]);
    await waitFor(() => rowFor("Corporate site"));
    const user = userEvent.setup();

    screen.getByLabelText("Filter by status").focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("option", { name: "QUEUED" });
    await user.keyboard("{ArrowDown}{Enter}");

    await waitFor(() => expect(calls.at(-1)!.filters.status).toBe("QUEUED"));
  });
});

describe("paging", () => {
  beforeEach(() => {
    pages = [
      { scans: [aScan({ id: "scan-1" })], nextCursor: "cursor-2" },
      {
        scans: [
          aScan({
            id: "scan-2",
            target: { id: "target-2", label: "Docs site", origin: "https://b.test" },
          }),
        ],
        nextCursor: null,
      },
    ];
  });

  test("offers more only while the server says there is more", async () => {
    pages = [{ scans: [aScan({ id: "scan-1" })], nextCursor: null }];
    renderScans();
    await waitFor(() => rowFor("Corporate site"));

    expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull();
  });

  test("asks for the next page with the cursor the server gave it", async () => {
    // An offset would skip or repeat rows as scans are queued underneath.
    renderScans();
    await waitFor(() => rowFor("Corporate site"));

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Load more/ }),
    );

    await waitFor(() => expect(calls.at(-1)!.cursor).toBe("cursor-2"));
  });

  test("adds the next page to the list instead of replacing it", async () => {
    renderScans();
    await waitFor(() => rowFor("Corporate site"));

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Load more/ }),
    );

    await waitFor(() => expect(screen.getByText("Docs site")).toBeTruthy());
    expect(screen.getByText("Corporate site")).toBeTruthy();
  });

  test("stops offering more once the last page arrives", async () => {
    renderScans();
    await waitFor(() => rowFor("Corporate site"));

    await userEvent.setup().click(
      screen.getByRole("button", { name: /Load more/ }),
    );

    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /Load more/ })).toBeNull(),
    );
  });
});
