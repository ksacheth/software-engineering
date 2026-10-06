import { describe, expect, test } from "bun:test";
import type { CertificateFacts, TlsFacts } from "@wvs/shared";

import { loadDefinitions, runTlsDetectors } from "../src";

const catalogue = await loadDefinitions();
const DAY_MS = 86_400_000;
const inDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString();

function facts(overrides: Partial<TlsFacts> = {}, certificate: Partial<CertificateFacts> = {}): TlsFacts {
  return {
    origin: "https://shop.example.com",
    hostname: "shop.example.com",
    acceptedLegacyProtocols: [],
    acceptedWeakCipher: null,
    certificate: {
      subjectAltNames: ["shop.example.com"],
      validFrom: inDays(-60),
      validTo: inDays(300),
      hostnameMatches: true,
      selfSigned: false,
      trustError: null,
      signatureAlgorithm: "sha256WithRSAEncryption",
      keyType: "RSA",
      keyBits: 2048,
      ...certificate,
    },
    ...overrides,
  };
}

const findings = (input: TlsFacts | null) => runTlsDetectors(catalogue, "PASSIVE", input).findings;
const ids = (input: TlsFacts) => findings(input).map((f) => f.detectorId);

describe("TLS detectors", () => {
  test("a modern, trusted origin produces no findings", () => {
    expect(findings(facts())).toEqual([]);
  });

  test("a plaintext origin is not judged", () => {
    expect(findings(null)).toEqual([]);
  });

  test("P-11 reports each legacy protocol separately", () => {
    const reported = findings(facts({ acceptedLegacyProtocols: ["TLSv1", "TLSv1.1"] }));
    expect(reported.map((f) => [f.detectorId, f.affectedParameter])).toEqual([
      ["P-11", "TLSv1"],
      ["P-11", "TLSv1.1"],
    ]);
    expect(reported[0]).toMatchObject({ severity: "HIGH", cwe: "CWE-327", affectedUrl: "https://shop.example.com/" });
  });

  test("P-12 names the weak suite the server chose", () => {
    const [finding] = findings(facts({ acceptedWeakCipher: "ECDHE-RSA-RC4-SHA" }));
    expect(finding).toMatchObject({ detectorId: "P-12", affectedParameter: "ECDHE-RSA-RC4-SHA" });
  });

  test.each([
    ["expired", { validTo: inDays(-1) }, "expired"],
    ["expiring within 30 days", { validTo: inDays(10) }, "expires in"],
    ["not yet valid", { validFrom: inDays(2) }, "not valid until"],
  ])("P-13 flags a certificate that is %s", (_, certificate, detail) => {
    const [finding] = findings(facts({}, certificate));
    expect(finding?.detectorId).toBe("P-13");
    expect(finding?.description).toContain(detail);
  });

  test("P-13 leaves a certificate with 31 days left alone", () => {
    expect(ids(facts({}, { validTo: inDays(31.5) }))).toEqual([]);
  });

  test("P-14 flags a hostname mismatch and lists what the certificate covers", () => {
    const [finding] = findings(facts({}, { hostnameMatches: false, subjectAltNames: ["*.other.example"] }));
    expect(finding?.detectorId).toBe("P-14");
    expect(finding?.description).toContain("*.other.example");
  });

  test.each([
    [{ selfSigned: true, trustError: "DEPTH_ZERO_SELF_SIGNED_CERT" }, "self-signed"],
    [{ trustError: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY" }, "UNABLE_TO_GET_ISSUER_CERT_LOCALLY"],
  ])("P-15 flags an untrusted chain %#", (certificate, detail) => {
    const [finding] = findings(facts({}, certificate));
    expect(finding?.detectorId).toBe("P-15");
    expect(finding?.description).toContain(detail);
  });

  test.each([
    [{ signatureAlgorithm: "sha1WithRSAEncryption" }, "signature"],
    [{ keyBits: 1024 }, "key"],
    [{ keyType: "EC" as const, keyBits: 224 }, "key"],
  ])("P-16 flags a weak certificate %#", (certificate, parameter) => {
    expect(findings(facts({}, certificate))).toEqual([
      expect.objectContaining({ detectorId: "P-16", affectedParameter: parameter, severity: "MEDIUM" }),
    ]);
  });

  test("P-16 accepts a 256-bit EC key", () => {
    expect(ids(facts({}, { keyType: "EC", keyBits: 256, signatureAlgorithm: "ecdsa-with-SHA256" }))).toEqual([]);
  });

  test("certificate detectors stay quiet when no handshake completed", () => {
    expect(findings({ ...facts(), certificate: null })).toEqual([]);
  });
});
