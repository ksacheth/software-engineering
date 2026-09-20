import { beforeEach, describe, expect, test } from "bun:test";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type { Scan, ScanFindingSummary } from "@/services/scans";
import { aScan } from "@/test-support/fixtures";
import { resetMocks, ScanApiError, stub, toasts } from "@/test-support/mocks";

/**
 * The live scan page (F.3).
 *
 * Driven through the real `useLiveScan`, with only the API and the socket
 * replaced. Mocking the hook would have been simpler, but the hook lives in
 * this directory and `mock.module` is global, so stubbing it here replaced the
 * real one in its own test file and quietly passed nonsense there.
 *
 * What is asserted is everything the page makes a decision on. The controls are
 * the sharp part: offering Resume on a cancelled scan or Pause on a queued one
 * produces a command the API refuses, and a user who meets enough of those
 * stops believing the buttons that do work.
 */

let row: Scan;
let findings: ScanFindingSummary[] = [];
let fetchRejectsWith: Error | null = null;
let fetchHangs = false;
let scanFetches = 0;

let socketStatus = "connected";
let canWrite = true;

const commands: string[] = [];
let commandFails: Error | null = null;

/**
 * A scan whose row was written just now.
 *
 * The stalled alert is computed against the wall clock, so a fixture with a
 * fixed timestamp would start reporting every running scan as stalled a few
 * minutes after the date in the fixture.
 */
function freshScan(overrides: Partial<Scan> = {}): Scan {
  return aScan({ updatedAt: new Date().toISOString(), ...overrides });
}

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={["/scans/scan-1"]}>
        <Routes>
          <Route path="/scans/:id" element={<ScanDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Render and wait for the row to arrive. */
async function showScan(scan: Scan = freshScan()) {
  row = scan;
  const view = renderPage();
  await screen.findByText(scan.target?.label ?? "Scan");
  return view;
}

const buttonNames = () =>
  screen.queryAllByRole("button").map((button) => button.textContent?.trim());

beforeEach(() => {
  resetMocks();
  row = freshScan();
  findings = [];
  fetchRejectsWith = null;
  fetchHangs = false;
  scanFetches = 0;
  socketStatus = "connected";
  canWrite = true;
  commands.length = 0;
  commandFails = null;

  stub.socket("useWebSocket", (() => ({
    status: socketStatus,
    sendMessage: () => {},
    subscribe: () => () => {},
  })) as never);
  stub.role("useCanWrite", (() => canWrite) as never);

  stub.scans("fetchScan", (async () => {
    scanFetches += 1;
    if (fetchHangs) return new Promise(() => {});
    if (fetchRejectsWith) throw fetchRejectsWith;
    return { scan: row };
  }) as never);
  stub.scans("fetchScanFindings", (async () => ({ findings })) as never);

  for (const name of ["pauseScan", "resumeScan", "cancelScan"] as const) {
    stub.scans(name, (async (id: string) => {
      commands.push(`${name.replace("Scan", "")}:${id}`);
      if (commandFails) throw commandFails;
      return { scan: row };
    }) as never);
  }
});

const { ScanDetailPage } = await import("./scan-detail-page");

// ------------------------------------------------------------------- shell ---

describe("before the scan has loaded", () => {
  test("offers no controls, because the status is not known yet", () => {
    // A command against a scan nobody has read is a command against an
    // unknown status.
    fetchHangs = true;
    renderPage();

    expect(buttonNames()).not.toContain("Cancel");
  });
});

describe("when the scan cannot be loaded", () => {
  test("says so, shows why, and offers the way back", async () => {
    fetchRejectsWith = new ScanApiError(404, "Request failed with status 404");
    renderPage();

    expect(await screen.findByText("Scan not found")).toBeTruthy();
    expect(screen.getByText("Request failed with status 404")).toBeTruthy();
    // A link rather than a button, because it navigates.
    expect(screen.getByRole("link", { name: /Back to Scans/ })).toBeTruthy();
  });
});

describe("the header", () => {
  test("names the target, its origin and the scan", async () => {
    await showScan();

    expect(screen.getByText("Corporate site")).toBeTruthy();
    expect(screen.getByRole("link", { name: "https://a.test" })).toBeTruthy();
    expect(screen.getByText(/scan-1/)).toBeTruthy();
  });

  test("opens the target in a new tab without leaking the referrer", async () => {
    // The target is a third party the user happens to be scanning; the
    // dashboard URL is not theirs to receive.
    await showScan();

    const link = screen.getByRole("link", { name: "https://a.test" });
    expect(link.getAttribute("rel")).toContain("noreferrer");
    expect(link.getAttribute("target")).toBe("_blank");
  });

  test("renders without a target, because a deleted one leaves its scans", async () => {
    // Scans and the audit trail outlive the target (ADR-0002).
    await showScan(freshScan({ target: null }));

    expect(screen.getByText("Scan")).toBeTruthy();
  });
});

// ---------------------------------------------------------------- controls ---

describe("the lifecycle controls", () => {
  const offered: [Scan["status"], string[]][] = [
    ["RUNNING", ["Pause", "Cancel"]],
    ["PAUSED", ["Resume", "Cancel"]],
    ["QUEUED", ["Cancel"]],
    ["COMPLETED", []],
    ["FAILED", []],
    ["CANCELLED", []],
    ["ABORTED_SAFETY", []],
  ];

  for (const [status, expected] of offered) {
    const summary = expected.length > 0 ? expected.join(" and ") : "nothing";
    test(`offers ${summary} for a ${status} scan`, async () => {
      // Only the transitions F.3's lifecycle allows. Anything else is a
      // command the API will refuse.
      await showScan(freshScan({ status }));

      const names = buttonNames();
      for (const label of ["Pause", "Resume", "Cancel"]) {
        expect(`${status}/${label}: ${names.includes(label)}`).toBe(
          `${status}/${label}: ${expected.includes(label)}`,
        );
      }
    });
  }

  test("are hidden from a role that cannot write", async () => {
    // Hiding is a courtesy; the API enforces it. But showing a VIEWER controls
    // that always fail is worse than showing none.
    canWrite = false;
    await showScan(freshScan({ status: "RUNNING" }));

    expect(buttonNames()).not.toContain("Pause");
    expect(buttonNames()).not.toContain("Cancel");
  });

  test("send the command for the scan on screen", async () => {
    await showScan(freshScan({ status: "RUNNING" }));

    await userEvent.setup().click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(commands).toEqual(["pause:scan-1"]));
    await waitFor(() =>
      expect(toasts).toContainEqual({ kind: "success", message: "Scan paused" }),
    );
  });

  test("resume goes to the resume endpoint, not a status write", async () => {
    // Resume re-enqueues the job and increments the attempt. Routing it as a
    // status update would leave the scan paused with nothing to run it.
    await showScan(freshScan({ status: "PAUSED" }));

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() => expect(commands).toEqual(["resume:scan-1"]));
  });

  test("report a refusal instead of appearing to work", async () => {
    // The API re-checks C.2 on resume, so a refusal here means the target has
    // become unscannable. Silence would leave the user waiting on a scan that
    // is never going to start.
    commandFails = new ScanApiError(422, "The target may no longer be scanned.");
    await showScan(freshScan({ status: "PAUSED" }));

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Resume" }));

    await waitFor(() =>
      expect(toasts).toContainEqual({
        kind: "error",
        message: "The target may no longer be scanned.",
      }),
    );
  });

  test("say something even when the failure carries no message", async () => {
    commandFails = new Error("");
    await showScan(freshScan({ status: "RUNNING" }));

    await userEvent.setup().click(screen.getByRole("button", { name: "Pause" }));

    await waitFor(() => expect(toasts).toHaveLength(1));
    expect(toasts[0]!.kind).toBe("error");
  });
});

