import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { discover } from "./discovery.js";
import { parse, validateQueryName } from "./parser.js";
import { createClient, introspect } from "./introspector.js";
import { generate } from "./codegen.js";
import type { SqloveError } from "./errors.js";
import * as Err from "./errors.js";
import type { GeneratedModule, ParsedQuery } from "./types.js";

export interface PipelineResult {
  modules: GeneratedModule[];
  written: string[];
  errors: SqloveError[];
}

/**
 * Run the full pipeline: discover → parse → introspect → generate → write.
 */
export async function run(srcDir: string): Promise<PipelineResult> {
  const modules: GeneratedModule[] = [];
  const written: string[] = [];
  const errors: SqloveError[] = [];

  // 1. Discover sql/ directories
  const discovered = await discover(srcDir);
  if (discovered.size === 0) {
    return { modules, written, errors };
  }

  // 2. Parse all SQL files
  const moduleQueries = new Map<string, ParsedQuery[]>();
  for (const [outPath, files] of discovered) {
    const parsed: ParsedQuery[] = [];
    for (const file of files) {
      // Validate name
      const nameError = validateQueryName(file.queryName);
      if (nameError) {
        errors.push(Err.InvalidQueryName(file.filePath, file.queryName, nameError));
        continue;
      }
      try {
        parsed.push(parse(file));
      } catch (err: any) {
        errors.push(Err.ParseError(file.filePath, err.message ?? String(err)));
      }
    }
    if (parsed.length > 0) {
      moduleQueries.set(outPath, parsed);
    }
  }

  if (moduleQueries.size === 0) {
    return { modules, written, errors };
  }

  // 3. Connect to Postgres
  const client = createClient();
  try {
    await client.connect();
  } catch (err: any) {
    errors.push(
      Err.ConnectionError(
        `${err.message ?? String(err)}\nSet DATABASE_URL or PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD env vars.`,
        err
      )
    );
    return { modules, written, errors };
  }

  try {
    // 4. Introspect + generate each module
    for (const [outPath, parsed] of moduleQueries) {
      const result = await introspect(client, parsed);
      errors.push(...result.errors);

      if (result.queries.length === 0) continue;

      const mod = generate(outPath, result.queries, result.enums);
      modules.push(mod);

      // 5. Write if changed
      let existing = "";
      try {
        existing = await readFile(outPath, "utf8");
      } catch {
        // file doesn't exist yet
      }

      if (mod.source !== existing) {
        try {
          await mkdir(dirname(outPath), { recursive: true });
          await writeFile(outPath, mod.source);
          written.push(outPath);
        } catch (err) {
          errors.push(Err.WriteError(outPath, err));
        }
      }
    }
  } finally {
    await client.end();
  }

  return { modules, written, errors };
}

/**
 * Check mode: run the pipeline but don't write. Compare to existing files.
 */
export async function check(srcDir: string): Promise<{ ok: boolean; stale: string[]; errors: SqloveError[] }> {
  const discovered = await discover(srcDir);
  const errors: SqloveError[] = [];
  const stale: string[] = [];

  if (discovered.size === 0) return { ok: true, stale, errors };

  const moduleQueries = new Map<string, ParsedQuery[]>();
  for (const [outPath, files] of discovered) {
    const parsed: ParsedQuery[] = [];
    for (const file of files) {
      const nameError = validateQueryName(file.queryName);
      if (nameError) { errors.push(Err.InvalidQueryName(file.filePath, file.queryName, nameError)); continue; }
      try { parsed.push(parse(file)); } catch (err: any) { errors.push(Err.ParseError(file.filePath, err.message)); }
    }
    if (parsed.length > 0) moduleQueries.set(outPath, parsed);
  }

  if (moduleQueries.size === 0) return { ok: true, stale, errors };

  const client = createClient();
  try {
    await client.connect();
  } catch (err: any) {
    errors.push(Err.ConnectionError(err.message, err));
    return { ok: false, stale, errors };
  }

  try {
    for (const [outPath, parsed] of moduleQueries) {
      const result = await introspect(client, parsed);
      errors.push(...result.errors);
      if (result.queries.length === 0) continue;

      const mod = generate(outPath, result.queries, result.enums);
      let existing = "";
      try { existing = await readFile(outPath, "utf8"); } catch {}
      if (mod.source !== existing) stale.push(outPath);
    }
  } finally {
    await client.end();
  }

  return { ok: stale.length === 0, stale, errors };
}
