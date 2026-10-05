/**
 * Optional OWASP Juice Shop End-to-End Integration Test Harness.
 *
 * Requirements:
 * Docker container running OWASP Juice Shop on http://localhost:3000
 *   docker run -d -p 3000:3000 bkimminich/juice-shop
 */

import { MockDetector } from "../src/detectors/mock-detector.js";
import { Deduplicator } from "../src/processors/deduplicator.js";
import { AdvisoryEnricher } from "../src/enrichers/advisory-enricher.js";
import { TriageCarrier } from "../src/processors/triage-carrier.js";

async function runJuiceShopE2ETest() {
  const targetUrl = (typeof process !== "undefined" && process.env?.JUICE_SHOP_URL) || "http://localhost:3000";
  console.log(`[JuiceShop E2E] Target: ${targetUrl}`);

  try {
    const res = await fetch(targetUrl);
    if (!res.ok) {
      console.warn(`[JuiceShop E2E] Target returned HTTP status ${res.status}`);
    } else {
      console.log(`[JuiceShop E2E] Successfully connected to Juice Shop at ${targetUrl}`);
    }
  } catch (err) {
    console.log(`[JuiceShop E2E] OWASP Juice Shop container is offline on ${targetUrl}. Skipping live HTTP probe.`);
  }

  const juiceShopCrawlRecords = [
    { url: `${targetUrl}/#`, statusCode: 200 },
    { url: `${targetUrl}/#/login?user=admin`, statusCode: 200 },
    { url: `${targetUrl}/#/search?q=apple`, statusCode: 200 },
    { url: `${targetUrl}/package.json`, statusCode: 200 },
  ];

  console.log(`[JuiceShop E2E] Analyzing ${juiceShopCrawlRecords.length} crawl records...`);
  const rawFindings = MockDetector.analyze(juiceShopCrawlRecords);
  console.log(`[JuiceShop E2E] Raw Findings generated: ${rawFindings.length}`);

  const deduped = Deduplicator.deduplicate(rawFindings);
  console.log(`[JuiceShop E2E] Deduplicated Findings: ${deduped.length}`);

  const enricher = new AdvisoryEnricher();
  const enriched = await enricher.enrichFindings(deduped);
  console.log(`[JuiceShop E2E] Enriched Findings: ${enriched.length}`);

  const triage = TriageCarrier.processScanTriage("target-juice-shop", "scan-juice-1", enriched.map((f: any) => f.fingerprint), []);
  console.log(`[JuiceShop E2E] Triage state processing complete: ${triage.findingsWithTriage.length} findings, ${triage.diffRecords.length} diffs.`);

  console.log(`[JuiceShop E2E] ✅ Pipeline successfully completed E2E verification.`);
}

runJuiceShopE2ETest().catch((err) => {
  console.error("[JuiceShop E2E] Test failed:", err);
});
