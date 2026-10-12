/**
 * Renders user-manual.html to WVS-User-Manual.docx with pandoc, for opening in
 * Google Docs or Word.
 *
 *   bun docs/user-manual/build-docx.ts
 *
 * The HTML is written for print, so the cover, callouts and decorations are
 * first rewritten into plain markup that pandoc maps onto the custom styles in
 * reference.docx (fonts, colours, A4 page, the blue band and page numbers).
 * docx-filter.lua adds the page breaks and the figure widths.
 */
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const output = join(here, "WVS-User-Manual.docx");

const styled = (style: string, inner: string) =>
  `<div data-custom-style="${style}"><p>${inner}</p></div>`;

const html = readFileSync(join(here, "user-manual.html"), "utf8")
  .replace(/<style>[\s\S]*?<\/style>/, "")
  // pandoc would print the page title as an extra title block at the top.
  .replace(/<title>[\s\S]*?<\/title>/, "")
  // pandoc reads only <main>, so the wordmark moves onto the cover itself.
  .replace(/<header class="masthead">[\s\S]*?<\/header>/, "")
  .replace('<section class="cover">', `<section class="cover">${styled("Cover Mark", "WVS")}`)
  .replace(/<div class="(band|end)">[\s\S]*?<\/div>/g, "")
  .replace(/<p class="team">([\s\S]*?)<\/p>/, (_, t) => styled("Cover Team", t))
  .replace(/<h1>([\s\S]*?)<\/h1>/, (_, t) => styled("Title", t))
  .replace(/<p class="meta">([\s\S]*?)<\/p>/g, (_, t) => styled("Cover Meta", t))
  .replace(/<p class="intro-label">([\s\S]*?)<\/p>/, (_, t) => styled("Intro Label", t))
  .replace(/<div class="tip">([\s\S]*?)<\/div>/g, (_, t) => styled("Tip", t));

const work = mkdtempSync(join(tmpdir(), "wvs-docx-"));
try {
  const source = join(work, "manual.html");
  writeFileSync(source, html);
  const pandoc = Bun.spawnSync([
    "pandoc", source,
    "--from", "html",
    "--to", "docx",
    "--reference-doc", join(here, "reference.docx"),
    "--lua-filter", join(here, "docx-filter.lua"),
    "--resource-path", here,
    "--output", output,
  ], { stderr: "inherit" });
  if (pandoc.exitCode !== 0) process.exit(pandoc.exitCode ?? 1);
  console.log(`wrote ${output}`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
