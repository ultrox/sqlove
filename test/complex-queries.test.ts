import { describe, it, expect, beforeAll, afterAll } from "vitest";
import pg from "pg";
import { parse } from "../src/internals/parser.js";
import { introspect } from "../src/internals/introspector.js";
import type { SqlFile } from "../src/internals/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Correctness assertions for complex SQL fixtures.
 * The snapshot catches regressions. These tests verify
 * the output is actually right.
 */

const DATABASE_URL = "postgresql://sqlove:sqlove@localhost:5555/sqlove_test";
const SQL_DIR = join(import.meta.dirname, "fixtures/sql");
let client: pg.Client;

function loadFixture(name: string): SqlFile {
  const filePath = join(SQL_DIR, `${name}.sql`);
  const content = readFileSync(filePath, "utf8");
  return { filePath, queryName: name, modulePath: "", content };
}

async function describe_(name: string) {
  const pq = parse(loadFixture(name));
  const result = await introspect(client, [pq]);
  expect(result.errors).toHaveLength(0);
  const q = result.queries[0]!;
  const cols = Object.fromEntries(q.columns.map((c) => [c.name, c]));
  const params = Object.fromEntries(q.params.map((p) => [p.name, p]));
  return { cols, params, query: q, enums: result.enums };
}

beforeAll(async () => {
  client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  const schema = readFileSync(join(import.meta.dirname, "fixtures/schema.sql"), "utf8");
  await client.query(schema);
});

afterAll(async () => {
  await client.end();
});

