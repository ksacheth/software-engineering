// @ts-ignore
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { fileURLToPath } from "node:url";

import { signatureAlgorithm } from "./certificate.js";
import { buildClientHello, PROTOCOLS, readServerReply } from "./client-hello.js";
import { exchangeHello } from "./tls-probe.js";

function der(fixture: string): Buffer {
  const pem = readFileSync(fileURLToPath(new URL(`fixtures/${fixture}`, import.meta.url)), "utf8");
  return Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ""), "base64");
}

/** A ServerHello record choosing `version` and `cipherSuite`, as a server would send it. */
function serverHello(version: number, cipherSuite: number): Buffer {
  const body = Buffer.concat([
    Buffer.from([version >> 8, version & 0xff]),
    Buffer.alloc(32, 7),
    Buffer.from([0]),
    Buffer.from([cipherSuite >> 8, cipherSuite & 0xff, 0]),
  ]);
  const handshake = Buffer.concat([Buffer.from([0x02, 0, 0, body.length]), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0, handshake.length]), handshake]);
}

describe("buildClientHello", () => {
  test("offers the requested version, suites and server name", () => {
    const hello = buildClientHello(PROTOCOLS["TLSv1.1"], [0x002f, 0x0035], "shop.example.com");
    expect(hello[0]).toBe(0x16);
    expect(hello.readUInt16BE(3)).toBe(hello.length - 5);
    expect(hello[5]).toBe(0x01);
    expect(hello.readUInt16BE(9)).toBe(PROTOCOLS["TLSv1.1"]);
    expect(hello.includes(Buffer.from([0x00, 0x2f, 0x00, 0x35]))).toBe(true);
    expect(hello.includes(Buffer.from("shop.example.com"))).toBe(true);
  });

  test("sends no extensions in an SSLv3 hello, and no SNI for an IP", () => {
    expect(buildClientHello(PROTOCOLS.SSLv3, [0x002f], "shop.example.com").includes(Buffer.from("shop"))).toBe(false);
    expect(buildClientHello(PROTOCOLS.TLSv1, [0x002f], "203.0.113.10").includes(Buffer.from("203.0.113.10"))).toBe(false);
  });
});

describe("readServerReply", () => {
  test("reads the version and suite a server chose", () => {
    expect(readServerReply(serverHello(0x0301, 0xc014))).toEqual({ kind: "server-hello", version: 0x0301, cipherSuite: 0xc014 });
  });

  test("reads a refusal alert", () => {
    expect(readServerReply(Buffer.from([0x15, 0x03, 0x03, 0x00, 0x02, 0x02, 0x46]))).toEqual({ kind: "alert", description: 70 });
  });

  test("waits for a complete record", () => {
    expect(readServerReply(serverHello(0x0303, 0x002f).subarray(0, 20))).toEqual({ kind: "incomplete" });
  });
});

describe("exchangeHello", () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function serve(reply: (hello: Buffer) => Buffer | null): Promise<number> {
    server = createServer((socket) =>
      socket.once("data", (hello) => {
        const answer = reply(hello);
        if (answer) socket.write(answer);
        socket.end();
      }),
    );
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    return (server.address() as { port: number }).port;
  }

  test("reports the ServerHello a server sends back", async () => {
    const port = await serve((hello) => serverHello(hello.readUInt16BE(9), 0x000a));
    const reply = await exchangeHello("127.0.0.1", port, buildClientHello(PROTOCOLS.TLSv1, [0x000a], "a.example"));
    expect(reply).toEqual({ kind: "server-hello", version: PROTOCOLS.TLSv1, cipherSuite: 0x000a });
  });

  test("treats a server that hangs up as not accepting", async () => {
    const port = await serve(() => null);
    expect((await exchangeHello("127.0.0.1", port, buildClientHello(PROTOCOLS.SSLv3, [0x002f], "a.example"))).kind).not.toBe(
      "server-hello",
    );
  });
});

describe("signatureAlgorithm", () => {
  test("reads the algorithm a certificate is signed with", () => {
    expect(signatureAlgorithm(der("sha1-rsa1024.pem"))).toBe("sha1WithRSAEncryption");
    expect(signatureAlgorithm(der("ecdsa-p256.pem"))).toBe("ecdsa-with-SHA256");
  });

  test("returns null for bytes that are not a certificate", () => {
    expect(signatureAlgorithm(Buffer.from([0x30]))).toBeNull();
  });
});
