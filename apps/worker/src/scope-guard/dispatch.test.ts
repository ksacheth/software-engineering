// @ts-ignore
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  authorize,
  dispatch,
  MAX_BODY_BYTES,
  type DispatchRequest,
  type LedgerClient,
  type Transport,
  type TransportRequest,
} from "./dispatch.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeLedger() {
  const rows: any[] = [];
  const db = {
    urlLedger: {
      create: async ({ data }: any) => {
        rows.push(data);
        return data;
      },
    },
  } as unknown as LedgerClient;
  return { db, rows };
}

function request(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  return {
    url: "http://127.0.0.1/",
    method: "GET",
    scanJobId: "test-scan",
    scope: {
      origin: "http://127.0.0.1",
      includedPaths: [],
      excludedPaths: [],
      verifiedIpSet: ["127.0.0.1"],
      rateLimit: 10,
      maxPages: 100,
      maxRequests: 100,
      maxDepth: 5,
    },
    adminBlocklist: [],
    killSwitchEngaged: false,
    pagesCrawled: 0,
    requestsMade: 0,
    depth: 0,
    userAgent: "test-agent",
    rateLimiter: { tryRemove: () => true },
    ...overrides,
  };
}

describe("dispatch safety", () => {
  test("skips fetch when kernel refuses the URL and ledgers the refusal", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("should not happen")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { db, rows } = fakeLedger();

    const result = await dispatch(db, request());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.decision.code).toBe("PRIVATE_OR_METADATA");
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      scanJobId: "test-scan",
      httpMethod: "GET",
      resolvedIp: "127.0.0.1",
      decision: "BLOCKED_BLOCKLIST",
    });
  });

  test("ledgers a rate-limit refusal without resolving DNS", async () => {
    const fetchMock = mock(() => Promise.resolve(new Response("should not happen")));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const { db, rows } = fakeLedger();

    const result = await dispatch(db, request({ rateLimiter: { tryRemove: () => false } }));

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(rows[0]).toMatchObject({ decision: "BLOCKED_RATE_LIMIT", resolvedIp: "" });
  });
});

/** A scope on a real hostname, with DNS and the network replaced. */
function namedRequest(overrides: Partial<DispatchRequest> = {}): DispatchRequest {
  const base = request();
  return {
    ...base,
    url: "https://shop.example/cart?x=1",
    scope: { ...base.scope, origin: "https://shop.example", verifiedIpSet: ["93.184.216.34/32", "2606:2800::1/128"] },
    resolver: async () => ["93.184.216.34"],
    ...overrides,
  };
}

function recordingTransport(response: () => Response = () => new Response("ok")) {
  const sent: TransportRequest[] = [];
  const transport: Transport = async (sentRequest) => {
    sent.push(sentRequest);
    return response();
  };
  return { transport, sent };
}

describe("dispatch pins the connection to the approved IP", () => {
  test("connects to the verified IP and keeps the real name for Host and TLS", async () => {
    const { db, rows } = fakeLedger();
    const { transport, sent } = recordingTransport();

    const result = await dispatch(db, namedRequest({ transport }));

    expect(result.ok).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      url: "https://93.184.216.34/cart?x=1",
      serverName: "shop.example",
      headers: { host: "shop.example", "user-agent": "test-agent" },
    });
    expect(rows[0]).toMatchObject({ decision: "ALLOWED", resolvedIp: "93.184.216.34" });
  });

  test("keeps a non-default port in the Host header and brackets an IPv6 address in the URL", async () => {
    const { db } = fakeLedger();
    const { transport, sent } = recordingTransport();
    const base = namedRequest();

    await dispatch(db, {
      ...base,
      url: "http://shop.example:8080/",
      scope: { ...base.scope, origin: "http://shop.example:8080" },
      resolver: async () => ["2606:2800::1"],
      transport,
    });

    expect(sent[0]!.url).toBe("http://[2606:2800::1]:8080/");
    expect(sent[0]!.headers.host).toBe("shop.example:8080");
    expect(sent[0]!.serverName).toBeUndefined();
  });

  test("lets a probe override the Host header without changing where it connects", async () => {
    const { db } = fakeLedger();
    const { transport, sent } = recordingTransport();

    await dispatch(db, namedRequest({ transport, headers: { host: "evil.example" } }));

    expect(sent[0]!.headers.host).toBe("evil.example");
    expect(sent[0]!.url).toContain("93.184.216.34");
  });

  test("a probe's capitalised Host replaces the real one instead of being joined to it", async () => {
    const { db } = fakeLedger();
    const { transport, sent } = recordingTransport();

    await dispatch(db, namedRequest({ transport, headers: { Host: "wvsprobe1.invalid", "User-Agent": "probe" } }));

    expect(sent[0]!.headers).toEqual({ host: "wvsprobe1.invalid", "user-agent": "probe" });
  });

  test("never contacts an IP outside the verified set, whatever the name resolves to", async () => {
    const { db, rows } = fakeLedger();
    const { transport, sent } = recordingTransport();

    const result = await dispatch(db, namedRequest({ transport, resolver: async () => ["93.184.216.99"] }));

    expect(result.ok).toBe(false);
    expect(sent).toHaveLength(0);
    expect(rows[0]).toMatchObject({ decision: "BLOCKED_DNS_REBINDING" });
  });
});

describe("dispatch response bodies", () => {
  test("stops reading at the cap and reports truncation", async () => {
    const { db, rows } = fakeLedger();
    const chunk = new Uint8Array(1024 * 1024).fill(97);
    let pulled = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { transport } = recordingTransport(() => new Response(body));

    const result = await dispatch(db, namedRequest({ transport }));

    expect(result.ok && result.truncated).toBe(true);
    expect(result.ok && result.body.length).toBe(MAX_BODY_BYTES);
    expect(rows[0]!.bytesReceived).toBe(MAX_BODY_BYTES);
    expect(pulled).toBeLessThan(10);
  });

  test("returns a small body whole and an empty body for HEAD", async () => {
    const { db } = fakeLedger();
    const { transport } = recordingTransport(() => new Response("hello"));

    const get = await dispatch(db, namedRequest({ transport }));
    const head = await dispatch(db, namedRequest({ transport, method: "HEAD" }));

    expect(get.ok && [get.body, get.truncated]).toEqual(["hello", false]);
    expect(head.ok && head.body).toBe("");
  });
});

describe("authorize", () => {
  test("refuses and ledgers a malformed URL instead of throwing", async () => {
    const { db, rows } = fakeLedger();

    const decision = await authorize(db, request({ url: "not a url" }));

    expect(decision.allowed).toBe(false);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ url: "not a url", decision: "BLOCKED_SCOPE", resolvedIp: "" });
  });

  test("admits the plaintext twin only when asked", async () => {
    const { db } = fakeLedger();
    const twin = { url: "http://shop.example/" };

    const without = await authorize(db, namedRequest(twin));
    const withTwin = await authorize(db, namedRequest({ ...twin, allowPlaintextTwin: true }));

    expect(without.allowed).toBe(false);
    expect(withTwin.allowed).toBe(true);
  });

  test("the plaintext twin allowance covers only the root on the default port", async () => {
    const { db } = fakeLedger();

    for (const url of ["http://shop.example/admin", "http://shop.example:8080/", "http://other.example/"]) {
      const decision = await authorize(db, namedRequest({ url, allowPlaintextTwin: true }));
      expect(decision.allowed).toBe(false);
    }
  });
});
