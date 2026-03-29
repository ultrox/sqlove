import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { parse } from "../src/internals/parser.js";
import { introspect } from "../src/internals/introspector.js";
import type { SqlFile } from "../src/internals/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Join nullability edge cases.
 * Each test uses a real .sql fixture file and real Postgres.
 *
 * To add a case: drop a .sql file in test/fixtures/sql/,
 * add a test here.
 */

const DATABASE_URL = "postgresql://sqlove:sqlove@localhost:5555/sqlove_test";
const SQL_DIR = join(import.meta.dirname, "fixtures/sql");
let client: pg.Client;

function loadFixture(name: string): SqlFile {
  const filePath = join(SQL_DIR, `${name}.sql`);
  const content = readFileSync(filePath, "utf8");
  return { filePath, queryName: name, modulePath: "", content };
}

async function describeColumns(name: string) {
  const pq = parse(loadFixture(name));
  const result = await introspect(client, [pq]);
  expect(result.errors).toHaveLength(0);
  const cols = result.queries[0]!.columns;
  return Object.fromEntries(cols.map((c) => [c.name, c]));
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
});

afterAll(async () => {
  await client.end();
});

describe("join nullability edge cases", () => {
  it("schema-qualified: LEFT JOIN public.orders → total is nullable", async () => {
    const cols = await describeColumns("join_schema_qualified");
    expect(cols["name"]!.nullable).toBe(false);
    expect(cols["total"]!.nullable).toBe(true);
  });

  it("subquery: LEFT JOIN (...) → subquery columns are nullable", async () => {
    const cols = await describeColumns("join_subquery");
    expect(cols["name"]!.nullable).toBe(false);
    expect(cols["total"]!.nullable).toBe(true);
  });

  it("multi mixed: only LEFT JOIN side is nullable", async () => {
    const cols = await describeColumns("join_multi_mixed");
    expect(cols["name"]!.nullable).toBe(false);  // users — FROM, INNER JOIN side
    expect(cols["total"]!.nullable).toBe(false);  // orders — INNER JOIN
    // tags.name would be nullable if selected (LEFT JOIN side)
  });

  it("CTE: LEFT JOIN after CTE → right side nullable", async () => {
    const cols = await describeColumns("join_cte");
    expect(cols["name"]!.nullable).toBe(false);
    expect(cols["total"]!.nullable).toBe(true);
  });

  it("comment trick: JOIN in comment doesn't affect nullability", async () => {
    const cols = await describeColumns("join_comment_trick");
    // INNER JOIN — neither side nullable despite LEFT JOIN in comment
    expect(cols["name"]!.nullable).toBe(false);
    expect(cols["total"]!.nullable).toBe(false);
  });

  it("LATERAL: right side is nullable", async () => {
    const cols = await describeColumns("join_lateral");
    expect(cols["name"]!.nullable).toBe(false);
    expect(cols["total"]!.nullable).toBe(true);
  });

  it("chain: all LEFT JOIN right sides are nullable", async () => {
    const cols = await describeColumns("join_chain");
    expect(cols["name"]!.nullable).toBe(false);    // users — FROM
    expect(cols["total"]!.nullable).toBe(true);     // orders — LEFT JOIN
    expect(cols["quantity"]!.nullable).toBe(true);  // line_items — LEFT JOIN
    expect(cols["sku"]!.nullable).toBe(true);       // products — LEFT JOIN
  });

  it("UNION subquery: LEFT JOIN side is nullable", async () => {
    const cols = await describeColumns("join_union_subquery");
    expect(cols["name"]!.nullable).toBe(false);
    expect(cols["amount"]!.nullable).toBe(true);
  });

  it("same table twice: only the LEFT JOIN alias is nullable", async () => {
    const cols = await describeColumns("join_same_table_twice");
    expect(cols["name"]!.nullable).toBe(false);          // u.name — FROM
    expect(cols["manager_name"]!.nullable).toBe(true);   // manager.name — LEFT JOIN
    expect(cols["total"]!.nullable).toBe(false);          // o.total — INNER JOIN
  });

  it("nested parens: both tables inside LEFT JOIN are nullable", async () => {
    const cols = await describeColumns("join_nested_parens");
    expect(cols["name"]!.nullable).toBe(false);    // users — FROM
    expect(cols["total"]!.nullable).toBe(true);     // orders — inside LEFT JOIN parens
  });

  it("LEFT JOIN with WHERE param: plan collapses but nullability still works", async () => {
    const cols = await describeColumns("left_join_with_param");
    expect(cols["name"]!.nullable).toBe(false);   // users — left side
    expect(cols["total"]!.nullable).toBe(true);    // orders — RIGHT side of LEFT JOIN, NOT NULL in table
  });

  it("EXISTS subquery: inner LEFT JOIN does not affect outer columns", async () => {
    const cols = await describeColumns("join_exists_subquery");
    expect(cols["name"]!.nullable).toBe(false);  // users.name — NOT NULL, no outer join
  });
});
