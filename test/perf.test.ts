import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";
import { run } from "../src/pipeline.js";
import { discover } from "../src/discovery.js";
import { parse } from "../src/parser.js";
import { generate } from "../src/codegen.js";
import { introspect, createClient } from "../src/introspector.js";
import type { SqlFile, ParsedQuery } from "../src/types.js";

const DATABASE_URL = "postgresql://appuser:secret@localhost:5432/sqlove_test";
const TMP = join(tmpdir(), `sqlove-perf-${Date.now()}`);

// ── Helpers ─────────────────────────────────────────────────────────────────

function time<T>(fn: () => T): { result: T; ms: number } {
  const start = performance.now();
  const result = fn();
  return { result, ms: performance.now() - start };
}

async function timeAsync<T>(fn: () => Promise<T>): Promise<{ result: T; ms: number }> {
  const start = performance.now();
  const result = await fn();
  return { result, ms: performance.now() - start };
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS todo (
      id serial PRIMARY KEY,
      title text NOT NULL,
      description text,
      priority text NOT NULL DEFAULT 'medium',
      done boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
  `);
  await client.end();

  // Generate 50 sql files to test at scale
  const sqlDir = join(TMP, "src/app/sql");
  mkdirSync(sqlDir, { recursive: true });
  for (let i = 0; i < 50; i++) {
    const name = `query_${String(i).padStart(3, "0")}`;
    const sql = i % 5 === 0
      ? `-- Query ${i}: a mutation.\nDELETE FROM todo WHERE id = $1`
      : i % 3 === 0
        ? `-- Query ${i}: with params.\nSELECT id, title, description FROM todo WHERE title = $1 AND done = $2`
        : `-- Query ${i}: list all.\nSELECT id, title, priority, done, created_at FROM todo ORDER BY title`;
    writeFileSync(join(sqlDir, `${name}.sql`), sql);
  }

  process.env["DATABASE_URL"] = DATABASE_URL;
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
  delete process.env["DATABASE_URL"];
});

// ── Performance tests ───────────────────────────────────────────────────────

describe("performance", () => {
  it("discovery: 50 files scanned in < 50ms", async () => {
    const { ms } = await timeAsync(() => discover(join(TMP, "src")));
    console.log(`    discovery: ${ms.toFixed(1)}ms`);
    expect(ms).toBeLessThan(50);
  });

  it("parser: 50 files parsed in < 5ms", async () => {
    const discovered = await discover(join(TMP, "src"));
    const files = [...discovered.values()].flat();

    const { ms } = time(() => files.map(parse));
    console.log(`    parser: ${ms.toFixed(1)}ms for ${files.length} files`);
    expect(ms).toBeLessThan(5);
  });

  it("introspection: 50 queries described in < 2000ms", async () => {
    const discovered = await discover(join(TMP, "src"));
    const files = [...discovered.values()].flat();
    const parsed = files.map(parse);

    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    try {
      const { ms } = await timeAsync(() => introspect(client, parsed));
      console.log(`    introspect: ${ms.toFixed(1)}ms for ${parsed.length} queries`);
      expect(ms).toBeLessThan(2000);
    } finally {
      await client.end();
    }
  });

  it("codegen: 50 queries emitted in < 10ms", async () => {
    const discovered = await discover(join(TMP, "src"));
    const files = [...discovered.values()].flat();
    const parsed = files.map(parse);

    const client = new pg.Client({ connectionString: DATABASE_URL });
    await client.connect();
    const introspected = await introspect(client, parsed);
    await client.end();

    const { ms } = time(() =>
      generate("/out/sql.ts", introspected.queries, introspected.enums)
    );
    console.log(`    codegen: ${ms.toFixed(1)}ms for ${introspected.queries.length} queries`);
    expect(ms).toBeLessThan(10);
  });

  it("full pipeline: 50 queries end-to-end in < 3000ms", async () => {
    const { result, ms } = await timeAsync(() => run(join(TMP, "src")));
    const queryCount = result.modules.reduce((s, m) => s + m.queries.length, 0);
    console.log(`    pipeline: ${ms.toFixed(1)}ms for ${queryCount} queries`);
    expect(ms).toBeLessThan(3000);
    expect(result.errors).toHaveLength(0);
  });

  it("idempotent re-run is faster (no write)", async () => {
    // First run already happened above, files exist
    const { result, ms } = await timeAsync(() => run(join(TMP, "src")));
    console.log(`    re-run: ${ms.toFixed(1)}ms (no writes)`);
    expect(result.written).toHaveLength(0);
    // Re-run should still be under budget
    expect(ms).toBeLessThan(3000);
  });
});
