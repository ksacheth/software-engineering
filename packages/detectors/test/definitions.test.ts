import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFINITIONS_DIR, definitionsForProfile, detectorVersions, loadDefinitions } from "../src";

const SRS = join(import.meta.dir, "../../../docs/srs/SRS.md");
const P01 = await readFile(join(DEFINITIONS_DIR, "passive/P-01.yml"), "utf8");

/** Appendix B entries: `- **P-01** Name - CWE-693, A05, Medium, M.` */
async function appendixB(): Promise<Map<string, string>> {
  const srs = await readFile(SRS, "utf8");
  return new Map([...srs.matchAll(/^- \*\*([PA]-\d\d)\*\* (.+)$/gm)].map((m) => [m[1]!, m[2]!]));
}

const SEVERITY: Record<string, string> = {
  Critical: "CRITICAL",
  High: "HIGH",
  Medium: "MEDIUM",
  Low: "LOW",
  Info: "INFO",
  varies: "VARIES",
};

describe("detector catalogue", () => {
  test("defines exactly the Appendix B detectors", async () => {
    const catalogue = await loadDefinitions();
    expect([...catalogue.keys()].sort()).toEqual([...(await appendixB()).keys()].sort());
  });

  test("matches Appendix B for CWE, OWASP category, severity and priority", async () => {
    const catalogue = await loadDefinitions();
    for (const [id, entry] of await appendixB()) {
      const definition = catalogue.get(id)!;
      const meta = entry.slice(entry.search(/(CWE-\d+|no CWE)/));
      const fields = meta.replace(/\.$/, "").split(", ");

      expect({ id, cwe: definition.cwe }).toEqual({ id, cwe: meta.match(/CWE-\d+/)?.[0] ?? null });
      const owasp = meta.match(/\bA(\d\d)\b/);
      expect({ id, owasp: definition.owaspCategory }).toEqual({ id, owasp: owasp ? `A${owasp[1]}:2021` : null });
      const severity = fields.map((f) => SEVERITY[f.split(" ")[0]!]).find(Boolean);
      expect({ id, severity: definition.severity }).toEqual({ id, severity: severity as any });
      expect({ id, priority: definition.priority }).toEqual({ id, priority: fields.at(-1) as any });
    }
  });

  test("a PASSIVE scan runs no active detector", async () => {
    const passive = definitionsForProfile(await loadDefinitions(), "PASSIVE");
    expect(passive.length).toBe(31);
    expect(passive.every((d) => d.type === "passive")).toBe(true);
  });

  test("a STANDARD scan runs every detector", async () => {
    expect(definitionsForProfile(await loadDefinitions(), "STANDARD").length).toBe(45);
  });

  test("records the version of each detector a profile runs", async () => {
    const catalogue = await loadDefinitions();
    const passive = detectorVersions(catalogue, "PASSIVE");
    expect(Object.keys(passive)).toHaveLength(31);
    expect(passive["A-01"]).toBeUndefined();
    expect(detectorVersions(catalogue, "STANDARD")["A-01"]).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe("loadDefinitions", () => {
  async function catalogueWith(files: Record<string, string>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "wvs-detectors-"));
    await mkdir(join(dir, "passive"));
    await mkdir(join(dir, "active"));
    for (const [path, body] of Object.entries(files)) await writeFile(join(dir, path), body);
    return dir;
  }


  test("rejects a definition that breaks the schema and names every bad file", async () => {
    const dir = await catalogueWith({
      "passive/P-01.yml": P01.replace("severity: MEDIUM", "severity: SEVERE"),
      "passive/P-02.yml": P01.replace("id: P-01", "id: P-02").replace(/^remediation:.*$/m, ""),
    });
    const error = await loadDefinitions(dir).catch((e: Error) => e.message);
    expect(error).toContain("P-01.yml");
    expect(error).toContain("P-02.yml");
  });

  test("rejects a definition without a version", async () => {
    const dir = await catalogueWith({ "passive/P-01.yml": P01.replace(/^version:.*\n/m, "") });
    await expect(loadDefinitions(dir)).rejects.toThrow("P-01.yml");
  });

  test("rejects an id that does not match its file name", async () => {
    const dir = await catalogueWith({ "passive/P-02.yml": P01 });
    await expect(loadDefinitions(dir)).rejects.toThrow("does not match the file name");
  });

  test("rejects an active detector that would run in a PASSIVE scan", async () => {
    const active = P01.replace("id: P-01", "id: A-01").replace("type: passive", "type: active");
    const dir = await catalogueWith({ "active/A-01.yml": active });
    await expect(loadDefinitions(dir)).rejects.toThrow("A-01.yml");
  });
});
