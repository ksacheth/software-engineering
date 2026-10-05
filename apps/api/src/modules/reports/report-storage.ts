import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { config } from "../../config/env";

/**
 * Generated report files, under REPORT_STORAGE_PATH.
 *
 * The row stores a path relative to that directory, so the directory can move
 * without a data migration. Every deployed API and worker must see the same
 * directory (a shared volume), since the worker writes what the API serves.
 */

function root(): string {
  return resolve(config.reports.storagePath);
}

/**
 * The absolute path for a stored relative path, refusing anything that would
 * leave the storage directory. Paths are written by this module alone, so a
 * refusal means the row was tampered with.
 */
function absolute(relativePath: string): string {
  const base = root();
  const full = resolve(base, relativePath);
  if (full !== base && !full.startsWith(base + sep)) {
    throw new Error(`Report path escapes storage: ${relativePath}`);
  }
  return full;
}

/** Writes the file and returns the relative path to store on the row. */
export async function storeReportFile(
  reportId: string,
  extension: string,
  bytes: Buffer,
): Promise<string> {
  const full = absolute(join(reportId.slice(0, 2), `${reportId}.${extension}`));
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, bytes, { mode: 0o600 });
  return relative(root(), full);
}

export async function readReportFile(relativePath: string): Promise<Buffer | null> {
  try {
    return await readFile(absolute(relativePath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function removeReportFile(relativePath: string): Promise<void> {
  await rm(absolute(relativePath), { force: true });
}
