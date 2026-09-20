import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from "bun:test";
import { useEffect } from "react";
import { act, render, renderHook } from "@testing-library/react";
import { WS_PING_INTERVAL_MS } from "@wvs/shared";

/**
 * The scan gateway transport (F.3, story 54).
 *
 * A dropped connection does not always arrive as a close. A proxy or a NAT can
 * swallow it, leaving a socket that reads as OPEN and delivers nothing, so the
 * keepalive watchdog is the only thing that notices. That makes the watchdog's
 * own lifecycle the risk: one left running against a dead socket keeps closing
 * the sockets that replaced it, and one that nulls the shared reference after a
 * reconnect turns `sendMessage` into a silent no-op. Both of those were real.
 *
 * Every test here is synchronous. The socket, the clock, the watchdog interval
 * and the reconnect backoff are all driven directly, so nothing waits on
 * wall-clock time and nothing depends on a timer racing an assertion.
 */

let session: { user: { id: string } } | null = null;

mock.module("@better-auth-ui/react", () => ({
  useSession: () => ({ data: session, isPending: false }),
}));

mock.module("@/lib/auth-client", () => ({ authClient: {} }));

// ---------------------------------------------------------------- sockets ---

type Listener = ((event: unknown) => void) | null;

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];

  readyState = FakeSocket.CONNECTING;
  sent: string[] = [];
  closeCalls = 0;

  onopen: Listener = null;
  onmessage: Listener = null;
  onerror: Listener = null;
  onclose: Listener = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  /**
   * Closing counts, but a socket only ever fires `close` once. Firing it again
   * on an already-closed socket would invent a reconnect the browser never
   * triggers, and let a test pass against a provider that mishandles it.
   */
  close() {
    this.closeCalls += 1;
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    act(() => this.onclose?.({}));
  }

  /** The server accepting the connection. */
  accept() {
    this.readyState = FakeSocket.OPEN;
    act(() => this.onopen?.({}));
  }

  /** The server dropping the connection, as opposed to us closing it. */
  dropped() {
    if (this.readyState === FakeSocket.CLOSED) return;
    this.readyState = FakeSocket.CLOSED;
    act(() => this.onclose?.({}));
  }

  /** A gateway keepalive. Without the timestamp it is not a recognised ping. */
  ping() {
    this.deliver({ type: "ping", at: new Date().toISOString() });
  }

  deliver(payload: unknown) {
    act(() =>
      this.onmessage?.({
        data: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
    );
  }
}

const latestSocket = () => FakeSocket.instances.at(-1)!;
const socketCount = () => FakeSocket.instances.length;

// --------------------------------------------------------- timers we drive ---

interface FakeInterval {
  id: number;
  callback: () => void;
  ms: number;
  cleared: boolean;
}

let intervals: FakeInterval[] = [];
let nextIntervalId = 1;

/** Watchdogs that are still armed. More than one at a time is the leak. */
const liveWatchdogs = () =>
  intervals.filter(
    (entry) => !entry.cleared && entry.ms === WS_PING_INTERVAL_MS,
  );

const realSetInterval = globalThis.setInterval;
const realClearInterval = globalThis.clearInterval;
const realSetTimeout = globalThis.setTimeout;
const realWebSocket = globalThis.WebSocket;

/**
 * Reconnect backoff starts at half a second and doubles, with jitter. Waiting
 * it out would make the give-up test take minutes, so a delay in that range
 * runs at once and a reconnect becomes a synchronous consequence of a drop.
 * Shorter delays are passed through, because React and the DOM use them.
 *
 * This is also why nothing in this file uses `waitFor`: its own timeout is a
 * one-second `setTimeout`, and firing that immediately breaks it.
 */
const RECONNECT_DELAY_FLOOR_MS = 250;

/* eslint-disable @typescript-eslint/no-explicit-any */
(globalThis as any).WebSocket = FakeSocket;

(globalThis as any).setInterval = (callback: () => void, ms: number) => {
  const entry = { id: nextIntervalId++, callback, ms, cleared: false };
  intervals.push(entry);
  return entry.id;
};

(globalThis as any).clearInterval = (id: number) => {
  const entry = intervals.find((candidate) => candidate.id === id);
  if (entry) entry.cleared = true;
};

(globalThis as any).setTimeout = (
  callback: () => void,
  ms?: number,
  ...rest: unknown[]
) => {
  if (typeof ms === "number" && ms >= RECONNECT_DELAY_FLOOR_MS) {
    callback();
    return 0;
  }
  return (realSetTimeout as any)(callback, ms, ...rest);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

afterAll(() => {
  globalThis.setInterval = realSetInterval;
  globalThis.clearInterval = realClearInterval;
  globalThis.setTimeout = realSetTimeout;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).WebSocket = realWebSocket;
});

const { WebSocketProvider, useWebSocket } = await import("./websocket-provider");

function renderProvider() {
  return renderHook(() => useWebSocket(), {
    wrapper: ({ children }) => <WebSocketProvider>{children}</WebSocketProvider>,
  });
}

/** Connected and accepted, which is where most of these start. */
function connected() {
  const view = renderProvider();
  expect(socketCount()).toBe(1);
  latestSocket().accept();
  expect(view.result.current.status).toBe("connected");
  return view;
}

beforeEach(() => {
  session = { user: { id: "user-1" } };
  FakeSocket.instances = [];
  intervals = [];
  nextIntervalId = 1;
  setSystemTime(new Date("2026-09-21T10:00:00.000Z"));
});

afterEach(() => {
  setSystemTime();
});

/** Move the clock on without touching the scheduler. */
function advance(ms: number) {
  setSystemTime(new Date(Date.now() + ms));
}

/** Run every armed watchdog, as its interval would. */
function runWatchdogs() {
  act(() => {
    for (const entry of liveWatchdogs()) entry.callback();
  });
}

// ------------------------------------------------------------- connecting ---

describe("connecting", () => {
  test("stays closed until there is a session", () => {
    // The gateway authenticates the upgrade, so connecting first would only
    // produce a rejected handshake and a reconnect loop behind it.
    session = null;
    const { result } = renderProvider();

    expect(result.current.status).toBe("disconnected");
    expect(socketCount()).toBe(0);
  });

  test("opens once a session is present", () => {
    const { result } = connected();
    expect(result.current.status).toBe("connected");
    expect(socketCount()).toBe(1);
  });

  test("closes the socket and disarms the watchdog when the view goes away", () => {
    const view = connected();
    const socket = latestSocket();

    view.unmount();

    expect(socket.closeCalls).toBe(1);
    expect(liveWatchdogs()).toHaveLength(0);
  });
});

// ------------------------------------------------------------- delivering ---

describe("delivering messages", () => {
  function subscriberHarness() {
    const received: unknown[] = [];
    function Subscriber() {
      const { subscribe } = useWebSocket();
      useEffect(
        () => subscribe((message) => received.push(message)),
        [subscribe],
      );
      return null;
    }
    render(
      <WebSocketProvider>
        <Subscriber />
      </WebSocketProvider>,
    );
    latestSocket().accept();
    return received;
  }

  test("hands a parsed event to every subscriber", () => {
    const received = subscriberHarness();

    latestSocket().deliver({ type: "scan.status", scanJobId: "s1" });

    expect(received).toEqual([{ type: "scan.status", scanJobId: "s1" }]);
  });

  test("passes a payload it cannot parse through untouched", () => {
    // Swallowing it would hide a gateway that has started sending something
    // other than JSON, which is worth seeing rather than absorbing.
    const received = subscriberHarness();

    latestSocket().deliver("not json at all");

    expect(received).toEqual(["not json at all"]);
  });

  test("keeps keepalives to itself", () => {
    // A ping is transport, not scan state. Forwarding it would make every
    // consumer filter out a message that means nothing to them.
    const received = subscriberHarness();

    latestSocket().ping();

    expect(received).toEqual([]);
  });

  test("stops delivering once unsubscribed", () => {
    const { result } = connected();
    const received: unknown[] = [];
    let unsubscribe = () => {};
    act(() => {
      unsubscribe = result.current.subscribe((message) =>
        received.push(message),
      );
    });

    latestSocket().deliver({ type: "scan.status", scanJobId: "s1" });
    act(() => unsubscribe());
    latestSocket().deliver({ type: "scan.status", scanJobId: "s2" });

    expect(received).toHaveLength(1);
  });
});

describe("sending", () => {
  test("writes to an open socket", () => {
    const { result } = connected();

    act(() => result.current.sendMessage({ hello: "world" }));

    expect(latestSocket().sent).toEqual(['{"hello":"world"}']);
  });

  test("drops a send on a socket that is not open", () => {
    // Still CONNECTING: the handshake has not finished.
    const view = renderProvider();

    act(() => view.result.current.sendMessage({ hello: "world" }));

    expect(latestSocket().sent).toEqual([]);
  });
});

// --------------------------------------------------------------- watchdog ---

describe("the keepalive watchdog", () => {
  test("closes a socket that has stopped delivering pings", () => {
    // The half-open case: readyState still reads OPEN, and nothing arrives.
    connected();
    const socket = latestSocket();

    advance(WS_PING_INTERVAL_MS * 2 + 10_000);
    runWatchdogs();

    expect(socket.closeCalls).toBe(1);
  });

  test("leaves a socket alone while pings keep arriving", () => {
    connected();
    const socket = latestSocket();

    advance(WS_PING_INTERVAL_MS);
    socket.ping();
    advance(WS_PING_INTERVAL_MS * 2);
    runWatchdogs();

    // Two intervals since the ping, which is inside the two-missed-pings
    // budget measured from the ping rather than from the connection.
    expect(socket.closeCalls).toBe(0);
  });

  test("arms exactly one watchdog per socket", () => {
    connected();
    expect(liveWatchdogs()).toHaveLength(1);
  });

  test("still holds exactly one watchdog after repeated reconnects", () => {
    // The leak. The watchdog belongs to one socket, so a reconnect that left
    // the previous interval armed would accumulate one timer per drop, each
    // firing against a socket that no longer exists.
    const view = connected();

    for (let drop = 1; drop <= 3; drop += 1) {
      latestSocket().dropped();
      expect(socketCount()).toBe(drop + 1);

      latestSocket().accept();
      expect(view.result.current.status).toBe("connected");
      expect(liveWatchdogs()).toHaveLength(1);
    }
  });

  test("a stale watchdog cannot disown the socket that replaced it", () => {
    // Belt and braces for the race the clearing above closes: if a previous
    // socket's watchdog did fire, nulling the shared reference would make
    // `sendMessage` a silent no-op against a perfectly live connection.
    const view = connected();
    const staleWatchdog = liveWatchdogs()[0]!;

    latestSocket().dropped();
    const fresh = latestSocket();
    fresh.accept();
    expect(view.result.current.status).toBe("connected");

    advance(WS_PING_INTERVAL_MS * 3);
    act(() => staleWatchdog.callback());

    act(() => view.result.current.sendMessage({ still: "here" }));
    expect(fresh.sent).toEqual(['{"still":"here"}']);
    expect(fresh.closeCalls).toBe(0);
  });
});

// -------------------------------------------------------------- reconnect ---

describe("reconnecting", () => {
  test("opens a new socket after a drop", () => {
    const view = connected();

    latestSocket().dropped();

    expect(socketCount()).toBe(2);
    latestSocket().accept();
    expect(view.result.current.status).toBe("connected");
  });

  test("gives up rather than retrying forever", () => {
    // An unbounded loop against a gateway that is down is a self-inflicted load
    // test. The view reports the failure instead, and the scan view's polling
    // fallback takes over.
    const view = connected();

    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (view.result.current.status === "error") break;
      latestSocket().dropped();
    }

    expect(view.result.current.status).toBe("error");
    // Ten attempts, so eleven sockets counting the original.
    expect(socketCount()).toBe(11);
  });

  test("forgets earlier failures once a connection succeeds", () => {
    // Otherwise a long-lived tab spends its budget on unrelated blips and
    // eventually stops reconnecting over a network that is perfectly healthy.
    const view = connected();

    // Nine drops: inside the budget, so it is still trying.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      latestSocket().dropped();
    }
    expect(view.result.current.status).not.toBe("error");

    latestSocket().accept();
    expect(view.result.current.status).toBe("connected");

    // Nine more. Without the reset this would be the eighteenth attempt and
    // the provider would have given up half a dozen drops ago.
    for (let attempt = 0; attempt < 9; attempt += 1) {
      latestSocket().dropped();
    }
    expect(view.result.current.status).not.toBe("error");

    latestSocket().accept();
    expect(view.result.current.status).toBe("connected");
  });
});

describe("using the transport outside a provider", () => {
  test("fails loudly", () => {
    // A silent null would surface much later as a subscription that never
    // delivers anything.
    expect(() => renderHook(() => useWebSocket())).toThrow(
      /within a WebSocketProvider/,
    );
  });
});
