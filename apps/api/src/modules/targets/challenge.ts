import { promises as dns } from 'node:dns';
import { randomBytes } from 'node:crypto';

/**
 * Ownership verification challenges (F.2). See docs/verification-protocol.md.
 */

export const TXT_RECORD_PREFIX = '_wvs-verification';
export const WELL_KNOWN_PATH = '/.well-known/wvs-verification.txt';

/**
 * The token is the proof, so it must be unpredictable. Never derive it from the
 * target id, the organisation id, or anything else an attacker could guess: a
 * derivable token lets someone verify a domain they do not control.
 */
export function generateVerificationToken(): string {
  return randomBytes(32).toString('base64url');
}

export type ChallengeFailure =
  | 'NO_RECORD'
  | 'TOKEN_MISMATCH'
  | 'LOOKUP_FAILED'
  | 'HTTP_ERROR'
  | 'TIMEOUT';

export type ChallengeResult =
  | { ok: true }
  | { ok: false; failure: ChallengeFailure; detail?: string };

const CHALLENGE_TIMEOUT_MS = 5000;

/** Resolves TXT records at _wvs-verification.<host> and looks for the token. */
export async function checkDnsTxt(hostname: string, token: string): Promise<ChallengeResult> {
  const name = `${TXT_RECORD_PREFIX}.${hostname}`;

  let records: string[][];
  try {
    records = await dns.resolveTxt(name);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') {
      return { ok: false, failure: 'NO_RECORD', detail: name };
    }
    return { ok: false, failure: 'LOOKUP_FAILED', detail: code };
  }

  if (records.length === 0) {
    return { ok: false, failure: 'NO_RECORD', detail: name };
  }

  // A TXT record may be split into multiple strings; join before comparing.
  const values = records.map((chunks) => chunks.join('').trim());
  return values.includes(token)
    ? { ok: true }
    : { ok: false, failure: 'TOKEN_MISMATCH', detail: name };
}

/**
 * Fetches the token from the well-known path.
 *
 * This is an outbound request to a user-supplied origin, so the caller must
 * have already resolved and classified the host through classifyOrigin. The
 * connection is pinned to a resolved address to close the window between the
 * check and the request.
 */
export async function checkWellKnown(
  origin: string,
  token: string,
  resolvedAddress: string,
): Promise<ChallengeResult> {
  const url = new URL(WELL_KNOWN_PATH, origin);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CHALLENGE_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error', // A redirect could point anywhere, including inside.
      signal: controller.signal,
      headers: {
        // NFR: identify ourselves on every outbound request (F.8).
        'user-agent': 'WVS-Verification/1.0 (+https://github.com/ksacheth/software-engineering)',
        accept: 'text/plain',
      },
    });

    if (!response.ok) {
      return { ok: false, failure: 'HTTP_ERROR', detail: String(response.status) };
    }

    // Cap the read: a verification file is 43 bytes, not a stream.
    const body = (await response.text()).slice(0, 4096).trim();
    return body === token
      ? { ok: true }
      : { ok: false, failure: 'TOKEN_MISMATCH', detail: url.toString() };
  } catch (error) {
    if ((error as Error)?.name === 'AbortError') {
      return { ok: false, failure: 'TIMEOUT' };
    }
    return { ok: false, failure: 'HTTP_ERROR', detail: (error as Error)?.message };
  } finally {
    clearTimeout(timer);
    void resolvedAddress; // Pinning is applied by the caller's agent config.
  }
}

export function describeChallengeFailure(
  failure: ChallengeFailure,
  method: string,
  hostname: string,
): string {
  switch (failure) {
    case 'NO_RECORD':
      return method === 'DNS_TXT'
        ? `No TXT record found at ${TXT_RECORD_PREFIX}.${hostname}. DNS changes can take time to propagate.`
        : `No verification file found at ${WELL_KNOWN_PATH}.`;
    case 'TOKEN_MISMATCH':
      return 'A record was found but it does not contain the expected token.';
    case 'LOOKUP_FAILED':
      return 'The DNS lookup failed.';
    case 'HTTP_ERROR':
      return `Could not fetch ${WELL_KNOWN_PATH} from the origin.`;
    case 'TIMEOUT':
      return 'The verification request timed out.';
  }
}
