import { Effect } from "effect";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { introspect } from "../src/internals/introspector.js";
import { parse } from "../src/internals/parser.js";
import type { SqlFile } from "../src/internals/types.js";

const DATABASE_URL = "postgresql://sqlove:sqlove@localhost:5555/sqlove_test";
let client: pg.Client;

function file(name: string, content: string): SqlFile {
  return { filePath: `/sql/${name}.sql`, queryName: name, modulePath: "app", content };
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();

  // Ensure schema exists
  await client.query(`
    CREATE TABLE IF NOT EXISTS todo (
      id serial PRIMARY KEY,
      title text NOT NULL,
      description text,
      done boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now(),
      completed_at timestamptz
    );
    DO $$ BEGIN
      CREATE TYPE todo_priority AS ENUM ('low', 'medium', 'high', 'urgent');
    EXCEPTION WHEN duplicate_object THEN null;
    END $$;
    ALTER TABLE todo ADD COLUMN IF NOT EXISTS priority todo_priority NOT NULL DEFAULT 'medium';
  `);
});

afterAll(async () => {
  await client.end();
});

describe("introspect", () => {
  it("resolves parameter types from the query", async () => {
    const pq = parse(file("by_title", "SELECT id FROM todo WHERE title = $1"));
    const result = await Effect.runPromise(introspect(client, [pq]));

    expect(result.errors).toHaveLength(0);
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]!.params).toHaveLength(1);
    expect(result.queries[0]!.params[0]!.tsType.tsAnnotation).toBe("string"); // text
  });

  it("resolves return column types", async () => {
    const pq = parse(file("get_todo", "SELECT id, title, done, description FROM todo WHERE id = $1"));
    const result = await Effect.runPromise(introspect(client, [pq]));
    const cols = result.queries[0]!.columns;

    expect(cols).toHaveLength(4);

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName["id"]!.tsType.tsAnnotation).toBe("number");       // int4
    expect(byName["title"]!.tsType.tsAnnotation).toBe("string");    // text
    expect(byName["done"]!.tsType.tsAnnotation).toBe("boolean");    // bool
    expect(byName["description"]!.tsType.tsAnnotation).toBe("string"); // text
  });

  it("detects nullable columns", async () => {
    const pq = parse(file("nulls", "SELECT title, description FROM todo LIMIT 1"));
    const result = await Effect.runPromise(introspect(client, [pq]));
    const cols = result.queries[0]!.columns;

    const byName = Object.fromEntries(cols.map((c) => [c.name, c]));
    expect(byName["title"]!.nullable).toBe(false);        // NOT NULL
    expect(byName["description"]!.nullable).toBe(true);   // nullable
  });

  it("resolves enum types with variants", async () => {
    const pq = parse(file("priorities", "SELECT priority FROM todo LIMIT 1"));
    const result = await Effect.runPromise(introspect(client, [pq]));

    expect(result.enums).toHaveLength(1);
    expect(result.enums[0]!.pgName).toBe("todo_priority");
    expect(result.enums[0]!.variants).toEqual(["low", "medium", "high", "urgent"]);

    const prioCol = result.queries[0]!.columns.find((c) => c.name === "priority")!;
    expect(prioCol.tsType.enumDef).toBeDefined();
    expect(prioCol.tsType.enumDef!.name).toBe("TodoPriority");
  });

  it("marks queries without RETURNING as mutations", async () => {
    const pq = parse(file("del", "DELETE FROM todo WHERE id = $1"));
    const result = await Effect.runPromise(introspect(client, [pq]));

    expect(result.queries[0]!.isMutation).toBe(true);
    expect(result.queries[0]!.columns).toHaveLength(0);
  });

  it("marks queries with RETURNING as non-mutations", async () => {
    const pq = parse(file("ins", "INSERT INTO todo (title) VALUES ($1) RETURNING id"));
    const result = await Effect.runPromise(introspect(client, [pq]));

    expect(result.queries[0]!.isMutation).toBe(false);
    expect(result.queries[0]!.columns.length).toBeGreaterThan(0);
  });

  it("collects errors for bad SQL without crashing", async () => {
    const good = parse(file("good", "SELECT id FROM todo LIMIT 1"));
    const bad = parse(file("bad", "SELECT FROM WHERE"));
    const result = await Effect.runPromise(introspect(client, [good, bad]));

    // Good query still succeeds
    expect(result.queries).toHaveLength(1);
    expect(result.queries[0]!.file.queryName).toBe("good");

    // Bad query produces an error
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!._tag).toBe("IntrospectionError");
  });

  it("handles multiple params of different types", async () => {
    const pq = parse(file("multi", `
      SELECT id FROM todo
      WHERE title = $1 AND done = $2 AND priority = $3::todo_priority
    `));
    const result = await Effect.runPromise(introspect(client, [pq]));
    const params = result.queries[0]!.params;

    expect(params).toHaveLength(3);
    expect(params[0]!.tsType.tsAnnotation).toBe("string");        // text
    expect(params[1]!.tsType.tsAnnotation).toBe("boolean");       // bool
    expect(params[2]!.tsType.tsAnnotation).toBe("TodoPriority");  // enum
  });

  // Join nullability tests are in test/joins.test.ts
  // using fixture .sql files against real Postgres.

  it("resolves timestamp columns as Date", async () => {
    const pq = parse(file("ts", "SELECT created_at FROM todo LIMIT 1"));
    const result = await Effect.runPromise(introspect(client, [pq]));

    expect(result.queries[0]!.columns[0]!.tsType.tsAnnotation).toBe("Date");
    expect(result.queries[0]!.columns[0]!.tsType.schema).toBe("Schema.DateFromString");
  });
});
