// @ts-ignore
import { afterEach, describe, expect, mock, test } from "bun:test";
import { dispatch, type DispatchRequest, type LedgerClient } from "./dispatch.js";

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
