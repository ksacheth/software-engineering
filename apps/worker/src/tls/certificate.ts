import { checkServerIdentity, type DetailedPeerCertificate } from "node:tls";
import type { CertificateFacts } from "@wvs/shared";

const SELF_SIGNED = new Set(["DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN"]);
/** Reported by P-13 and P-14 from the certificate itself, not as a trust failure. */
const NOT_TRUST_ERRORS = new Set(["CERT_HAS_EXPIRED", "CERT_NOT_YET_VALID", "ERR_TLS_CERT_ALTNAME_INVALID"]);

/** DER-encoded signature algorithm OIDs, by name. */
const SIGNATURE_OIDS: Record<string, string> = {
  "2a864886f70d010102": "md2WithRSAEncryption",
  "2a864886f70d010104": "md5WithRSAEncryption",
  "2a864886f70d010105": "sha1WithRSAEncryption",
  "2a864886f70d01010b": "sha256WithRSAEncryption",
  "2a864886f70d01010c": "sha384WithRSAEncryption",
  "2a864886f70d01010d": "sha512WithRSAEncryption",
  "2a864886f70d01010a": "rsassaPss",
  "2a8648ce3d0401": "ecdsa-with-SHA1",
  "2a8648ce3d040302": "ecdsa-with-SHA256",
  "2a8648ce3d040303": "ecdsa-with-SHA384",
  "2a8648ce3d040304": "ecdsa-with-SHA512",
  "2a8648ce380403": "dsa-with-SHA1",
  "2b6570": "Ed25519",
};

export function certificateFacts(
  cert: DetailedPeerCertificate,
  hostname: string,
  authorizationError: string | null,
): CertificateFacts {
  const isEc = Boolean((cert as { asn1Curve?: string }).asn1Curve || (cert as { nistCurve?: string }).nistCurve);
  return {
    subjectAltNames: (cert.subjectaltname ?? "")
      .split(",")
      .map((name) => name.trim().replace(/^DNS:/, ""))
      .filter(Boolean),
    validFrom: new Date(cert.valid_from).toISOString(),
    validTo: new Date(cert.valid_to).toISOString(),
    hostnameMatches: checkServerIdentity(hostname, cert) === undefined,
    selfSigned: authorizationError !== null && SELF_SIGNED.has(authorizationError),
    trustError: authorizationError && !NOT_TRUST_ERRORS.has(authorizationError) ? authorizationError : null,
    signatureAlgorithm: cert.raw ? signatureAlgorithm(cert.raw) : null,
    keyType: isEc ? "EC" : cert.modulus ? "RSA" : "other",
    keyBits: cert.bits ?? 0,
  };
}

/**
 * Reads Certificate.signatureAlgorithm from DER. Neither Bun nor Node exposes
 * it, and it is the field P-16 needs.
 *
 * Certificate ::= SEQUENCE { tbsCertificate SEQUENCE, signatureAlgorithm SEQUENCE { OID, ... }, ... }
 */
export function signatureAlgorithm(der: Buffer): string | null {
  try {
    const certificate = readHeader(der, 0);
    const tbs = readHeader(der, certificate.contentStart);
    const algorithm = readHeader(der, tbs.contentStart + tbs.length);
    const oid = readHeader(der, algorithm.contentStart);
    if (der[algorithm.contentStart] !== 0x06) return null;
    const hex = der.subarray(oid.contentStart, oid.contentStart + oid.length).toString("hex");
    return SIGNATURE_OIDS[hex] ?? `oid:${hex}`;
  } catch {
    return null;
  }
}

function readHeader(der: Buffer, offset: number): { contentStart: number; length: number } {
  const first = der[offset + 1];
  if (first === undefined) throw new Error("truncated DER");
  if (first < 0x80) return { contentStart: offset + 2, length: first };
  const bytes = first & 0x7f;
  let length = 0;
  for (let i = 0; i < bytes; i++) length = (length << 8) | der[offset + 2 + i]!;
  return { contentStart: offset + 2 + bytes, length };
}
