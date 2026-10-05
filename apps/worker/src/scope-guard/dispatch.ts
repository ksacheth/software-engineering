import type { PrismaClient, ScopeDecision } from "@wvs/database";
import {
  evaluate,
  resolveHostIps,
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
  adminBlocklist: string[];
  killSwitchEngaged: boolean;

  pagesCrawled: number;
  requestsMade: number;
  depth: number;

  userAgent: string;

  rateLimiter: {
    tryRemove(): boolean;
  };
}

export type DeniedDecision = Extract<GuardDecision, { allowed: false }>;

export type DispatchResult =
  | {
      ok: true;
      status: number;
      headers: Headers;
      body: string;
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
export type GuardRequest = Omit<DispatchRequest, "headers"> & { ledgerMethod?: string };

/**
 * The kernel check every outbound connection passes first: rate limit, fresh
 * DNS resolution, then evaluate(). A refusal is ledgered here; an allowed
 * caller ledgers its own outcome and must connect only to the returned IPs.
 */
export async function authorize(
  db: LedgerClient,
  req: GuardRequest,
): Promise<{ allowed: true; ips: string[] } | DeniedDecision> {
  const url = new URL(req.url);

  if (!req.rateLimiter.tryRemove()) {
    const decision: DeniedDecision = {
      allowed: false,
      reason: "Rate limit",
      code: "RATE_LIMIT",
    };
    await recordDenied(db, req, [], decision);
    return decision;
  }

  const resolvedIps = await resolveHostIps(url.hostname);

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
    const res = await fetch(req.url, {
      method: req.method,
      redirect: "manual",
      headers: {
        "user-agent": req.userAgent,
        ...req.headers,
      },
      signal: AbortSignal.timeout(30_000),
    });

    const body = req.method === "HEAD" ? "" : await res.text();

    await db.urlLedger.create({
      data: {
        scanJobId: req.scanJobId,
        url: req.url,
        httpMethod: req.method,
        resolvedIp: decision.ips[0] ?? "",
        decision: "ALLOWED",
        statusCode: res.status,
        responseTimeMs: Date.now() - startedAt,
        bytesReceived: Buffer.byteLength(body),
      },
    });

    return {
      ok: true,
      status: res.status,
      headers: res.headers,
      body,
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