describe("complex queries — correctness", () => {
  // ── order_details ──────────────────────────────────────

  describe("order_details", () => {
    it("payment columns are nullable (LEFT JOIN)", async () => {
      const { cols } = await describe_("order_details");
      expect(cols["payment_method"]!.nullable).toBe(true);
      expect(cols["paid_at"]!.nullable).toBe(true);
    });

    it("inner join columns are not nullable", async () => {
      const { cols } = await describe_("order_details");
      expect(cols["customer"]!.nullable).toBe(false);
      expect(cols["product"]!.nullable).toBe(false);
      expect(cols["quantity"]!.nullable).toBe(false);
    });

    it("computed column has correct type", async () => {
      const { cols } = await describe_("order_details");
      expect(cols["line_total"]!.tsType.tsAnnotation).toBe("string"); // numeric → string
    });

    it("enum column resolves", async () => {
      const { cols } = await describe_("order_details");
      expect(cols["status"]!.tsType.enumDef).toBeDefined();
      expect(cols["status"]!.tsType.enumDef!.name).toBe("OrderStatus");
    });

    it("param inferred as id", async () => {
      const { params } = await describe_("order_details");
      expect(params["id"]).toBeDefined();
      expect(params["id"]!.tsType.tsAnnotation).toBe("number");
    });
  });

  // ── product_stats ──────────────────────────────────────

  describe("product_stats", () => {
    it("aggregates are not nullable (coalesce)", async () => {
      const { cols } = await describe_("product_stats");
      expect(cols["avg_rating"]!.nullable).toBe(false);
      expect(cols["total_sold"]!.nullable).toBe(false);
      expect(cols["revenue"]!.nullable).toBe(false);
      expect(cols["review_count"]!.nullable).toBe(false);
    });

    it("base table columns are not nullable", async () => {
      const { cols } = await describe_("product_stats");
      expect(cols["name"]!.nullable).toBe(false);
      expect(cols["sku"]!.nullable).toBe(false);
    });

    it("no params", async () => {
      const { query } = await describe_("product_stats");
      expect(query.params).toHaveLength(0);
      expect(query.isMutation).toBe(false);
    });
  });

  // ── user_dashboard ─────────────────────────────────────

  describe("user_dashboard", () => {
    it("user columns are not nullable", async () => {
      const { cols } = await describe_("user_dashboard");
      expect(cols["name"]!.nullable).toBe(false);
      expect(cols["email"]!.nullable).toBe(false);
      expect(cols["role"]!.tsType.enumDef).toBeDefined();
    });

    // KNOWN LIMITATION: max() on LEFT JOIN returns tableOID=0
    // (expression column). We can't detect its nullability from
    // pg_attribute. max() CAN return null when no rows match.
    // Fixing this requires understanding aggregate semantics.
    it.todo("aggregates on LEFT JOIN are nullable (max can return null)");

    it("array column resolves", async () => {
      const { cols } = await describe_("user_dashboard");
      expect(cols["tags"]!.tsType.isArray).toBe(true);
      expect(cols["tags"]!.tsType.schema).toContain("Schema.Array");
    });
  });

  // ── category_tree ──────────────────────────────────────

  describe("category_tree (recursive CTE)", () => {
    // KNOWN LIMITATION: CTE columns have tableOID=0.
    // parent_id IS nullable in the base table but the CTE
    // output loses that information.
    it.todo("parent_id is nullable (top-level categories have no parent)");

    it("product_count from LEFT JOIN aggregate is not nullable (coalesce)", async () => {
      const { cols } = await describe_("category_tree");
      expect(cols["product_count"]!.nullable).toBe(false);
    });

    it("no params — const query", async () => {
      const { query } = await describe_("category_tree");
      expect(query.params).toHaveLength(0);
    });
  });

  // ── cte_ranked ─────────────────────────────────────────

  describe("cte_ranked (CTE + window function)", () => {
    it("rank column is not nullable", async () => {
      const { cols } = await describe_("cte_ranked");
      expect(cols["rank"]!.nullable).toBe(false);
      expect(cols["rank"]!.tsType.tsAnnotation).toBe("number");
    });

    it("total_spent from CTE is not nullable", async () => {
      const { cols } = await describe_("cte_ranked");
      expect(cols["total_spent"]!.nullable).toBe(false);
    });
  });

  // ── lateral_recent_orders ──────────────────────────────

  describe("lateral_recent_orders", () => {
    it("LATERAL columns are nullable (LEFT JOIN)", async () => {
      const { cols } = await describe_("lateral_recent_orders");
      expect(cols["order_id"]!.nullable).toBe(true);
      expect(cols["total"]!.nullable).toBe(true);
      expect(cols["status"]!.nullable).toBe(true);
    });

    it("user name is not nullable", async () => {
      const { cols } = await describe_("lateral_recent_orders");
      expect(cols["name"]!.nullable).toBe(false);
    });
  });

  // ── multi_enum ─────────────────────────────────────────

  describe("multi_enum", () => {
    it("both enum types resolved", async () => {
      const { enums } = await describe_("multi_enum");
      const names = enums.map((e) => e.name).sort();
      expect(names).toContain("UserRole");
      expect(names).toContain("OrderStatus");
    });

    it("params have correct enum types", async () => {
      const { params } = await describe_("multi_enum");
      expect(params["role"]!.tsType.tsAnnotation).toBe("UserRole");
      expect(params["status"]!.tsType.tsAnnotation).toBe("OrderStatus");
    });
  });

  // ── jsonb_query ────────────────────────────────────────

  describe("jsonb_query", () => {
    // KNOWN LIMITATION: ->> extracts text from jsonb.
    // tableOID=0 (expression). The key might not exist → null.
    // Fixing this requires understanding jsonb operator semantics.
    it.todo("jsonb-extracted text columns are nullable");

    it("cast from jsonb produces correct type", async () => {
      const { cols } = await describe_("jsonb_query");
      expect(cols["salary"]!.tsType.tsAnnotation).toBe("string"); // numeric → string
    });

    it("param is jsonb", async () => {
      const { params } = await describe_("jsonb_query");
      expect(params["arg1"]!.tsType.tsAnnotation).toBe("unknown"); // jsonb
    });
  });

  // ── window_running_total ───────────────────────────────

  describe("window_running_total", () => {
    it("window function result is not nullable", async () => {
      const { cols } = await describe_("window_running_total");
      expect(cols["running_total"]!.nullable).toBe(false);
    });

    it("base columns from inner join are not nullable", async () => {
      const { cols } = await describe_("window_running_total");
      expect(cols["name"]!.nullable).toBe(false);
      expect(cols["total"]!.nullable).toBe(false);
    });
  });

  // ── upsert_review ─────────────────────────────────────

  describe("upsert_review", () => {
    it("is not a void mutation (has RETURNING)", async () => {
      const { query } = await describe_("upsert_review");
      expect(query.isMutation).toBe(false);
      expect(query.columns.length).toBeGreaterThan(0);
    });

    it("params inferred from INSERT columns", async () => {
      const { params } = await describe_("upsert_review");
      expect(params["user_id"]).toBeDefined();
      expect(params["product_id"]).toBeDefined();
      expect(params["rating"]).toBeDefined();
      expect(params["body"]).toBeDefined();
    });

    it("nullable INSERT param for nullable column", async () => {
      const { params } = await describe_("upsert_review");
      // body is nullable in the table
      expect(params["body"]!.nullable).toBe(true);
      // rating is NOT NULL
      expect(params["rating"]!.nullable).toBe(false);
    });
  });

  // ── refund_report ──────────────────────────────────────

  describe("refund_report", () => {
    it("all inner join columns are not nullable", async () => {
      const { cols } = await describe_("refund_report");
      expect(cols["refund_id"]!.nullable).toBe(false);
      expect(cols["refund_amount"]!.nullable).toBe(false);
      expect(cols["order_id"]!.nullable).toBe(false);
      expect(cols["customer"]!.nullable).toBe(false);
      expect(cols["payment_method"]!.nullable).toBe(false);
    });

    it("reason is nullable (column allows null)", async () => {
      const { cols } = await describe_("refund_report");
      expect(cols["reason"]!.nullable).toBe(true);
    });

    it("date range params inferred from qualified column name", async () => {
      const { params } = await describe_("refund_report");
      // r.refunded_at >= $1 → "refunded_at" (strips table prefix)
      expect(params["refunded_at"]!.tsType.tsAnnotation).toBe("Date");
    });
  });

  // ── search_products ────────────────────────────────────

  describe("search_products", () => {
    it("LEFT JOIN category is nullable", async () => {
      const { cols } = await describe_("search_products");
      expect(cols["category"]!.nullable).toBe(true);
    });

    it("ILIKE param inferred as name", async () => {
      const { params } = await describe_("search_products");
      expect(params["name"]).toBeDefined();
      expect(params["name"]!.tsType.tsAnnotation).toBe("string");
    });
  });
});
