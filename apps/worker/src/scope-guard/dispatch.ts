import { isIP } from "node:net";

import type { PrismaClient, ScopeDecision } from "@wvs/database";
import {
  evaluate,
  resolveHostIps,
  type BlocklistEntry,
  type GuardDecision,
  type GuardDenyCode,
  type ScopeSnapshot,
} from "@wvs/scope-guard";

export interface DispatchRequest {
  url: string;
  method: "GET" | "HEAD" | "OPTIONS";
  headers?: Record<string, string>;

  scanJobId: string;

  scope: ScopeSnapshot;
  adminBlocklist: readonly BlocklistEntry[];
  killSwitchEngaged: boolean;

  pagesCrawled: number;
  requestsMade: number;
  depth: number;

  userAgent: string;

  rateLimiter: {
    tryRemove(): boolean;
  };

  /** Admits `http://<scope host>/` for an https scope; only A-14 sets this. */
  allowPlaintextTwin?: boolean;
  /** Replace DNS and the network, for tests. */
  resolver?: (hostname: string) => Promise<string[]>;
  transport?: Transport;
}

/** The live request count shared by the crawl, the TLS probe and the active probes, so one scan has one ceiling. */
export interface RequestBudget {
  requestsMade: number;
}

/** The request as sent: `url` already points at the approved IP. */
export interface TransportRequest {
  url: string;
  method: DispatchRequest["method"];
  headers: Record<string, string>;
  /** The TLS name to verify the certificate against; unset for plaintext or an IP-literal host. */
  serverName?: string;
  signal: AbortSignal;
}

export type Transport = (request: TransportRequest) => Promise<Response>;

/** Response bodies are cut off here; a hostile target cannot exhaust worker memory. */
export const MAX_BODY_BYTES = 5 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;

export type DeniedDecision = Extract<GuardDecision, { allowed: false }>;

export type DispatchResult =
  | {
      ok: true;
      status: number;
      headers: Headers;
      body: string;
      /** True when the body was cut off at MAX_BODY_BYTES. */
      truncated: boolean;
      ips: string[];
    }
  | {
      ok: false;
      decision: DeniedDecision;
    };

export type LedgerClient = Pick<PrismaClient, "urlLedger">;

const LEDGER_DECISION: Record<GuardDenyCode, ScopeDecision> = {
  UNVERIFIED: "BLOCKED_VERIFICATION",
  EMPTY_VERIFIED_IPS: "BLOCKED_VERIFICATION",
  OUT_OF_SCOPE: "BLOCKED_SCOPE",
  UNSAFE_METHOD: "BLOCKED_SCOPE",
  BLOCKLIST: "BLOCKED_BLOCKLIST",
  PRIVATE_OR_METADATA: "BLOCKED_BLOCKLIST",
  RATE_LIMIT: "BLOCKED_RATE_LIMIT",
  CEILING: "BLOCKED_CEILING",
  KILL_SWITCH: "BLOCKED_KILL_SWITCH",
  REBINDING: "BLOCKED_DNS_REBINDING",
  DNS_FAILED: "ERROR",
};

/** What the guard checks; `ledgerMethod` names a non-HTTP probe (such as TLS) in the ledger. */
export type GuardRequest = Omit<DispatchRequest, "headers" | "transport"> & { ledgerMethod?: string };

/**
 * The kernel check every outbound connection passes first: rate limit, fresh
 * DNS resolution, then evaluate(). A refusal is ledgered here; an allowed
 * caller ledgers its own outcome and must connect only to the returned IPs.
 */
export async function authorize(
  db: LedgerClient,
  req: GuardRequest,
): Promise<{ allowed: true; ips: string[] } | DeniedDecision> {
  const url = parseUrl(req.url);
  if (!url) {
    const decision: DeniedDecision = { allowed: false, reason: "Invalid URL", code: "OUT_OF_SCOPE" };
    await recordDenied(db, req, [], decision);
    return decision;
  }

  if (!req.rateLimiter.tryRemove()) {
    const decision: DeniedDecision = {
      allowed: false,
      reason: "Rate limit",
      code: "RATE_LIMIT",
    };
    await recordDenied(db, req, [], decision);
    return decision;
  }

  const resolvedIps = await (req.resolver ?? resolveHostIps)(url.hostname);

  const decision = evaluate({
    url: req.url,
    method: req.method,
    hostname: url.hostname,
    pathname: url.pathname,
    resolvedIps,
    scope: req.scope,
    adminBlocklist: req.adminBlocklist,
    killSwitchEngaged: req.killSwitchEngaged,
    pagesCrawled: req.pagesCrawled,
    requestsMade: req.requestsMade,
    depth: req.depth,
    allowPlaintextTwin: req.allowPlaintextTwin,
  });

  if (!decision.allowed) await recordDenied(db, req, resolvedIps, decision);
  return decision;
}

