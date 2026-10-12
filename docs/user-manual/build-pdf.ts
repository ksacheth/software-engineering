/**
 * Renders user-manual.html to WVS-User-Manual.pdf with headless Chromium.
 *
 *   bun docs/user-manual/build-pdf.ts
 *
 * Playwright lives in the worker's dependencies, so it is imported from there
 * rather than adding a root dependency for a documentation build. The page
 * size, margins, top band and page numbers all come from the @page rules in
 * the HTML, which is why preferCSSPageSize is set.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { chromium } from "../../apps/worker/node_modules/playwright";

const here = dirname(fileURLToPath(import.meta.url));
const source = pathToFileURL(join(here, "user-manual.html")).href;
const output = join(here, "WVS-User-Manual.pdf");

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  await page.goto(source, { waitUntil: "networkidle" });
  await page.pdf({ path: output, printBackground: true, preferCSSPageSize: true });
  console.log(`wrote ${output}`);
} finally {
  await browser.close();
}
