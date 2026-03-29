import { readdir, readFile } from "node:fs/promises";
import { join, relative, dirname, basename, extname } from "node:path";
import type { SqlFile } from "./types.js";

/**
 * Walk srcDir looking for sql/ directories.
 * Returns a Map from output file path → list of SqlFiles.
 *
 * Convention:
 *   src/app/sql/find_user.sql → output: src/app/sql.ts
 *   src/users/sql/list.sql    → output: src/users/sql.ts
 */
export async function discover(
  srcDir: string
): Promise<Map<string, SqlFile[]>> {
  const result = new Map<string, SqlFile[]>();
  await walk(srcDir, srcDir, result);
  return result;
}

async function walk(
  current: string,
  srcDir: string,
  result: Map<string, SqlFile[]>
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    if (!entry.isDirectory()) continue;

    const full = join(current, entry.name);

    if (entry.name === "sql") {
      const files = await readSqlDir(full, srcDir);
      if (files.length > 0) {
        const outFile = join(dirname(full), "sql.ts");
        result.set(outFile, files);
      }
    } else {
      await walk(full, srcDir, result);
    }
  }
}

async function readSqlDir(
  dir: string,
  srcDir: string
): Promise<SqlFile[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: SqlFile[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || extname(entry.name) !== ".sql" || entry.name.startsWith(".")) {
      continue;
    }

    const filePath = join(dir, entry.name);
    const queryName = basename(entry.name, ".sql");
    const modulePath = relative(srcDir, dirname(dir));
    const content = await readFile(filePath, "utf8");

    files.push({ filePath, queryName, modulePath, content });
  }

  return files.sort((a, b) => a.queryName.localeCompare(b.queryName));
}
