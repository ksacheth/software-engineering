import { connect as connectTcp } from "node:net";
import { connect as connectTls } from "node:tls";
import type { ScopeSnapshot, TokenBucket } from "@wvs/scope-guard";
import type { CertificateFacts, LegacyProtocol, TlsFacts } from "@wvs/shared";

import { authorize, type LedgerClient } from "../scope-guard/dispatch.js";
import { certificateFacts } from "./certificate.js";
import { buildClientHello, COMMON_SUITES, PROTOCOLS, readServerReply, WEAK_SUITES, type ServerReply } from "./client-hello.js";

export interface TlsProbeOptions {
  scanJobId: string;
  scope: ScopeSnapshot;
  adminBlocklist: string[];
  isKillSwitchEngaged: () => Promise<boolean>;
  limiter: Pick<TokenBucket, "tryRemove" | "msUntilAvailable">;
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
    return this.guarded("certificate handshake", (ip) => readCertificate(ip, this.port, this.hostname));
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
    return this.guarded(`${label} ClientHello`, (ip) => exchangeHello(ip, this.port, hello));
  }

  /** One connection, approved by the guard and ledgered as TLS. */
  private async guarded<T>(label: string, connect: (ip: string) => Promise<T>): Promise<T> {
    await sleep(this.options.limiter.msUntilAvailable());
    const decision = await authorize(this.db, {
      url: `${this.options.scope.origin}/`,
      method: "GET",
      ledgerMethod: "TLS",
      scanJobId: this.options.scanJobId,
      scope: this.options.scope,
      adminBlocklist: this.options.adminBlocklist,
      killSwitchEngaged: await this.options.isKillSwitchEngaged(),
      pagesCrawled: 0,
      requestsMade: 0,
      depth: 0,
      userAgent: "",
      rateLimiter: this.options.limiter,
    });
    if (!decision.allowed) throw new Refused(decision.reason);

    const ip = decision.ips[0]!;
    const startedAt = Date.now();
    const result = await connect(ip);
    await this.db.urlLedger.create({
      data: {
        scanJobId: this.options.scanJobId,
        url: `${this.options.scope.origin}/`,
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

function readCertificate(ip: string, port: number, hostname: string): Promise<CertificateFacts | null> {
  return new Promise((resolve) => {
    const socket = connectTls({ host: ip, port, servername: hostname, rejectUnauthorized: false }, () => {
      const cert = socket.getPeerCertificate(true);
      const error = socket.authorizationError ? String(socket.authorizationError) : null;
      socket.end();
      resolve(cert && Object.keys(cert).length > 0 ? certificateFacts(cert, hostname, error) : null);
    });
    socket.setTimeout(PROBE_TIMEOUT_MS, () => {
      socket.destroy();
      resolve(null);
    });
    socket.on("error", () => resolve(null));
  });
}
