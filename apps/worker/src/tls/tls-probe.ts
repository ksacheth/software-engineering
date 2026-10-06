import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import type { BlocklistEntry, ScopeSnapshot, TokenBucket } from "@wvs/scope-guard";
import type { CertificateFacts, LegacyProtocol, TlsFacts } from "@wvs/shared";

import { authorize, type LedgerClient, type RequestBudget } from "../scope-guard/dispatch.js";
import { certificateFacts } from "./certificate.js";
import { buildClientHello, COMMON_SUITES, PROTOCOLS, readServerReply, WEAK_SUITES, type ServerReply } from "./client-hello.js";

export interface TlsProbeOptions {
  scanJobId: string;
  scope: ScopeSnapshot;
  adminBlocklist: readonly BlocklistEntry[];
  isKillSwitchEngaged: () => Promise<boolean>;
  limiter: Pick<TokenBucket, "tryRemove" | "msUntilAvailable">;
  /** The scan's shared counters; each connection counts as one request against the ceiling. */
  budget: RequestBudget;
  /** Replace the sockets, for tests. */
  connectors?: {
    certificate?: (ip: string, port: number, hostname: string) => Promise<CertificateFacts | null>;
    hello?: (ip: string, port: number, hello: Buffer) => Promise<ServerReply>;
  };
}

const LEGACY_PROTOCOLS: LegacyProtocol[] = ["SSLv3", "TLSv1", "TLSv1.1"];
const PROBE_TIMEOUT_MS = 10_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Refused by the guard; the probe stops rather than guess. */
class Refused extends Error {}

/**
 * Learns what P-11..P-16 need about the scope's HTTPS origin: the certificate
 * from one ordinary handshake, then one bare ClientHello per legacy protocol
 * and one offering only weak suites. Every connection passes the scope guard,
 * goes only to an IP it approved, and is ledgered. Returns null for a
 * plaintext origin or when the guard refuses.
 */
export async function probeTls(db: LedgerClient, options: TlsProbeOptions): Promise<TlsFacts | null> {
  const origin = new URL(options.scope.origin);
  if (origin.protocol !== "https:") return null;
  const probe = new Probe(db, options, origin.hostname, Number(origin.port || 443));

  try {
    const certificate = await probe.certificate();
    const acceptedLegacyProtocols = await probe.legacyProtocols();
    const acceptedWeakCipher = await probe.weakCipher();
    return { origin: origin.origin, hostname: origin.hostname, acceptedLegacyProtocols, acceptedWeakCipher, certificate };
  } catch (error) {
    if (error instanceof Refused) return null;
    throw error;
  }
}

class Probe {
  constructor(
    private db: LedgerClient,
    private options: TlsProbeOptions,
    private hostname: string,
    private port: number,
  ) {}

  async certificate(): Promise<CertificateFacts | null> {
    const connect = this.options.connectors?.certificate ?? readCertificate;
    return this.guarded("certificate handshake", (ip) => connect(ip, this.port, this.hostname));
  }

  /** The legacy protocols the server answers with a ServerHello in that same version. */
  async legacyProtocols(): Promise<LegacyProtocol[]> {
    const accepted: LegacyProtocol[] = [];
    for (const protocol of LEGACY_PROTOCOLS) {
      const reply = await this.hello(protocol, PROTOCOLS[protocol], COMMON_SUITES);
      if (reply.kind === "server-hello" && reply.version === PROTOCOLS[protocol]) accepted.push(protocol);
    }
    return accepted;
  }

  /** Offered nothing but weak suites, the one the server picks, if any. */
  async weakCipher(): Promise<string | null> {
    const reply = await this.hello("TLSv1.2 weak suites", PROTOCOLS["TLSv1.2"], Object.keys(WEAK_SUITES).map(Number));
    return reply.kind === "server-hello" ? (WEAK_SUITES[reply.cipherSuite] ?? null) : null;
  }

  private async hello(label: string, version: number, suites: number[]): Promise<ServerReply> {
    const hello = buildClientHello(version, suites, this.hostname);
    const exchange = this.options.connectors?.hello ?? exchangeHello;
    return this.guarded(`${label} ClientHello`, (ip) => exchange(ip, this.port, hello));
  }

  /**
   * A handshake is a host-level action, so the guard is asked about the scope's
   * first entry path (its first included path, else the root), which is in
   * scope whenever anything is.
   */
  private get entryUrl(): string {
    return new URL(this.options.scope.includedPaths[0] ?? "/", this.options.scope.origin).toString();
  }

  /** One connection, approved by the guard, counted against the ceiling and ledgered as TLS. */
  private async guarded<T>(label: string, connect: (ip: string) => Promise<T>): Promise<T> {
    await sleep(this.options.limiter.msUntilAvailable());
    const url = this.entryUrl;
    const decision = await authorize(this.db, {
      url,
      method: "GET",
      ledgerMethod: "TLS",
      scanJobId: this.options.scanJobId,
      scope: this.options.scope,
      adminBlocklist: this.options.adminBlocklist,
      killSwitchEngaged: await this.options.isKillSwitchEngaged(),
      pagesCrawled: 0,
      requestsMade: this.options.budget.requestsMade,
      depth: 0,
      userAgent: "",
      rateLimiter: this.options.limiter,
    });
    if (!decision.allowed) throw new Refused(decision.reason);

    const ip = decision.ips[0]!;
    const startedAt = Date.now();
    this.options.budget.requestsMade += 1;
    const result = await connect(ip);
    await this.db.urlLedger.create({
      data: {
        scanJobId: this.options.scanJobId,
        url,
        httpMethod: "TLS",
        resolvedIp: ip,
        decision: "ALLOWED",
        decisionReason: label,
        responseTimeMs: Date.now() - startedAt,
      },
    });
    return result;
  }
}

/** Sends one ClientHello and reads the first record back; never completes the handshake. */
export function exchangeHello(ip: string, port: number, hello: Buffer): Promise<ServerReply> {
  return new Promise((resolve) => {
    let received = Buffer.alloc(0);
    const socket = connectTcp({ host: ip, port }, () => socket.write(hello));
    const finish = (reply: ServerReply) => {
      socket.destroy();
      resolve(reply);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS, () => finish({ kind: "incomplete" }));
    socket.on("data", (chunk) => {
      received = Buffer.concat([received, chunk]);
      const reply = readServerReply(received);
      if (reply.kind !== "incomplete") finish(reply);
    });
    socket.on("end", () => finish(readServerReply(received)));
    socket.on("error", () => finish({ kind: "incomplete" }));
  });
}

export function readCertificate(ip: string, port: number, hostname: string): Promise<CertificateFacts | null> {
  return new Promise((resolve) => {
    const socket = connectTls({ host: ip, port, servername: hostname, rejectUnauthorized: false }, () => {
      // The certificate is the target's data; a throw here would be an uncaught exception.
      try {
        const cert = socket.getPeerCertificate(true);
        const error = socket.authorizationError ? String(socket.authorizationError) : null;
        socket.end();
        resolve(cert && Object.keys(cert).length > 0 ? certificateFacts(cert, hostname, error) : null);
      } catch {
        socket.destroy();
        resolve(null);
      }
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}
