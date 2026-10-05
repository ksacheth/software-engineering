export function scannerUserAgent(): string {
  return (
    process.env.SCANNER_USER_AGENT ??
    "WebsiteVulnerabilityScanner/1.0"
  );
}