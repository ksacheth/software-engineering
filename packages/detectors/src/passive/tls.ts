import type { TlsFacts } from "@wvs/shared";
import type { Observation, TlsDetector } from "../types";

const DAY_MS = 86_400_000;
const EXPIRY_WARNING_DAYS = 30;
const WEAK_SIGNATURE = /md2|md5|sha1/i;
const MIN_KEY_BITS = { RSA: 2048, EC: 256 } as const;

/** TLS findings belong to the origin; `parameter` separates distinct problems of one kind. */
function onOrigin(facts: TlsFacts, detail: string, parameter: string | null = null): Observation {
  return { affectedUrl: `${facts.origin}/`, affectedParameter: parameter, detail };
}

const p11: TlsDetector = {
  id: "P-11",
  inspect: (facts) =>
    facts.acceptedLegacyProtocols.map((protocol) =>
      onOrigin(facts, `The server completed a ${protocol} ServerHello.`, protocol),
    ),
};

const p12: TlsDetector = {
  id: "P-12",
  inspect: (facts) =>
    facts.acceptedWeakCipher
      ? [onOrigin(facts, `Offered only weak suites, the server chose ${facts.acceptedWeakCipher}.`, facts.acceptedWeakCipher)]
      : [],
};

const p13: TlsDetector = {
  id: "P-13",
  inspect(facts) {
    const cert = facts.certificate;
    if (!cert) return [];
    const now = Date.now();
    if (Date.parse(cert.validFrom) > now) return [onOrigin(facts, `The certificate is not valid until ${cert.validFrom}.`)];
    const daysLeft = Math.floor((Date.parse(cert.validTo) - now) / DAY_MS);
    if (daysLeft < 0) return [onOrigin(facts, `The certificate expired on ${cert.validTo}.`)];
    if (daysLeft <= EXPIRY_WARNING_DAYS) return [onOrigin(facts, `The certificate expires in ${daysLeft} days, on ${cert.validTo}.`)];
    return [];
  },
};

const p14: TlsDetector = {
  id: "P-14",
  inspect(facts) {
    const cert = facts.certificate;
    if (!cert || cert.hostnameMatches) return [];
    const names = cert.subjectAltNames.join(", ") || "no names";
    return [onOrigin(facts, `The certificate covers ${names}, not ${facts.hostname}.`)];
  },
};

const p15: TlsDetector = {
  id: "P-15",
  inspect(facts) {
    const cert = facts.certificate;
    if (!cert || (!cert.selfSigned && !cert.trustError)) return [];
    return [
      onOrigin(
        facts,
        cert.selfSigned
          ? "The certificate is self-signed."
          : `The chain did not verify against trusted roots (${cert.trustError}).`,
      ),
    ];
  },
};

const p16: TlsDetector = {
  id: "P-16",
  inspect(facts) {
    const cert = facts.certificate;
    if (!cert) return [];
    const observations: Observation[] = [];
    if (cert.signatureAlgorithm && WEAK_SIGNATURE.test(cert.signatureAlgorithm)) {
      observations.push(onOrigin(facts, `The certificate is signed with ${cert.signatureAlgorithm}.`, "signature"));
    }
    const minimum = cert.keyType === "other" ? 0 : MIN_KEY_BITS[cert.keyType];
    // A missing size (null, or the 0 a probe falls back to) is unknown, not a weak key.
    if (cert.keyBits !== null && cert.keyBits > 0 && cert.keyBits < minimum) {
      observations.push(onOrigin(facts, `The ${cert.keyType} key is ${cert.keyBits} bits, under ${minimum}.`, "key"));
    }
    return observations;
  },
};

export const TLS_DETECTORS: TlsDetector[] = [p11, p12, p13, p14, p15, p16];
