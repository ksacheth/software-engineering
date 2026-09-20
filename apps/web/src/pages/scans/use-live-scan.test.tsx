import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { ReactNode } from "react";
import { act, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Scan, ScanFindingSummary } from "@/services/scans";
import { aScan } from "@/test-support/fixtures";
import { resetMocks, stub } from "@/test-support/mocks";

/**
 * The live scan view's merge rules (F.3).
 *
 * Two sources feed one view: a REST snapshot and a socket stream, and they
 * arrive in no fixed order. Every bug this file guards has the same shape, a
 * view that shows something that was true a moment ago, and the same cost: an
 * operator reading a stale status decides whether to cancel a scan on it.
 *
 * Two of these were found in review rather than by a test, which is why they
 * are asserted first: an event that dropped the counters carried by the
 * previous event, and a scan id change that left the previous scan's findings
 * and status on screen.
 *
 * The transport and the fetches are replaced because they are not what is under
 * test; the merge, the ordering and the reset all run for real.
 */

// -------------------------------------------------------------- transport ---

type Handler = (message: unknown) => void;
const subscribers = new Set<Handler>();

/** Deliver a message to the view exactly as the gateway would. */
function emit(message: unknown): void {
  act(() => {
    for (const handler of [...subscribers]) handler(message);
  });
}

// ----------------------------------------------------------------- fetches ---

const rows = new Map<string, Scan>();
const durableFindings = new Map<string, ScanFindingSummary[]>();
let scanFetches = 0;

const { useLiveScan } = await import("./use-live-scan");

// ---------------------------------------------------------------- fixtures ---

const T0 = "2026-09-21T10:00:00.000Z";
const T1 = "2026-09-21T10:00:10.000Z";
const T2 = "2026-09-21T10:00:20.000Z";

/** A scan row as the REST snapshot delivers it. */
const scanRow = (id: string, overrides: Partial<Scan> = {}): Scan =>
  aScan({ id, ...overrides });

function findingEvent(
  scanJobId: string,
  fingerprint: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    type: "scan.finding",
    scanJobId,
    at: T1,
    fingerprint,
    detectorId: "P-01",
    name: "Missing security header",
    severity: "LOW",
    affectedUrl: "https://a.test/",
    ...overrides,
  };
}

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderLiveScan(
  scanJobId: string | undefined,
  socketStatus: "connected" | "disconnected" = "connected",
) {
  return renderHook(
    ({ id, status }: { id: string | undefined; status: string }) =>
      useLiveScan(id, status as never),
    { wrapper, initialProps: { id: scanJobId, status: socketStatus } },
  );
}

beforeEach(() => {
  resetMocks();
  stub.socket("useWebSocket", (() => ({
    status: "connected",
    sendMessage: () => {},
    subscribe: (handler: Handler) => {
      subscribers.add(handler);
      return () => subscribers.delete(handler);
    },
  })) as never);
  stub.scans("fetchScan", (async (id: string) => {
    scanFetches += 1;
    const scan = rows.get(id);
    if (!scan) throw new Error(`no scan fixture for ${id}`);
    return { scan };
  }) as never);
  stub.scans("fetchScanFindings", (async (id: string) => ({
    findings: durableFindings.get(id) ?? [],
  })) as never);

  subscribers.clear();
  rows.clear();
  durableFindings.clear();
  scanFetches = 0;
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
});

afterEach(() => {
  queryClient.clear();
});

// ------------------------------------------------------------------ merging ---

