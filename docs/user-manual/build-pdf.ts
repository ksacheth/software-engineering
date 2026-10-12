/**
 * Renders user-manual.html to WVS-User-Manual.pdf with headless Chromium.
 *
 *   bun docs/user-manual/build-pdf.ts
 *
 * Playwright lives in the worker's dependencies, so it is imported from there
 * rather than adding a root dependency for a documentation build. The page
 * size, margins, top band and page numbers all come from the @page rules in
 * the HTML, which is why preferCSSPageSize is set.
 *
 * Chromium cannot print a link's target page, so the Contents page numbers
 * come from two passes: render once, read where each heading landed with
 * pdftotext, add the numbers to the Contents, then render the final file. The
 * Contents sits on a page of its own, so adding numbers does not move anything.
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { chromium, type Page } from "../../apps/worker/node_modules/playwright";

const here = dirname(fileURLToPath(import.meta.url));
const source = pathToFileURL(join(here, "user-manual.html")).href;
const output = join(here, "WVS-User-Manual.pdf");
const PDF_OPTIONS = { printBackground: true, preferCSSPageSize: true } as const;

interface Entry {
  id: string;
  /** The text the heading prints, which is how it is found in the PDF. */
  label: string;
}

/** The Contents links, each with the text of the heading (or NOTE label) it points at. */
function contentsEntries(page: Page): Promise<Entry[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>(".toc a")].map((link) => {
      const id = link.getAttribute("href")!.slice(1);
      const target = document.getElementById(id)!;
      const heading = target.matches("h1, h2, h3, h4") ? target : target.querySelector("strong");
      return { id, label: (heading?.textContent ?? "").trim() };
    }),
  );
}

/** The text of each PDF page, in order; pdftotext separates pages with a form feed. */
function pageTexts(pdf: string): string[] {
  const result = Bun.spawnSync(["pdftotext", "-layout", pdf, "-"], { stderr: "inherit" });
  if (result.exitCode !== 0) throw new Error("pdftotext failed; install poppler to build the Contents page numbers");
  return result.stdout.toString().split("\f");
}

/** The 1-based page whose text has a line that is exactly `label`, after the Contents page. */
function pageOf(pages: string[], label: string, contentsPage: number): number {
  const index = pages.findIndex(
    (text, i) => i + 1 > contentsPage && text.split("\n").some((line) => line.trim() === label),
  );
  if (index === -1) throw new Error(`Heading "${label}" was not found in the rendered PDF`);
  return index + 1;
}

function addPageNumbers(page: Page, numbers: Record<string, number>): Promise<void> {
  return page.evaluate((numbers) => {
    for (const link of document.querySelectorAll<HTMLAnchorElement>(".toc a")) {
      const number = numbers[link.getAttribute("href")!.slice(1)];
      link.insertAdjacentHTML("beforeend", `<span class="leader"></span><span class="pg">${number}</span>`);
    }
  }, numbers);
}

const browser = await chromium.launch();
const work = mkdtempSync(join(tmpdir(), "wvs-pdf-"));
try {
  const page = await browser.newPage();
  await page.goto(source, { waitUntil: "networkidle" });

  const draft = join(work, "draft.pdf");
  await page.pdf({ path: draft, ...PDF_OPTIONS });
  const pages = pageTexts(draft);
  // The Contents is the page after the cover, and its own entries are not headings.
  const contentsPage = pages.findIndex((text) => text.split("\n").some((line) => line.trim() === "Contents")) + 1;

  const entries = await contentsEntries(page);
  const numbers = Object.fromEntries(entries.map(({ id, label }) => [id, pageOf(pages, label, contentsPage)]));
  await addPageNumbers(page, numbers);

  await page.pdf({ path: output, ...PDF_OPTIONS });
  console.log(`wrote ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
  await browser.close();
}