/**
 * The only path the worker uses to reach a target over HTTP. Every attempt,
 * allowed or refused, leaves a url_ledger row.
 */
export async function dispatch(
  db: LedgerClient,
  req: DispatchRequest,
): Promise<DispatchResult> {
  const decision = await authorize(db, req);
  if (!decision.allowed) return { ok: false, decision };

  const startedAt = Date.now();
  try {
    const pinned = pinTo(req.url, decision.ips[0]!);
    const transport = req.transport ?? fetchTransport;
    const res = await transport({
      url: pinned.url,
      method: req.method,
      headers: requestHeaders(pinned.host, req.userAgent, req.headers),
      serverName: pinned.serverName,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    const { body, bytes, truncated } =
      req.method === "HEAD" ? { body: "", bytes: 0, truncated: false } : await readCapped(res);

    await db.urlLedger.create({
      data: {
        scanJobId: req.scanJobId,
        url: req.url,
        httpMethod: req.method,
        resolvedIp: decision.ips[0] ?? "",
        decision: "ALLOWED",
        statusCode: res.status,
        responseTimeMs: Date.now() - startedAt,
        bytesReceived: bytes,
      },
    });

    return {
      ok: true,
      status: res.status,
      headers: res.headers,
      body,
      truncated,
      ips: decision.ips,
    };
  } catch (error) {
    await db.urlLedger.create({
      data: {
        scanJobId: req.scanJobId,
        url: req.url,
        httpMethod: req.method,
        resolvedIp: decision.ips[0] ?? "",
        decision: "ERROR",
        decisionReason: error instanceof Error ? error.message : "Dispatch failed",
        responseTimeMs: Date.now() - startedAt,
      },
    });

    throw error;
  }
}

function parseUrl(raw: string): URL | null {
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

/**
 * Rewrites the URL to the approved IP, so the connection cannot be steered by
 * a second DNS lookup (ADR-0004), and keeps the real name for the Host header
 * and for certificate verification.
 */
function pinTo(raw: string, ip: string): { url: string; host: string; serverName?: string } {
  const original = new URL(raw);
  const pinned = new URL(raw);
  pinned.hostname = ip.includes(":") ? `[${ip}]` : ip;
  const isIpLiteral = isIP(original.hostname.replace(/^\[|\]$/g, "")) !== 0;
  // The hostname setter ignores values it cannot parse; an unchanged name
  // would let fetch resolve DNS itself, so refuse rather than connect.
  if (pinned.hostname === original.hostname && !isIpLiteral) {
    throw new Error(`Could not pin ${original.hostname} to ${ip}`);
  }
  return {
    url: pinned.toString(),
    host: original.host,
    serverName: original.protocol === "https:" && !isIpLiteral ? original.hostname : undefined,
  };
}

/**
 * Caller headers override the defaults case-insensitively, so a probe's own
 * `Host` (A-08) replaces the real one instead of being joined to it.
 */
function requestHeaders(host: string, userAgent: string, extra: Record<string, string> = {}): Record<string, string> {
  const headers: Record<string, string> = { host, "user-agent": userAgent };
  for (const [name, value] of Object.entries(extra)) headers[name.toLowerCase()] = value;
  return headers;
}

/** Bun's fetch connects to the URL's IP and verifies the certificate against `tls.serverName`. */
const fetchTransport: Transport = ({ url, method, headers, serverName, signal }) =>
  fetch(url, {
    method,
    redirect: "manual",
    headers,
    signal,
    ...(serverName ? { tls: { serverName } } : {}),
  } as RequestInit);

/** Reads the body up to MAX_BODY_BYTES and cancels the stream past that. */
async function readCapped(res: Response): Promise<{ body: string; bytes: number; truncated: boolean }> {
  if (!res.body) return { body: "", bytes: 0, truncated: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  let truncated = false;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value.subarray(0, Math.min(value.byteLength, MAX_BODY_BYTES - bytes));
    body += decoder.decode(chunk, { stream: true });
    bytes += chunk.byteLength;
    if (chunk.byteLength < value.byteLength) {
      truncated = true;
      await reader.cancel();
      break;
    }
  }
  return { body: body + decoder.decode(), bytes, truncated };
}

async function recordDenied(
  db: LedgerClient,
  req: GuardRequest,
  resolvedIps: string[],
  decision: DeniedDecision,
): Promise<void> {
  await db.urlLedger.create({
    data: {
      scanJobId: req.scanJobId,
      url: req.url,
      httpMethod: req.ledgerMethod ?? req.method,
      resolvedIp: resolvedIps[0] ?? "",
      decision: LEDGER_DECISION[decision.code],
      decisionReason: decision.reason,
    },
  });
}