describe("merging events into the snapshot", () => {
  test("keeps the fields an earlier event carried", async () => {
    // The regression this file exists for. `scan.progress` carries counters and
    // `scan.status` carries a status; neither carries the other. A patch that
    // replaced rather than merged dropped the counters on the next status
    // event, and because the patch still out-dated the snapshot the view fell
    // back to the snapshot's zeroes and visibly counted backwards.
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.progress",
      scanJobId: "scan-1",
      at: T1,
      phase: "DISCOVERY",
      pagesCrawled: 42,
      requestsMade: 108,
      findingsCount: 3,
      progressPercentage: 25,
    });

    emit({
      type: "scan.status",
      scanJobId: "scan-1",
      at: T2,
      status: "RUNNING",
      phase: "DETECTION",
    });

    expect(result.current.scan).toMatchObject({
      status: "RUNNING",
      phase: "DETECTION",
      pagesCrawled: 42,
      requestsMade: 108,
      progressPercentage: 25,
    });
  });

  test("lets a newer event win the fields it carries", async () => {
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.progress",
      scanJobId: "scan-1",
      at: T1,
      phase: "DISCOVERY",
      pagesCrawled: 10,
      requestsMade: 20,
      findingsCount: 0,
      progressPercentage: 5,
    });
    emit({
      type: "scan.progress",
      scanJobId: "scan-1",
      at: T2,
      phase: "DISCOVERY",
      pagesCrawled: 99,
      requestsMade: 200,
      findingsCount: 1,
      progressPercentage: 60,
    });

    expect(result.current.scan?.pagesCrawled).toBe(99);
    expect(result.current.scan?.progressPercentage).toBe(60);
  });

  test("lets a late event fill gaps without undoing what is applied", async () => {
    // Events can overtake each other. One that arrives late is by definition
    // older than what is on screen, so it may contribute a field nothing has
    // set yet, and may not overwrite one.
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.status",
      scanJobId: "scan-1",
      at: T2,
      status: "RUNNING",
      phase: "DETECTION",
    });
    // Older, and arriving second.
    emit({
      type: "scan.progress",
      scanJobId: "scan-1",
      at: T1,
      phase: "DISCOVERY",
      pagesCrawled: 7,
      requestsMade: 9,
      findingsCount: 0,
      progressPercentage: 3,
    });

    // The counters were nobody else's to set, so they land.
    expect(result.current.scan?.pagesCrawled).toBe(7);
    // The phase was already set by the newer event, so it does not move back.
    expect(result.current.scan?.phase).toBe("DETECTION");
  });

  test("ignores events for a different scan", async () => {
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.progress",
      scanJobId: "scan-2",
      at: T2,
      phase: "DETECTION",
      pagesCrawled: 500,
      requestsMade: 500,
      findingsCount: 9,
      progressPercentage: 90,
    });

    expect(result.current.scan?.pagesCrawled).toBe(0);
  });

  test("ignores a message that is not a scan event", async () => {
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({ type: "something.else", scanJobId: "scan-1" });
    emit("not an object");
    emit(null);

    expect(result.current.scan?.status).toBe("RUNNING");
  });
});

describe("choosing between the snapshot and the stream", () => {
  test("discards a snapshot older than what the stream has shown", async () => {
    // The REST response can be served from a replica or simply be slow. If an
    // older snapshot could overwrite a newer event the view would jump
    // backwards, which reads as the scan having lost progress.
    rows.set("scan-1", scanRow("scan-1", { updatedAt: T0, pagesCrawled: 1 }));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.progress",
      scanJobId: "scan-1",
      at: T2,
      phase: "DETECTION",
      pagesCrawled: 80,
      requestsMade: 90,
      findingsCount: 2,
      progressPercentage: 70,
    });

    expect(result.current.scan?.pagesCrawled).toBe(80);
  });

  test("prefers a snapshot newer than the last event", async () => {
    // The mirror image: once the row is genuinely ahead, the patch is history
    // and holding on to it would pin the view to an old status.
    rows.set(
      "scan-1",
      scanRow("scan-1", { updatedAt: T2, status: "COMPLETED", pagesCrawled: 51 }),
    );
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.progress",
      scanJobId: "scan-1",
      at: T1,
      phase: "DISCOVERY",
      pagesCrawled: 3,
      requestsMade: 4,
      findingsCount: 0,
      progressPercentage: 2,
    });

    expect(result.current.scan?.status).toBe("COMPLETED");
    expect(result.current.scan?.pagesCrawled).toBe(51);
  });
});

// ----------------------------------------------------------- id transition ---

