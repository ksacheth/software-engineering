import { describe, expect, test } from 'bun:test';
import { parseOrigin } from './origin';

describe('parseOrigin canonicalises', () => {
  const ok: [string, string][] = [
    ['https://Example.COM', 'https://example.com'],
    ['https://example.com/', 'https://example.com'],
    ['https://example.com:443', 'https://example.com'],
    ['http://example.com:80', 'http://example.com'],
    ['https://example.com:8443', 'https://example.com:8443'],
    ['http://sub.example.co.uk', 'http://sub.example.co.uk'],
  ];
  for (const [input, expected] of ok) {
    test(`${input} -> ${expected}`, () => {
      const r = parseOrigin(input);
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.origin).toBe(expected);
    });
  }
});

describe('parseOrigin refuses', () => {
  const bad: [string, string][] = [
    ['', 'MALFORMED'],
    ['example.com', 'MALFORMED'],
    ['ftp://example.com', 'UNSUPPORTED_SCHEME'],
    ['file:///etc/passwd', 'UNSUPPORTED_SCHEME'],
    ['https://user:pass@example.com', 'HAS_CREDENTIALS'],
    ['https://example.com/admin', 'HAS_PATH'],
    ['https://example.com/?a=1', 'HAS_PATH'],
    ['https://127.0.0.1', 'IS_IP_LITERAL'],
    ['https://169.254.169.254', 'IS_IP_LITERAL'],
    ['https://[::1]', 'IS_IP_LITERAL'],
  ];
  for (const [input, problem] of bad) {
    test(`${JSON.stringify(input)} -> ${problem}`, () => {
      const r = parseOrigin(input);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.problem).toBe(problem as never);
    });
  }
});
