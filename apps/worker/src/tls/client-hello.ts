/**
 * A hand-built TLS ClientHello and a reader for the server's first reply.
 *
 * Probing for legacy protocols and weak cipher suites cannot use node:tls: Bun
 * ignores minVersion/maxVersion, and neither BoringSSL nor OpenSSL 3 will offer
 * RC4 or export suites. A ClientHello is just bytes, and the ServerHello
 * answers the only question asked (would the server use this?), so the probe
 * never completes a handshake or sends application data.
 */

export const PROTOCOLS = {
  "SSLv3": 0x0300,
  "TLSv1": 0x0301,
  "TLSv1.1": 0x0302,
  "TLSv1.2": 0x0303,
} as const;

export type ProtocolName = keyof typeof PROTOCOLS;

/** Ordinary suites, offered when the question is only which protocol the server accepts. */
export const COMMON_SUITES = [
  0xc02f, 0xc030, 0xc02b, 0xc02c, // ECDHE GCM
  0xc013, 0xc014, 0xc009, 0xc00a, // ECDHE CBC
  0x009c, 0x009d, 0x002f, 0x0035, // RSA AES
  0x0033, 0x0039, // DHE AES
  0x000a, // RSA 3DES
];

/** Suites no server should accept, with the names reported in findings. */
export const WEAK_SUITES: Record<number, string> = {
  0x0001: "NULL-MD5",
  0x0002: "NULL-SHA",
  0x003b: "NULL-SHA256",
  0x0003: "EXP-RC4-MD5",
  0x0006: "EXP-RC2-CBC-MD5",
  0x0008: "EXP-DES-CBC-SHA",
  0x0014: "EXP-EDH-RSA-DES-CBC-SHA",
  0x0004: "RC4-MD5",
  0x0005: "RC4-SHA",
  0xc011: "ECDHE-RSA-RC4-SHA",
  0xc007: "ECDHE-ECDSA-RC4-SHA",
  0x0009: "DES-CBC-SHA",
  0x000a: "DES-CBC3-SHA",
  0xc012: "ECDHE-RSA-DES-CBC3-SHA",
  0x0016: "EDH-RSA-DES-CBC3-SHA",
  0x0018: "ADH-RC4-MD5",
  0x001b: "ADH-DES-CBC3-SHA",
  0x0034: "ADH-AES128-SHA",
};

export type ServerReply =
  | { kind: "server-hello"; version: number; cipherSuite: number }
  | { kind: "alert"; description: number }
  | { kind: "incomplete" }
  | { kind: "unexpected" };

export function buildClientHello(version: number, cipherSuites: number[], serverName: string): Buffer {
  const extensions = version >= PROTOCOLS["TLSv1"] ? helloExtensions(serverName, version) : Buffer.alloc(0);

  const body = Buffer.concat([
    u16(version),
    randomBytes32(),
    Buffer.from([0]), // no session id
    u16(cipherSuites.length * 2),
    Buffer.concat(cipherSuites.map(u16)),
    Buffer.from([1, 0]), // null compression only
    extensions.length > 0 ? Buffer.concat([u16(extensions.length), extensions]) : Buffer.alloc(0),
  ]);
  const handshake = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
  // Record-layer version stays at most TLS 1.0, as real clients send it.
  return Buffer.concat([Buffer.from([0x16]), u16(Math.min(version, PROTOCOLS["TLSv1"])), u16(handshake.length), handshake]);
}

/** Reads the first record the server sent back, if it is complete. */
export function readServerReply(data: Buffer): ServerReply {
  if (data.length < 5) return { kind: "incomplete" };
  const type = data[0];
  const length = data.readUInt16BE(3);
  if (data.length < 5 + length) return { kind: "incomplete" };
  const record = data.subarray(5, 5 + length);

  if (type === 0x15 && record.length >= 2) return { kind: "alert", description: record[1]! };
  if (type !== 0x16 || record[0] !== 0x02 || record.length < 4 + 2 + 32 + 1) return { kind: "unexpected" };

  const version = record.readUInt16BE(4);
  const sessionIdLength = record[4 + 2 + 32]!;
  const cipherOffset = 4 + 2 + 32 + 1 + sessionIdLength;
  if (record.length < cipherOffset + 2) return { kind: "unexpected" };
  return { kind: "server-hello", version, cipherSuite: record.readUInt16BE(cipherOffset) };
}

function helloExtensions(serverName: string, version: number): Buffer {
  const extensions = [
    extension(0x000a, withLength16(Buffer.concat([0x001d, 0x0017, 0x0018].map(u16)))), // x25519, P-256, P-384
    extension(0x000b, Buffer.from([1, 0])), // uncompressed points
  ];
  if (!isIpLiteral(serverName)) {
    const name = Buffer.from(serverName, "ascii");
    extensions.unshift(extension(0x0000, withLength16(Buffer.concat([Buffer.from([0]), u16(name.length), name]))));
  }
  if (version >= PROTOCOLS["TLSv1.2"]) {
    const algorithms = [0x0401, 0x0501, 0x0601, 0x0403, 0x0503, 0x0201, 0x0203];
    extensions.push(extension(0x000d, withLength16(Buffer.concat(algorithms.map(u16)))));
  }
  return Buffer.concat(extensions);
}

function extension(type: number, data: Buffer): Buffer {
  return Buffer.concat([u16(type), u16(data.length), data]);
}

function withLength16(data: Buffer): Buffer {
  return Buffer.concat([u16(data.length), data]);
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function u24(value: number): Buffer {
  return Buffer.from([(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff]);
}

function randomBytes32(): Buffer {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32)));
}

function isIpLiteral(host: string): boolean {
  return /^[\d.]+$/.test(host) || host.includes(":");
}