// ------------------------------------------------------------------ alerts ---

describe("the connection badge", () => {
  test("says the view is live when the socket is up", async () => {
    await showScan();
    expect(screen.getByText("Live")).toBeTruthy();
  });

  test("distinguishes reconnecting from reconnecting and polling", async () => {
    // Both mean the socket is down, but one is still updating and the other is
    // not, and that decides whether the numbers can be trusted.
    socketStatus = "disconnected";
    const running = await showScan(freshScan({ status: "RUNNING" }));
    expect(screen.getByText("Reconnecting, polling")).toBeTruthy();
    running.unmount();

    // A finished scan has nothing left to poll for.
    await showScan(freshScan({ status: "COMPLETED" }));
    expect(screen.getByText("Reconnecting")).toBeTruthy();
  });
});

describe("the alerts", () => {
  test("show a failure reason when the scan failed", async () => {
    await showScan(
      freshScan({
        status: "FAILED",
        failureReason: "The target refused the connection.",
      }),
    );

    expect(screen.getByText("Scan failed")).toBeTruthy();
    expect(screen.getByText("The target refused the connection.")).toBeTruthy();
  });

  test("report a worker that has gone quiet", async () => {
    // Silence reads as slowness, and an operator waiting on a slow scan
    // behaves differently from one waiting on a dead worker.
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    await showScan(aScan({ status: "RUNNING", updatedAt: longAgo }));

    expect(screen.getByText("No update from the scan engine")).toBeTruthy();
    expect(screen.getByText(/running with no progress/)).toBeTruthy();
  });

  test("offer a way to re-read the row when it looks stalled", async () => {
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    await showScan(aScan({ status: "RUNNING", updatedAt: longAgo }));
    const before = scanFetches;

    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Refresh" }));

    await waitFor(() => expect(scanFetches).toBeGreaterThan(before));
  });

  test("never call a finished scan stalled, however old the row is", async () => {
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    await showScan(aScan({ status: "COMPLETED", updatedAt: longAgo }));

    expect(screen.queryByText("No update from the scan engine")).toBeNull();
  });

  test("list every warning, because coverage was reduced for each reason", async () => {
    // These are the degradations that make a clean result less meaningful than
    // it looks, so showing only the first would be actively misleading.
    await showScan(
      freshScan({
        warnings: [
          {
            code: "RENDERING_UNAVAILABLE",
            message: "JavaScript rendering was unavailable.",
          },
          {
            code: "CRAWL_LIMIT_REACHED",
            message: "The configured page ceiling bound this scan.",
          },
        ],
      }),
    );

    expect(screen.getByText("Reduced coverage")).toBeTruthy();
    expect(
      screen.getByText("JavaScript rendering was unavailable."),
    ).toBeTruthy();
    expect(
      screen.getByText("The configured page ceiling bound this scan."),
    ).toBeTruthy();
  });

  test("stay out of the way when there is nothing wrong", async () => {
    await showScan();

    expect(screen.queryByText("Scan failed")).toBeNull();
    expect(screen.queryByText("Reduced coverage")).toBeNull();
    expect(screen.queryByText("No update from the scan engine")).toBeNull();
  });
});

