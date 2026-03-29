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
});
