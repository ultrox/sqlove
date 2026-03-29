#!/usr/bin/env node
/*
 * CLI entry point. Thin shell over pipeline.
 *
 * sqlove           → run(), generate files
 * sqlove check     → check(), exit 1 if stale
 * sqlove --src X   → override source directory
 *
 * Parses argv manually. No framework,
 * we hate dependencies, my god we meaning me :).
 */

import { resolve } from "node:path";
import { run, check } from "./pipeline.js";
import { formatError } from "./errors.js";

const VERSION = "0.1.0";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const RESET = "\x1b[0m";

const HELP = `
🐿️ sqlove v${VERSION} — type-safe SQL in TypeScript, powered by Effect

Usage:
  sqlove [options]           Generate typed code from sql/ directories
  sqlove check               Verify generated files are up-to-date (CI)

Options:
  --src <dir>                Source directory (default: ./src)
  --help, -h                 Show help
  --version, -v              Show version

Conventions:
  • Place .sql files in any directory named "sql/" under your source dir
  • Each .sql file contains exactly one SQL query
  • The file name becomes the function name (snake_case → camelCase)
  • A sql.ts file is generated next to each sql/ directory
  • Leading -- comments become JSDoc on the function

Generated code uses Effect + @effect/sql + Schema.Class.

Connection:
  Set DATABASE_URL or PGHOST/PGPORT/PGUSER/PGDATABASE/PGPASSWORD.
`.trim();

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    process.exit(0);
  }
  if (args.includes("--version") || args.includes("-v")) {
    console.log(VERSION);
    process.exit(0);
  }

  let srcDir = "./src";
  const srcIdx = args.indexOf("--src");
  if (srcIdx !== -1 && args[srcIdx + 1]) {
    srcDir = args[srcIdx + 1]!;
  }
  const resolvedSrc = resolve(srcDir);

  // ── Check mode ──────────────────────────────────────────────
  if (args.includes("check")) {
    try {
      const { ok, stale, errors } = await check(resolvedSrc);
      for (const err of errors) console.error(formatError(err));
      if (ok) {
        console.log(`${GREEN}✓${RESET} All generated files are up-to-date.`);
        process.exit(0);
      } else {
        console.error(`${RED}✗${RESET} The following files are out of date:`);
        for (const f of stale) console.error(`  - ${f}`);
        console.error(`\nRun ${DIM}sqlove${RESET} to regenerate.`);
        process.exit(1);
      }
    } catch (err: any) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  }

  // ── Generate mode ───────────────────────────────────────────
  console.log(`🐿️ sqlove v${VERSION}\n`);

  try {
    const result = await run(resolvedSrc);

    if (result.modules.length === 0 && result.errors.length === 0) {
      console.log(`No sql/ directories found under ${srcDir}.`);
      process.exit(0);
    }

    // Print per-query results
    for (const mod of result.modules) {
      for (const q of mod.queries) {
        console.log(
          `  ${GREEN}✓${RESET} ${q.file.modulePath}/sql/${q.file.queryName}.sql`,
        );
      }
    }

    // Print errors
    for (const err of result.errors) {
      console.error(formatError(err));
    }

    // Summary
    const totalQueries = result.modules.reduce(
      (s, m) => s + m.queries.length,
      0,
    );
    const moduleCount = result.modules.length;
    console.log("");

    if (result.written.length > 0) {
      console.log(
        `Generated ${moduleCount} module(s) (${totalQueries} queries)` +
          (result.errors.length > 0
            ? ` with ${result.errors.length} error(s)`
            : "") +
          `.`,
      );
      for (const f of result.written) {
        console.log(`  → ${f}`);
      }
    } else if (totalQueries > 0) {
      console.log(
        `${totalQueries} queries up-to-date across ${moduleCount} module(s).`,
      );
    }

    if (result.errors.length > 0) process.exit(1);
  } catch (err: any) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
}

main();