// ---------------------------------------------------------------- progress ---

describe("progress", () => {
  test("reports the percentage to assistive technology as well as on screen", async () => {
    await showScan(freshScan({ progressPercentage: 42 }));

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "42",
    );
    expect(screen.getByText("42% complete")).toBeTruthy();
  });

  test("clamps a percentage outside the range", async () => {
    // The counter comes from the worker. A value past a hundred would render a
    // bar wider than its own track.
    await showScan(freshScan({ progressPercentage: 140 }));

    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe(
      "100",
    );
  });

  test("shows the counters the worker reports", async () => {
    await showScan(
      freshScan({
        phase: "DETECTION",
        pagesCrawled: 51,
        requestsMade: 340,
        findingsCount: 7,
      }),
    );

    expect(screen.getByText("DETECTION")).toBeTruthy();
    expect(screen.getByText("51")).toBeTruthy();
    expect(screen.getByText("340")).toBeTruthy();
  });

  test("explains that a paused scan is still holding its slot", async () => {
    // F.3: PAUSED occupies quota, so a user wondering why they cannot start
    // another scan has the answer here rather than at the next refusal.
    await showScan(freshScan({ status: "PAUSED" }));

    expect(screen.getByText(/holding its concurrency slot/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------- findings ---

describe("findings", () => {
  const finding = (
    overrides: Partial<ScanFindingSummary> = {},
  ): ScanFindingSummary => ({
    id: "f-1",
    fingerprint: "fp-1",
    detectorId: "P-01",
    name: "Missing security header",
    severity: "HIGH",
    affectedUrl: "https://a.test/login",
    createdAt: "2026-09-21T10:00:00.000Z",
    ...overrides,
  });

  test("say so plainly when there are none yet", async () => {
    await showScan();
    expect(screen.getByText(/No findings yet/)).toBeTruthy();
  });

  test("list each one with its severity and where it was found", async () => {
    findings = [finding()];
    await showScan();

    const row = await screen.findByText("Missing security header");
    const cells = row.closest("tr")!;
    expect(within(cells).getByText("HIGH")).toBeTruthy();
    expect(within(cells).getByText("P-01")).toBeTruthy();
    expect(within(cells).getByText("https://a.test/login")).toBeTruthy();
  });

  test("render a severity the dashboard does not know about", async () => {
    // The severity list is shared, but a worker running ahead of a deployed
    // dashboard can send one it has never seen. Dropping the row would hide a
    // finding; showing the real label styled as INFO does not.
    findings = [finding({ severity: "CATASTROPHIC" })];
    await showScan();

    expect(await screen.findByText("CATASTROPHIC")).toBeTruthy();
  });
});

describe("the provenance card", () => {
  test("records how the scan was produced", async () => {
    // F.3 wants a finished scan to be accountable afterwards: the profile and
    // limits it actually ran with, not the ones the target carries now.
    await showScan(
      freshScan({
        profile: "THOROUGH",
        includedPaths: ["/app"],
        excludedPaths: ["/logout", "/admin"],
      }),
    );

    expect(screen.getByText("THOROUGH")).toBeTruthy();
    expect(screen.getByText("Sam")).toBeTruthy();
    expect(screen.getByText("1 included · 2 excluded")).toBeTruthy();
  });

  test("admits when the detector versions are not recorded yet", async () => {
    // The orchestrator writes them; until it exists the honest answer is that
    // nothing recorded them, not a blank that reads as none.
    await showScan();
    expect(screen.getByText("not yet recorded")).toBeTruthy();
  });
});