describe("when the scan id changes", () => {
  test("shows nothing of the previous scan", async () => {
    // `/scans/:id` is one route, so React Router reuses the component when only
    // the parameter changes. Without a reset the previous scan's findings union
    // into the new list and its patch wins the freshness comparison, so a
    // finished scan's status renders on a queued one.
    rows.set("scan-1", scanRow("scan-1", { status: "RUNNING" }));
    rows.set(
      "scan-2",
      scanRow("scan-2", { status: "QUEUED", pagesCrawled: 0, updatedAt: T2 }),
    );

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLiveScan(id, "connected" as never),
      { wrapper, initialProps: { id: "scan-1" } },
    );
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.status",
      scanJobId: "scan-1",
      at: T2,
      status: "COMPLETED",
      phase: "COMPLETED",
    });
    emit(findingEvent("scan-1", "fp-from-scan-1"));
    expect(result.current.findings).toHaveLength(1);

    rerender({ id: "scan-2" });
    await waitFor(() => expect(result.current.scan?.id).toBe("scan-2"));

    expect(result.current.scan?.status).toBe("QUEUED");
    expect(result.current.findings).toEqual([]);
  });

  test("does not carry the previous scan's warnings across", async () => {
    rows.set("scan-1", scanRow("scan-1"));
    rows.set("scan-2", scanRow("scan-2", { updatedAt: T2 }));

    const { result, rerender } = renderHook(
      ({ id }: { id: string }) => useLiveScan(id, "connected" as never),
      { wrapper, initialProps: { id: "scan-1" } },
    );
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.warning",
      scanJobId: "scan-1",
      at: T1,
      code: "RENDERING_UNAVAILABLE",
      message: "JavaScript rendering was unavailable.",
    });
    expect(result.current.warnings).toHaveLength(1);

    rerender({ id: "scan-2" });
    await waitFor(() => expect(result.current.scan?.id).toBe("scan-2"));

    expect(result.current.warnings).toEqual([]);
  });
});

// -------------------------------------------------------------- findings ---

describe("accumulating findings", () => {
  test("adds each streamed finding", async () => {
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit(findingEvent("scan-1", "fp-1", { name: "First" }));
    emit(findingEvent("scan-1", "fp-2", { name: "Second" }));

    expect(result.current.findings.map((f) => f.name)).toEqual([
      "First",
      "Second",
    ]);
  });

  test("keeps the first copy of a repeated fingerprint", async () => {
    // Findings are additive and keyed by fingerprint. A field-wise merge would
    // let a redelivery overwrite the original, and a redelivery is exactly what
    // a reconnect produces.
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit(findingEvent("scan-1", "fp-1", { name: "Original" }));
    emit(findingEvent("scan-1", "fp-1", { name: "Redelivered" }));

    expect(result.current.findings).toHaveLength(1);
    expect(result.current.findings[0]?.name).toBe("Original");
  });

  test("keeps a streamed finding when the durable list arrives after it", async () => {
    // The durable projection seeds the list so a reload does not lose what was
    // seen live. It must not clobber a finding that arrived first.
    rows.set("scan-1", scanRow("scan-1"));
    durableFindings.set("scan-1", [
      {
        id: "f-2",
        fingerprint: "fp-2",
        detectorId: "P-02",
        name: "From the projection",
        severity: "MEDIUM",
        affectedUrl: "https://a.test/x",
        createdAt: T0,
      },
    ]);

    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.findings.length).toBeGreaterThan(0));

    emit(findingEvent("scan-1", "fp-1", { name: "Streamed" }));

    const names = result.current.findings.map((f) => f.name).sort();
    expect(names).toEqual(["From the projection", "Streamed"]);
  });

  test("ignores a finding belonging to another scan", async () => {
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit(findingEvent("scan-2", "fp-other"));

    expect(result.current.findings).toEqual([]);
  });
});

describe("accumulating warnings", () => {
  test("keeps each distinct warning", async () => {
    rows.set("scan-1", scanRow("scan-1"));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.warning",
      scanJobId: "scan-1",
      at: T1,
      code: "RENDERING_UNAVAILABLE",
      message: "JavaScript rendering was unavailable.",
    });
    emit({
      type: "scan.warning",
      scanJobId: "scan-1",
      at: T2,
      code: "CRAWL_LIMIT_REACHED",
      message: "The configured page ceiling bound this scan.",
    });

    expect(result.current.warnings.map((w) => w.code).sort()).toEqual([
      "CRAWL_LIMIT_REACHED",
      "RENDERING_UNAVAILABLE",
    ]);
  });

  test("merges the streamed warnings with the ones on the row", async () => {
    rows.set(
      "scan-1",
      scanRow("scan-1", {
        warnings: [
          {
            code: "TARGET_BLOCKING_DETECTED",
            message: "The target appears to be blocking the scanner.",
          },
        ],
      }),
    );
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    emit({
      type: "scan.warning",
      scanJobId: "scan-1",
      at: T1,
      code: "RENDERING_UNAVAILABLE",
      message: "JavaScript rendering was unavailable.",
    });

    expect(result.current.warnings).toHaveLength(2);
  });
});

