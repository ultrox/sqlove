import { describe, it, expect, beforeAll } from "vitest";
import { join } from "node:path";
import pg from "pg";
import { readFileSync } from "node:fs";
import { Effect } from "effect";
import { run } from "../src/internals/_pipeline.js";

/**
 * Fixture-based snapshot test. Real .sql files, real Postgres.
 *
 * To add a new edge case:
 *   1. Add the table to test/fixtures/schema.sql (if needed)
 *   2. Add a .sql file to test/fixtures/sql/
 *   3. Run: npx vitest run test/fixtures.test.ts --update
 *   4. Review the snapshot diff
 *
 * That's it.
 */

const DATABASE_URL = "postgresql://sqlove:sqlove@localhost:5555/sqlove_test";
const FIXTURES = join(import.meta.dirname, "fixtures");

let generated: string;

beforeAll(async () => {
  // Apply schema
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const schema = readFileSync(join(FIXTURES, "schema.sql"), "utf8");
  await client.query(schema);
  await client.end();

  // Run pipeline against fixtures/sql/
  process.env["DATABASE_URL"] = DATABASE_URL;
  const result = await Effect.runPromise(run(FIXTURES));

  if (result.errors.length > 0) {
    for (const e of result.errors) console.error(e);
  }
  expect(result.errors).toHaveLength(0);
  expect(result.modules).toHaveLength(1);

  generated = readFileSync(join(FIXTURES, "sql.ts"), "utf8");
});

describe("fixtures", () => {
  it("generated output matches snapshot", () => {
    expect(generated).toMatchSnapshot();
  });

  // ── Invariants that must hold in every generated file ──
  // These catch a wrong snapshot from being accepted.

  it("has required imports", () => {
    expect(generated).toContain('import { Effect } from "effect"');
    expect(generated).toContain('import * as Schema from "effect/Schema"');
    expect(generated).toContain("@effect/sql/SqlError");
    expect(generated).toContain("@effect/sql/SqlClient");
  });

  it("every Schema.Class has a matching function or const", () => {
    const classes = [...generated.matchAll(/export class (\w+Row)/g)].map(m => m[1]!);
    expect(classes.length).toBeGreaterThan(0);
    for (const cls of classes) {
      // FooBarRow → fooBar (strip Row, lcfirst)
      const fn = cls.replace(/Row$/, "").replace(/^./, c => c.toLowerCase());
      expect(generated).toContain(`export const ${fn}`);
    }
  });

  it("no raw $N params leak into template literals", () => {
    // Template literals should have ${params.name}, never raw $1
    const templateBodies = [...generated.matchAll(/sql(?:<\w+>)?`([\s\S]*?)`/g)].map(m => m[1]!);
    for (const body of templateBodies) {
      expect(body).not.toMatch(/\$\d+/);
    }
  });

  it("no ? or ! suffixes leak into field names", () => {
    expect(generated).not.toMatch(/\w+[?!]:\s*Schema\./);
    expect(generated).not.toMatch(/readonly \w+[?!]:/);
  });

  it("mutations use Effect.asVoid, non-mutations don't", () => {
    const fns = [...generated.matchAll(/export const (\w+)[\s\S]*?(?=export const|\Z)/g)];
    for (const fn of fns) {
      const block = fn[0]!;
      const hasRow = block.includes("ReadonlyArray<");
      const hasVoid = block.includes("Effect.asVoid");
      // Can't have both — either returns rows or void
      expect(hasRow && hasVoid).toBe(false);
    }
  });

  it("NullOr only wraps inner schemas, never bare", () => {
    // Schema.NullOr must wrap something: Schema.NullOr(Schema.String)
    // Never just Schema.NullOr by itself
    const nullOrs = [...generated.matchAll(/Schema\.NullOr\(([^)]+)\)/g)].map(m => m[1]!);
    for (const inner of nullOrs) {
      expect(inner).toMatch(/^Schema\.\w+|^\w+$/); // Schema.X or EnumName
    }
  });

  it("override files: ? columns are nullable, ! columns are not", () => {
    // override_force_nullable has last_order_at — must be NullOr
    expect(generated).toMatch(/lastOrderAt.*NullOr/);
    // override_force_not_null has bio — must NOT be NullOr
    expect(generated).toMatch(/export class OverrideForceNotNullRow[\s\S]*?bio:\s*Schema\.String/);
  });
});
