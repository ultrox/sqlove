import { describe, it, expect } from "vitest";
import { parse, validateQueryName } from "../src/internals/parser.js";
import type { SqlFile } from "../src/internals/types.js";

function file(content: string, name = "test_query"): SqlFile {
  return { filePath: `/src/sql/${name}.sql`, queryName: name, modulePath: "app", content };
}

describe("parse", () => {
  it("extracts leading comments as docComment", () => {
    const result = parse(file(`-- Find a user by email.\n-- Returns one row.\nSELECT * FROM users WHERE email = $1`));
    expect(result.docComment).toBe("Find a user by email.\nReturns one row.");
  });

  it("docComment is null when no comments", () => {
    const result = parse(file(`SELECT 1`));
    expect(result.docComment).toBeNull();
  });

  it("sql body does not contain leading comments", () => {
    const result = parse(file(`-- A comment\n\nSELECT id FROM users`));
    expect(result.sql).toBe("SELECT id FROM users");
    expect(result.sql).not.toContain("--");
  });

  it("paramCount is the highest $N found", () => {
    expect(parse(file(`SELECT * FROM t WHERE a = $1 AND b = $2 AND c = $3`)).paramCount).toBe(3);
  });

  it("paramCount is 0 when no params", () => {
    expect(parse(file(`SELECT 1`)).paramCount).toBe(0);
  });

  it("handles $N with gaps (uses highest)", () => {
    // User writes $1 and $3 but no $2 — we report 3
    // Postgres will catch the real error at prepare time
    expect(parse(file(`SELECT * FROM t WHERE a = $1 AND b = $3`)).paramCount).toBe(3);
  });

  it("does not count $N inside the comment section", () => {
    const result = parse(file(`-- filter by $1 placeholder\nSELECT 1`));
    expect(result.paramCount).toBe(0);
  });

  it("preserves original sql formatting", () => {
    const sql = `SELECT\n  id,\n  name\nFROM\n  users`;
    const result = parse(file(`-- docs\n${sql}`));
    expect(result.sql).toBe(sql);
  });
});

describe("param name inference", () => {
  it("infers name from WHERE col = $N", () => {
    const result = parse(file(`SELECT * FROM users WHERE email = $1`));
    expect(result.paramHints.get(1)).toBe("email");
  });

  it("infers name from WHERE col >= $N", () => {
    const result = parse(file(`SELECT * FROM users WHERE age >= $1`));
    expect(result.paramHints.get(1)).toBe("age");
  });

  it("infers names from INSERT INTO t (a, b) VALUES ($1, $2)", () => {
    const result = parse(file(`INSERT INTO users (name, email) VALUES ($1, $2)`));
    expect(result.paramHints.get(1)).toBe("name");
    expect(result.paramHints.get(2)).toBe("email");
  });

  it("infers names from SET col = $N", () => {
    const result = parse(file(`UPDATE users SET name = $2, colour = $3 WHERE id = $1`));
    expect(result.paramHints.get(1)).toBe("id");
    expect(result.paramHints.get(2)).toBe("name");
    expect(result.paramHints.get(3)).toBe("colour");
  });

  it("infers name from ILIKE", () => {
    const result = parse(file(`SELECT * FROM users WHERE name ILIKE $1`));
    expect(result.paramHints.get(1)).toBe("name");
  });

  it("does not use SQL keywords as param names", () => {
    // WHERE NOT ... or WHERE SELECT — shouldn't pick up keywords
    const result = parse(file(`SELECT * FROM t WHERE $1 = true`));
    expect(result.paramHints.has(1)).toBe(false);
  });

  it("returns empty map when no params", () => {
    const result = parse(file(`SELECT 1`));
    expect(result.paramHints.size).toBe(0);
  });

  it("handles multiple patterns in one query", () => {
    const result = parse(file(
      `SELECT * FROM users WHERE email = $1 AND age >= $2 AND status = $3`
    ));
    expect(result.paramHints.get(1)).toBe("email");
    expect(result.paramHints.get(2)).toBe("age");
    expect(result.paramHints.get(3)).toBe("status");
  });
});

describe("validateQueryName", () => {
  it("accepts valid snake_case names", () => {
    expect(validateQueryName("find_user")).toBeNull();
    expect(validateQueryName("list_all_posts")).toBeNull();
    expect(validateQueryName("a")).toBeNull();
    expect(validateQueryName("query1")).toBeNull();
  });

  it("rejects names starting with digits", () => {
    expect(validateQueryName("1bad")).not.toBeNull();
  });

  it("rejects names with uppercase", () => {
    expect(validateQueryName("findUser")).not.toBeNull();
  });

  it("rejects empty names", () => {
    expect(validateQueryName("")).not.toBeNull();
  });

  it("rejects names with special characters", () => {
    expect(validateQueryName("find-user")).not.toBeNull();
    expect(validateQueryName("find user")).not.toBeNull();
  });
});