// --------------------------------------------------------------- reporting ---

describe("what the view reports about itself", () => {
  test("polls only while the socket is down and the scan is unfinished", async () => {
    rows.set("scan-1", scanRow("scan-1", { status: "RUNNING" }));

    const live = renderLiveScan("scan-1", "disconnected");
    await waitFor(() => expect(live.result.current.scan).toBeDefined());
    expect(live.result.current.isPolling).toBe(true);

    live.unmount();

    const connected = renderLiveScan("scan-1", "connected");
    await waitFor(() => expect(connected.result.current.scan).toBeDefined());
    expect(connected.result.current.isPolling).toBe(false);
  });

  test("stops polling a finished scan even with the socket down", async () => {
    // A terminal scan has nothing left to report, so polling it is a request
    // per interval per open tab that can never change anything.
    rows.set("scan-1", scanRow("scan-1", { status: "COMPLETED" }));
    const { result } = renderLiveScan("scan-1", "disconnected");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    expect(result.current.isPolling).toBe(false);
  });

  test("reports a worker that has gone quiet", async () => {
    // Silence reads as slowness, and an operator waiting on a slow scan behaves
    // differently from one waiting on a dead worker.
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    rows.set(
      "scan-1",
      scanRow("scan-1", { status: "RUNNING", updatedAt: longAgo }),
    );
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    expect(result.current.isStalled).toBe(true);
  });

  test("counts any live event as a sign of life", async () => {
    // The row can be old while the scan is streaming: progress events do not
    // write the row on every tick. Reporting that as stalled would cry wolf.
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    rows.set(
      "scan-1",
      scanRow("scan-1", { status: "RUNNING", updatedAt: longAgo }),
    );
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.isStalled).toBe(true));

    emit({
      type: "scan.progress",
      scanJobId: "scan-1",
      at: new Date().toISOString(),
      phase: "DETECTION",
      pagesCrawled: 5,
      requestsMade: 6,
      findingsCount: 0,
      progressPercentage: 10,
    });

    expect(result.current.isStalled).toBe(false);
  });

  test("never reports a finished scan as stalled", async () => {
    const longAgo = new Date(Date.now() - 30 * 60_000).toISOString();
    rows.set(
      "scan-1",
      scanRow("scan-1", { status: "COMPLETED", updatedAt: longAgo }),
    );
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());

    expect(result.current.isStalled).toBe(false);
  });

  test("fetches nothing without a scan id", () => {
    const { result } = renderLiveScan(undefined);

    expect(result.current.scan).toBeUndefined();
    expect(scanFetches).toBe(0);
  });
});

describe("when a scan reaches a terminal state", () => {
  test("re-reads the row, because the row is the durable copy", async () => {
    // The event says the scan finished; the row carries the completion time,
    // the failure reason and the final counters. Leaving the view on the patch
    // would show a completed scan with no completion detail.
    rows.set("scan-1", scanRow("scan-1", { status: "RUNNING" }));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());
    const before = scanFetches;

    rows.set(
      "scan-1",
      scanRow("scan-1", {
        status: "COMPLETED",
        completedAt: T2,
        updatedAt: T2,
      }),
    );
    emit({
      type: "scan.status",
      scanJobId: "scan-1",
      at: T2,
      status: "COMPLETED",
      phase: "COMPLETED",
    });

    await waitFor(() => expect(scanFetches).toBeGreaterThan(before));
    await waitFor(() =>
      expect(result.current.scan?.completedAt).toBe(T2),
    );
  });

  test("does not re-read on a status that is not terminal", async () => {
    rows.set("scan-1", scanRow("scan-1", { status: "RUNNING" }));
    const { result } = renderLiveScan("scan-1");
    await waitFor(() => expect(result.current.scan).toBeDefined());
    const before = scanFetches;

    emit({
      type: "scan.status",
      scanJobId: "scan-1",
      at: T2,
      status: "PAUSED",
    });

    expect(result.current.scan?.status).toBe("PAUSED");
    expect(scanFetches).toBe(before);
  });
});
