export function scannerUserAgent(): string {
  return (
    process.env.SCANNER_USER_AGENT ??
    "WebsiteVulnerabilityScanner/1.0"
  );
}

/** Whether the crawl renders pages in headless Chromium (DC-5). On unless SCANNER_RENDER_JS is false, 0, off or no. */
export function renderJsEnabled(): boolean {
  const raw = process.env.SCANNER_RENDER_JS?.trim().toLowerCase();
  return raw === undefined || !["false", "0", "off", "no"].includes(raw);
}
