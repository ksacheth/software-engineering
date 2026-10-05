export interface MockCrawlRecord {
  url: string;
  method?: string;
  statusCode?: number;
  contentType?: string;
  requestHeaders?: Record<string, string> | null;
  responseHeaders?: Record<string, string> | null;
  forms?: any;
  parameters?: any;
  responseBody?: string | null;
}

export interface RawFindingEvidence {
  requestHeaders?: Record<string, string> | null;
  requestBody?: string | null;
  responseHeaders?: Record<string, string> | null;
  responseBody?: string | null;
  curlCommand?: string | null;
  extractedSnippet?: string | null;
}

export interface RawFinding {
  detectorId: string;
  name: string;
  description: string;
  remediation: string;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO";
  confidence: "CONFIRMED" | "FIRM" | "TENTATIVE";
  cwe?: string;
  owaspCategory?: string;
  affectedUrl: string;
  affectedParameter?: string | null;
  cvssScore?: number;
  cvssVector?: string;
  cveId?: string;
  epssScore?: number;
  epssPercentile?: number;
  evidence?: RawFindingEvidence;
}

export class MockDetector {
  /**
   * Analyzes crawl records deterministically without network calls or Math.random().
   */
  static analyze(records: MockCrawlRecord[]): RawFinding[] {
    if (!records || records.length === 0) {
      return [];
    }

    const findings: RawFinding[] = [];

    for (const record of records) {
      const url = record.url;
      const lowerUrl = url.toLowerCase();
      const headers = record.responseHeaders || {};

      // 1. Check for Security Header Issue (P-01) - Missing HSTS or CSP
      const hasHsts = Object.keys(headers).some(
        (h) => h.toLowerCase() === "strict-transport-security"
      );
      const hasCsp = Object.keys(headers).some(
        (h) => h.toLowerCase() === "content-security-policy"
      );

      if (!hasHsts || !hasCsp) {
        findings.push({
          detectorId: "P-01",
          name: "Missing Security Headers",
          description: "The response is missing critical HTTP security headers (Strict-Transport-Security or Content-Security-Policy).",
          remediation: "Configure the server to include HSTS and Content-Security-Policy headers in all HTTP responses.",
          severity: "MEDIUM",
          confidence: "CONFIRMED",
          cwe: "CWE-693",
          owaspCategory: "A05:2021-Security Misconfiguration",
          affectedUrl: url,
          affectedParameter: null,
          cvssScore: 5.3,
          cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:L/A:N",
          evidence: {
            requestHeaders: record.requestHeaders || { "User-Agent": "WVS-Scanner/1.0" },
            responseHeaders: record.responseHeaders || { "Content-Type": "text/html" },
            curlCommand: `curl -I "${url}"`,
            extractedSnippet: !hasHsts ? "Missing Strict-Transport-Security header" : "Missing Content-Security-Policy header",
          },
        });
      }

      // 2. Check for Reflected XSS (A-01)
      if (
        lowerUrl.includes("search") ||
        lowerUrl.includes("q=") ||
        lowerUrl.includes("query") ||
        lowerUrl.includes("xss") ||
        (record.parameters && Array.isArray(record.parameters) && record.parameters.length > 0)
      ) {
        const paramName = lowerUrl.includes("q=") ? "q" : lowerUrl.includes("query") ? "query" : "q";
        findings.push({
          detectorId: "A-01",
          name: "Reflected Cross-Site Scripting (XSS)",
          description: "Unsanitized user input is reflected directly into the HTML response body, allowing arbitrary JavaScript execution.",
          remediation: "Contextually encode all user-supplied input before rendering it into the HTML DOM.",
          severity: "HIGH",
          confidence: "FIRM",
          cwe: "CWE-79",
          owaspCategory: "A03:2021-Injection",
          affectedUrl: url,
          affectedParameter: paramName,
          cvssScore: 7.2,
          cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N",
          evidence: {
            requestHeaders: record.requestHeaders || { "User-Agent": "WVS-Scanner/1.0" },
            responseHeaders: record.responseHeaders || { "Content-Type": "text/html" },
            requestBody: `GET ${url} HTTP/1.1`,
            responseBody: record.responseBody || `<html><body>Results for <script>alert(1)</script></body></html>`,
            curlCommand: `curl "${url}?${paramName}=%3Cscript%3Ealert(1)%3C/script%3E"`,
            extractedSnippet: `Results for <script>alert(1)</script>`,
          },
        });
      }

      // 3. Check for SQL Injection (A-02)
      if (
        lowerUrl.includes("login") ||
        lowerUrl.includes("sqli") ||
        lowerUrl.includes("id=") ||
        lowerUrl.includes("user=") ||
        lowerUrl.includes("admin")
      ) {
        const paramName = lowerUrl.includes("id=") ? "id" : lowerUrl.includes("user=") ? "user" : "id";
        findings.push({
          detectorId: "A-02",
          name: "SQL Injection",
          description: "User parameter is concatenated directly into a database query string, allowing unauthorized data retrieval.",
          remediation: "Use parameterized queries or prepared statements for all database interactions.",
          severity: "CRITICAL",
          confidence: "CONFIRMED",
          cwe: "CWE-89",
          owaspCategory: "A03:2021-Injection",
          affectedUrl: url,
          affectedParameter: paramName,
          cvssScore: 9.8,
          cvssVector: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H",
          evidence: {
            requestHeaders: record.requestHeaders || { "User-Agent": "WVS-Scanner/1.0" },
            responseHeaders: record.responseHeaders || { "Content-Type": "text/html" },
            requestBody: `GET ${url}?${paramName}=1' OR '1'='1 HTTP/1.1`,
            responseBody: record.responseBody || "Syntax error in SQL statement near '1'='1'",
            curlCommand: `curl "${url}?${paramName}=1'%20OR%20'1'='1"`,
            extractedSnippet: "Syntax error in SQL statement near '1'='1'",
          },
        });
      }
    }

    return findings;
  }
}
