/*
 * Orchestrator. Wires all phases together:
 *
 *   discover → parse → introspect → codegen → write
 *
 * Errors accumulate — one bad query doesn't kill the rest.
 * Only writes when content actually changed (diff check).
 *
 * Two modes:
 *   run()   — generate files, return what was written
 *   check() — compare generated vs existing, return stale
 */

import { Effect } from "effect";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { discover } from "./discovery.js";
import { parse, validateQueryName } from "./parser.js";
import { createClient, introspect } from "./introspector.js";
import { generate } from "./codegen.js";
import type { SqlFile, ParsedQuery, GeneratedModule } from "./types.js";
import type { SqloveError, WriteErr } from "./errors.js";
import * as Err from "./errors.js";
import { Client } from "pg";

// ── Public API ───────────────────────────────────────────

export type PipelineResult = {
  modules: GeneratedModule[];
  written: string[];
  errors: SqloveError[];
};
/**
 * generates type safe sql.ts files from .sql files
 */
export const run = (
  srcDir: string,
): Effect.Effect<PipelineResult, SqloveError> =>
  Effect.gen(function* () {
    const { modules, errors } = yield* buildModules(srcDir);

    const results = yield* Effect.forEach(modules, writeIfChanged);
    const written = results.filter((p): p is string => p !== null);

    return { modules, written, errors };
  });

export const check = (srcDir: string) =>
  Effect.gen(function* () {
    const { modules, errors } = yield* buildModules(srcDir);

    const stale: string[] = [];
    for (const mod of modules) {
      const existing = yield* readExisting(mod.outputPath);
      if (mod.source !== existing) {
        stale.push(mod.outputPath);
      }
    }

    return { ok: stale.length === 0, stale, errors };
  });

// ── Shared pipeline ──────────────────────────────────────

/** Discover → parse → introspect → generate. No filesystem writes. */
type BuildModuleReturn = {
  modules: GeneratedModule[];
  errors: SqloveError[];
};

const buildModules = (
  srcDir: string,
): Effect.Effect<BuildModuleReturn, SqloveError, never> =>
  Effect.gen(function* () {
    const discovered = yield* Effect.tryPromise({
      try: () => discover(srcDir),
      catch: (cause) => Err.FileReadError(srcDir, cause),
    });

    if (discovered.size === 0) {
      return {
        modules: [],
        errors: [],
      };
    }

    // Parse phase — collect errors, keep going
    const parseResults = [...discovered.entries()].map(([outPath, files]) =>
      parseModule(outPath, files),
    );

    const parseErrors = parseResults.flatMap((r) => r.errors);
    const validModules = parseResults.filter((r) => r.queries.length > 0);

    if (validModules.length === 0)
      return {
        modules: [],
        errors: parseErrors,
      };

    // Introspect postgres + generate — scoped client
    const { generated, errors: introErrors } = yield* withPgClient((client) =>
      Effect.gen(function* () {
        const results: GeneratedModule[] = [];
        const errors: SqloveError[] = [];

        for (const { outPath, queries } of validModules) {
          const result = yield* Effect.tryPromise({
            try: () => introspect(client, queries),
            catch: (e: any) =>
              Err.IntrospectionError(
                queries[0]?.file.queryName ?? "unknown",
                outPath,
                e.message ?? String(e),
                e.detail,
              ),
          });

          errors.push(...result.errors);
          if (result.queries.length === 0) {
            continue;
          }

          results.push(generate(outPath, result.queries, result.enums));
        }

        return { generated: results, errors };
      }),
    );

    return {
      modules: generated,
      errors: [...parseErrors, ...introErrors],
    };
  });

// ── Phases ───────────────────────────────────────────────

interface ParseResult {
  outPath: string;
  queries: ParsedQuery[];
  errors: Err.SqloveError[];
}

const parseModule = (outPath: string, files: SqlFile[]): ParseResult => {
  const queries: ParsedQuery[] = [];
  const errors: Err.SqloveError[] = [];

  for (const file of files) {
    const nameErr = validateQueryName(file.queryName);
    if (nameErr) {
      errors.push(Err.InvalidQueryName(file.filePath, file.queryName, nameErr));
      continue;
    }
    try {
      queries.push(parse(file));
    } catch (e: any) {
      errors.push(Err.ParseError(file.filePath, e.message ?? String(e)));
    }
  }

  return { outPath, queries, errors };
};

const withPgClient = <A>(
  use: (client: Client) => Effect.Effect<A, SqloveError>,
): Effect.Effect<A, SqloveError> =>
  Effect.acquireUseRelease(
    Effect.tryPromise({
      try: () => {
        const client = createClient();
        return client.connect().then(() => client);
      },
      catch: (cause: any) =>
        Err.ConnectionError(cause.message ?? String(cause), cause),
    }),
    use,
    (client) => Effect.promise(() => client.end()),
  );

// ── Write helpers ────────────────────────────────────────

/** Compares generated source against what's on disk.
 * If identical: skip(null).
 * If different: writes the file and returns the path it wrote to.
 * If fail: WriteError
 */
const writeIfChanged = (
  mod: GeneratedModule,
): Effect.Effect<string | null, WriteErr, never> => {
  return Effect.gen(function* () {
    const existing = yield* readExisting(mod.outputPath);
    if (existing !== null && mod.source === existing) {
      return null;
    }

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(mod.outputPath), { recursive: true });
        await writeFile(mod.outputPath, mod.source);
      },
      catch: (cause) => Err.WriteError(mod.outputPath, cause),
    });

    return mod.outputPath;
  });
};

const readExisting = (
  path: string,
): Effect.Effect<string | null, never, never> =>
  Effect.tryPromise({
    try: () => readFile(path, "utf8"),
    catch: () => null,
  }).pipe(Effect.catchAll(() => Effect.succeed(null)));
