import { describe, it, expect } from "vitest";
import { generate } from "../src/internals/codegen.js";
import type { TypedQuery, EnumDef } from "../src/internals/types.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

const STR = { schema: "Schema.String", tsAnnotation: "string", isArray: false } as const;
const NUM = { schema: "Schema.Number", tsAnnotation: "number", isArray: false } as const;
const BOOL = { schema: "Schema.Boolean", tsAnnotation: "boolean", isArray: false } as const;
const DATE = { schema: "Schema.DateFromString", tsAnnotation: "Date", isArray: false } as const;

function query(overrides: Partial<TypedQuery> & { name: string }): TypedQuery {
  return {
    file: {
      filePath: `/src/app/sql/${overrides.name}.sql`,
      queryName: overrides.name,
      modulePath: "app",
      content: overrides.sql ?? "SELECT 1",
    },
    docComment: overrides.docComment ?? null,
    sql: overrides.sql ?? "SELECT 1",
    params: overrides.params ?? [],
    columns: overrides.columns ?? [],
    isMutation: overrides.isMutation ?? false,
  };
}

function gen(queries: TypedQuery[], enums: EnumDef[] = []) {
  return generate("/out/sql.ts", queries, enums).source;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("codegen", () => {
  describe("imports", () => {
    it("always includes Effect, Schema, SqlError, SqlClient imports", () => {
      const src = gen([query({ name: "noop", sql: "SELECT 1", columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }] })]);
      expect(src).toContain(`import { Effect } from "effect"`);
      expect(src).toContain(`import * as Schema from "effect/Schema"`);
      expect(src).toContain(`import type { SqlError } from "@effect/sql/SqlError"`);
      expect(src).toContain(`import { SqlClient } from "@effect/sql/SqlClient"`);
    });
  });

  describe("naming", () => {
    it("converts snake_case file name to camelCase function", () => {
      const src = gen([query({
        name: "find_user_by_email",
        sql: "SELECT id FROM users WHERE email = $1",
        params: [{ index: 1, name: "email", oid: 25, tsType: STR }],
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("export const findUserByEmail");
    });

    it("generates PascalCase + Row for row class name", () => {
      const src = gen([query({
        name: "list_all_posts",
        sql: "SELECT id FROM posts",
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("class ListAllPostsRow");
    });
  });

  describe("no-param queries are const, param queries are functions", () => {
    it("no params → const declaration", () => {
      const src = gen([query({
        name: "list_users",
        sql: "SELECT id FROM users",
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toMatch(/export const listUsers:\s*Effect/);
    });

    it("with params → function with params object using inferred names", () => {
      const src = gen([query({
        name: "find_user",
        sql: "SELECT id FROM users WHERE email = $1",
        params: [{ index: 1, name: "email", oid: 25, tsType: STR }],
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("export const findUser = (");
      expect(src).toContain("params: {");
      expect(src).toContain("readonly email: string");
    });
  });

  describe("mutations", () => {
    it("mutation without RETURNING returns void", () => {
      const src = gen([query({
        name: "delete_user",
        sql: "DELETE FROM users WHERE id = $1",
        params: [{ index: 1, name: "id", oid: 23, tsType: NUM }],
        isMutation: true,
      })]);
      expect(src).toContain("Effect.Effect<void, SqlError, SqlClient>");
      expect(src).toContain("Effect.asVoid");
    });

    it("no-param mutation is a const void", () => {
      const src = gen([query({
        name: "clear_all",
        sql: "DELETE FROM todos",
        isMutation: true,
      })]);
      expect(src).toMatch(/export const clearAll:\s*Effect\.Effect<void/);
      expect(src).toContain("Effect.asVoid");
      expect(src).not.toContain("params");
    });

    it("mutation with RETURNING returns rows (not void)", () => {
      const src = gen([query({
        name: "create_user",
        sql: "INSERT INTO users (name) VALUES ($1) RETURNING id",
        params: [{ index: 1, name: "name", oid: 25, tsType: STR }],
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
        isMutation: false,
      })]);
      expect(src).toContain("ReadonlyArray<CreateUserRow>");
      expect(src).not.toContain("Effect.asVoid");
    });
  });

  describe("$N → ${params.name} substitution", () => {
    it("replaces $1 with ${params.name} in template", () => {
      const src = gen([query({
        name: "by_id",
        sql: "SELECT id FROM t WHERE id = $1",
        params: [{ index: 1, name: "id", oid: 23, tsType: NUM }],
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("${params.id}");
      expect(src).not.toMatch(/\$1(?!\d)/);
    });

    it("handles multiple params with different names", () => {
      const src = gen([query({
        name: "q",
        sql: "SELECT 1 FROM t WHERE a = $1 AND b = $2 AND c = $3",
        params: [
          { index: 1, name: "a", oid: 23, tsType: NUM },
          { index: 2, name: "b", oid: 25, tsType: STR },
          { index: 3, name: "c", oid: 16, tsType: BOOL },
        ],
        columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("${params.a}");
      expect(src).toContain("${params.b}");
      expect(src).toContain("${params.c}");
    });

    it("does not mangle $10 when replacing $1", () => {
      const params = Array.from({ length: 10 }, (_, i) => ({
        index: i + 1,
        name: `p${i + 1}`,
        oid: 23,
        tsType: NUM,
      }));
      const placeholders = params.map((p) => `$${p.index}`).join(", ");
      const src = gen([query({
        name: "many",
        sql: `SELECT 1 FROM t WHERE x IN (${placeholders})`,
        params,
        columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("${params.p10}");
      expect(src).not.toMatch(/\$\{params\.p1\}0/);
    });
  });

  describe("nullable columns", () => {
    it("wraps nullable column schema with Schema.NullOr", () => {
      const src = gen([query({
        name: "q",
        sql: "SELECT bio FROM users",
        columns: [{ name: "bio", oid: 25, tsType: STR, nullable: true }],
      })]);
      expect(src).toContain("Schema.NullOr(Schema.String)");
    });

    it("non-nullable columns use schema directly", () => {
      const src = gen([query({
        name: "q",
        sql: "SELECT name FROM users",
        columns: [{ name: "name", oid: 25, tsType: STR, nullable: false }],
      })]);
      expect(src).toMatch(/name:\s*Schema\.String/);
      expect(src).not.toContain("NullOr");
    });
  });

  describe("enums", () => {
    it("generates Schema.Literal for enum types", () => {
      const enumDef: EnumDef = {
        name: "UserStatus",
        pgName: "user_status",
        variants: ["active", "inactive", "banned"],
      };
      const src = gen(
        [query({
          name: "q",
          sql: "SELECT status FROM users",
          columns: [{
            name: "status",
            oid: 99999,
            tsType: { schema: "UserStatus", tsAnnotation: "UserStatus", isArray: false, enumDef },
            nullable: false,
          }],
        })],
        [enumDef]
      );
      expect(src).toContain(`Schema.Literal("active", "inactive", "banned")`);
      expect(src).toContain(`export const UserStatus`);
      expect(src).toContain(`export type UserStatus = typeof UserStatus.Type`);
    });
  });

  describe("determinism", () => {
    it("queries appear sorted alphabetically by name", () => {
      const src = gen([
        query({ name: "zebra", sql: "SELECT 1", columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }] }),
        query({ name: "alpha", sql: "SELECT 1", columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }] }),
        query({ name: "middle", sql: "SELECT 1", columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }] }),
      ]);
      const alphaPos = src.indexOf("export const alpha");
      const middlePos = src.indexOf("export const middle");
      const zebraPos = src.indexOf("export const zebra");
      expect(alphaPos).toBeLessThan(middlePos);
      expect(middlePos).toBeLessThan(zebraPos);
    });

    it("same input always produces same output", () => {
      const queries = [
        query({ name: "b", sql: "SELECT 1", columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }] }),
        query({ name: "a", sql: "SELECT 1", columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }] }),
      ];
      expect(gen(queries)).toBe(gen(queries));
    });
  });

  describe("doc comments → JSDoc", () => {
    it("includes SQL comment as JSDoc", () => {
      const src = gen([query({
        name: "q",
        sql: "SELECT 1",
        docComment: "Find a user by email.\nReturns one row.",
        columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("* Find a user by email.");
      expect(src).toContain("* Returns one row.");
    });

    it("includes @see with file path", () => {
      const src = gen([query({
        name: "find_user",
        sql: "SELECT 1",
        columns: [{ name: "x", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("@see `app/sql/find_user.sql`");
    });
  });

  describe("param names are camelCase", () => {
    it("converts snake_case param names to camelCase", () => {
      const src = gen([query({
        name: "create_thing",
        sql: "INSERT INTO t (share_with, created_by) VALUES ($1, $2) RETURNING id",
        params: [
          { index: 1, name: "share_with", oid: 25, tsType: STR, nullable: false },
          { index: 2, name: "created_by", oid: 25, tsType: STR, nullable: false },
        ],
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("readonly shareWith: string");
      expect(src).toContain("readonly createdBy: string");
      // SQL column names stay snake_case, only param keys are camelCase
      expect(src).not.toContain("readonly share_with");
      expect(src).not.toContain("readonly created_by");
    });

    it("uses camelCase param names in SQL template interpolation", () => {
      const src = gen([query({
        name: "update_thing",
        sql: "UPDATE t SET share_with = $1 WHERE id = $2",
        params: [
          { index: 1, name: "share_with", oid: 25, tsType: STR, nullable: false },
          { index: 2, name: "id", oid: 23, tsType: NUM, nullable: false },
        ],
        isMutation: true,
      })]);
      expect(src).toContain("${params.shareWith}");
      expect(src).toContain("${params.id}");
    });

    it("single-word params stay unchanged", () => {
      const src = gen([query({
        name: "by_id",
        sql: "SELECT id FROM t WHERE id = $1",
        params: [{ index: 1, name: "id", oid: 23, tsType: NUM, nullable: false }],
        columns: [{ name: "id", oid: 23, tsType: NUM, nullable: false }],
      })]);
      expect(src).toContain("readonly id: number");
    });
  });

  describe("row class shape", () => {
    it("generates Schema.Class with correct field schemas", () => {
      const src = gen([query({
        name: "get_user",
        sql: "SELECT id, name, active, created_at FROM users",
        columns: [
          { name: "id", oid: 23, tsType: NUM, nullable: false },
          { name: "name", oid: 25, tsType: STR, nullable: false },
          { name: "active", oid: 16, tsType: BOOL, nullable: false },
          { name: "created_at", oid: 1184, tsType: DATE, nullable: false },
        ],
      })]);
      expect(src).toContain(`extends Schema.Class<GetUserRow>("GetUserRow")`);
      expect(src).toContain("id: Schema.Number");
      expect(src).toContain("name: Schema.String");
      expect(src).toContain("active: Schema.Boolean");
      expect(src).toContain(`createdAt: Schema.propertySignature(Schema.DateFromString).pipe(Schema.fromKey("created_at"))`);
    });
  });
});
