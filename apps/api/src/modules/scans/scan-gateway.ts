import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { prisma } from "@wvs/database";
import {
  SCAN_SOCKET_PING_TYPE,
  WS_PING_INTERVAL_MS,
  type ScanEvent,
} from "@wvs/shared";
import { config } from "../../config/env";
import { resolveAuth, toHeaders } from "../../common/session";
import { subscribeToScanEvents } from "./scan-bus";

/**
 * F.3 WebSocket gateway.
 *
 * `/ws` serves the existing multiplexed client and `/ws/scans/{id}` is the
 * shape SRS §3.2.4 names. One gateway filters in-process, so both cost the
 * same, and upgrading to either is supported rather than choosing between the
 * SRS and the existing client.
 *
 * Handshake authentication cannot reuse the Express middleware, because
 * middleware does not run on an HTTP upgrade. `resolveAuth` is shared with the
 * middleware so organisation and role resolution has one implementation.
 */

interface ScanClient {
  socket: WebSocket;
  organizationId: string;
  /** Set for a per-scan subscription, null for the multiplexed path. */
  scanJobId: string | null;
  isAlive: boolean;
}

/** Ownership cache for the multiplexed path, where no scan id was named. */
const OWNERSHIP_TTL_MS = 60_000;
const OWNERSHIP_CACHE_MAX = 1_000;

export interface ScanGateway {
  close(): Promise<void>;
}

export interface ScanGatewayOptions {
  /** Overridable so the keepalive can be observed without waiting 30s. */
  pingIntervalMs?: number;
}

function parsePath(url: string | undefined): { scanJobId: string | null } | null {
  const pathname = new URL(url ?? "/", "http://gateway.local").pathname;
  if (pathname === "/ws") return { scanJobId: null };

  const match = /^\/ws\/scans\/([^/]+)$/.exec(pathname);
  if (match) return { scanJobId: decodeURIComponent(match[1]!) };

  return null;
}

function reject(socket: Duplex, status: number, reason: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
  socket.destroy();
}

/**
 * Cookie-authenticated sockets need an origin check: a page on another origin
 * must not be able to open an authenticated socket on the user's behalf.
 *
 * An origin matching the request's own host is accepted as same-origin. That
 * case is not optional: reverse proxies including nginx with `proxy_set_header
 * Host` and the Vite dev proxy rewrite `Origin` to the address they forward to,
 * so the deployed dashboard presents the API's own host rather than the public
 * one. A cross-origin page cannot produce that combination, because the browser
 * sets `Origin` from the document, not the request.
 */
function isAllowedOrigin(
  origin: string | undefined,
  host: string | undefined,
): boolean {
  // No Origin header means a non-browser client (the test suite, a CLI). There
  // is no ambient credential to forge in that case, and the session cookie is
  // still required.
  if (!origin) return true;

  if (config.corsOrigins.includes(origin)) return true;

  try {
    return typeof host === "string" && new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function attachScanGateway(
  server: HttpServer,
  options: ScanGatewayOptions = {},
): ScanGateway {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<ScanClient>();
  const ownership = new Map<string, { organizationId: string; at: number }>();

  /** Authorisation for the multiplexed path: an organisation sees only its own scans. */
  async function ownsScan(organizationId: string, scanJobId: string): Promise<boolean> {
    const cached = ownership.get(scanJobId);
    if (cached && Date.now() - cached.at < OWNERSHIP_TTL_MS) {
      return cached.organizationId === organizationId;
    }

    const scan = await prisma.scanJob.findUnique({
      where: { id: scanJobId },
      select: { organizationId: true },
    });
    if (!scan) return false;

    if (ownership.size >= OWNERSHIP_CACHE_MAX) {
      ownership.clear();
    }
    ownership.set(scanJobId, { organizationId: scan.organizationId, at: Date.now() });
    return scan.organizationId === organizationId;
  }

  async function handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    const target = parsePath(req.url);
    if (!target) {
      reject(socket, 404, "Not Found");
      return;
    }

    // Cookie-authenticated sockets need an origin check; see isAllowedOrigin.
    if (!isAllowedOrigin(req.headers.origin, req.headers.host)) {
      reject(socket, 403, "Forbidden");
      return;
    }

    const resolution = await resolveAuth(toHeaders(req));
    if (!resolution.ok) {
      reject(socket, 401, "Unauthorized");
      return;
    }
    const { organizationId } = resolution.auth;

    if (target.scanJobId) {
      // Not found, not forbidden: the handshake must not confirm that another
      // organisation's scan exists.
      const owned = await prisma.scanJob.findFirst({
        where: { id: target.scanJobId, organizationId },
        select: { id: true },
      });
      if (!owned) {
        reject(socket, 404, "Not Found");
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const client: ScanClient = {
        socket: ws,
        organizationId,
        scanJobId: target.scanJobId,
        isAlive: true,
      };
      clients.add(client);

      ws.on("pong", () => {
        client.isAlive = true;
      });
      ws.on("close", () => {
        clients.delete(client);
      });
      ws.on("error", () => {
        clients.delete(client);
        ws.terminate();
      });
    });
  }

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void handleUpgrade(req, socket, head).catch((error) => {
      console.error("[scan-gateway] upgrade failed", error);
      reject(socket, 500, "Internal Server Error");
    });
  };
  server.on("upgrade", onUpgrade);

  const subscription = subscribeToScanEvents((event: ScanEvent) => {
    void fanOut(event);
  });

  async function fanOut(event: ScanEvent): Promise<void> {
    const payload = JSON.stringify(event);
    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.OPEN) continue;
      if (client.scanJobId !== null && client.scanJobId !== event.scanJobId) {
        continue;
      }
      if (client.scanJobId === null) {
        const allowed = await ownsScan(client.organizationId, event.scanJobId);
        if (!allowed) continue;
      }
      client.socket.send(payload);
    }
  }

  // A quiet scan must not look like a dead socket. The protocol ping keeps
  // intermediaries from dropping the connection; the JSON ping is what the
  // browser can actually observe.
  const pingTimer = setInterval(() => {
    const at = new Date().toISOString();
    const payload = JSON.stringify({ type: SCAN_SOCKET_PING_TYPE, at });
    for (const client of clients) {
      if (client.socket.readyState !== WebSocket.OPEN) {
        clients.delete(client);
        continue;
      }
      if (!client.isAlive) {
        client.socket.terminate();
        clients.delete(client);
        continue;
      }
      client.isAlive = false;
      client.socket.ping();
      client.socket.send(payload);
    }
  }, options.pingIntervalMs ?? WS_PING_INTERVAL_MS);
  pingTimer.unref?.();

  return {
    close: async () => {
      clearInterval(pingTimer);
      server.off("upgrade", onUpgrade);
      for (const client of clients) {
        client.socket.close(1001, "Server shutting down");
      }
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await subscription.close();
    },
  };
}
