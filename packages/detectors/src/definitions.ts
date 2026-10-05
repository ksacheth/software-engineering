import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { parse } from "yaml";

import type { ScanProfile } from "@wvs/shared";
import schema from "../schema/detector.schema.json" with { type: "json" };

export interface DetectorDefinition {
  id: string;
  name: string;
  type: "passive" | "active";
  cwe: string | null;
  owaspCategory: string | null;
  severity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | "INFO" | "VARIES";
  confidence: "CONFIRMED" | "FIRM" | "TENTATIVE";
  priority: "M" | "S" | "C";
  profiles: ScanProfile[];
  description: string;
  remediation: string;
}

export type DetectorCatalogue = ReadonlyMap<string, DetectorDefinition>;

export const DEFINITIONS_DIR = fileURLToPath(new URL("../definitions", import.meta.url));

const validate = new Ajv2020({ allErrors: true }).compile<DetectorDefinition>(schema);

/**
 * Loads and validates every detector definition (DC-8). Called at worker start,
 * so a malformed file stops the worker instead of a scan. Every problem is
 * reported at once.
 */
export async function loadDefinitions(dir: string = DEFINITIONS_DIR): Promise<DetectorCatalogue> {
  const catalogue = new Map<string, DetectorDefinition>();
  const problems: string[] = [];

  for (const type of ["passive", "active"] as const) {
    for (const file of await yamlFiles(join(dir, type))) {
      const result = checkDefinition(type, file, parse(await readFile(file, "utf8")));
      if (typeof result === "string") problems.push(result);
      else if (catalogue.has(result.id)) problems.push(`${file}: duplicate id ${result.id}`);
      else catalogue.set(result.id, result);
    }
  }

  if (problems.length > 0) {
    throw new Error(`Invalid detector definitions:\n${problems.join("\n")}`);
  }
  return catalogue;
}

/** The definitions a scan of this profile runs. */
export function definitionsForProfile(catalogue: DetectorCatalogue, profile: ScanProfile): DetectorDefinition[] {
  return [...catalogue.values()].filter((definition) => definition.profiles.includes(profile));
}

function checkDefinition(type: "passive" | "active", file: string, value: unknown): DetectorDefinition | string {
  if (!validate(value)) {
    const errors = validate.errors?.map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ");
    return `${file}: ${errors}`;
  }
  if (`${value.id}.yml` !== basename(file)) return `${file}: id ${value.id} does not match the file name`;
  if (value.type !== type) return `${file}: type ${value.type} is in the ${type} folder`;
  return value;
}

async function yamlFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((name) => name.endsWith(".yml")).sort().map((name) => join(dir, name));
}
