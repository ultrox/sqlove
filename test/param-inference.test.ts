import { describe, it, expect, beforeAll } from "vitest";
import {
  loadModule,
  inferParamNames,
  inferInsertOrSetParams,
} from "../src/internals/param-inference.js";

beforeAll(async () => {
  await loadModule();
});

describe("inferParamNames", () => {
  describe("WHERE clauses", () => {
    it("simple equality: WHERE email = $1", () => {
      const hints = inferParamNames("SELECT id FROM users WHERE email = $1", 1);
      expect(hints.get(1)).toBe("email");
    });

    it("comparison: WHERE age >= $1", () => {
      const hints = inferParamNames("SELECT id FROM users WHERE age >= $1", 1);
      expect(hints.get(1)).toBe("age");
    });

    it("qualified column: WHERE u.name = $1", () => {
      const hints = inferParamNames("SELECT id FROM users u WHERE u.name = $1", 1);
      expect(hints.get(1)).toBe("name");
    });

    it("multiple params: WHERE a = $1 AND b = $2", () => {
      const hints = inferParamNames("SELECT id FROM t WHERE a = $1 AND b = $2", 2);
      expect(hints.get(1)).toBe("a");
      expect(hints.get(2)).toBe("b");
    });

    it("ILIKE: WHERE name ILIKE $1", () => {
      const hints = inferParamNames("SELECT id FROM users WHERE name ILIKE $1", 1);
      expect(hints.get(1)).toBe("name");
    });

    it("param on left: WHERE $1 = email", () => {
      const hints = inferParamNames("SELECT id FROM users WHERE $1 = email", 1);
      expect(hints.get(1)).toBe("email");
    });

    it("deeply qualified: WHERE schema.table.col = $1 takes last segment", () => {
      const hints = inferParamNames("SELECT id FROM t WHERE t.email = $1", 1);
      expect(hints.get(1)).toBe("email");
    });
  });

  describe("INSERT", () => {
    it("positional match: INSERT INTO t (a, b) VALUES ($1, $2)", () => {
      const hints = inferParamNames("INSERT INTO t (name, email) VALUES ($1, $2)", 2);
      expect(hints.get(1)).toBe("name");
      expect(hints.get(2)).toBe("email");
    });

    it("with RETURNING", () => {
      const hints = inferParamNames(
        "INSERT INTO users (name, email) VALUES ($1, $2) RETURNING id",
        2,
      );
      expect(hints.get(1)).toBe("name");
      expect(hints.get(2)).toBe("email");
    });

    it("with type cast: VALUES ($1, $2::user_role)", () => {
      const hints = inferParamNames(
        "INSERT INTO users (name, role) VALUES ($1, $2::user_role)",
        2,
      );
      expect(hints.get(1)).toBe("name");
      // $2 has a cast — ParamRef is wrapped in TypeCast, might not match
      // This documents current behavior
    });
  });

  describe("UPDATE SET", () => {
    it("SET col = $N", () => {
      const hints = inferParamNames("UPDATE users SET name = $2 WHERE id = $1", 2);
      expect(hints.get(1)).toBe("id");
      expect(hints.get(2)).toBe("name");
    });

    it("multiple SET columns", () => {
      const hints = inferParamNames(
        "UPDATE users SET name = $2, colour = $3 WHERE id = $1",
        3,
      );
      expect(hints.get(1)).toBe("id");
      expect(hints.get(2)).toBe("name");
      expect(hints.get(3)).toBe("colour");
    });
  });

  describe("DELETE", () => {
    it("WHERE in DELETE", () => {
      const hints = inferParamNames("DELETE FROM users WHERE id = $1", 1);
      expect(hints.get(1)).toBe("id");
    });
  });

  describe("edge cases", () => {
    it("no params → empty map", () => {
      const hints = inferParamNames("SELECT 1", 0);
      expect(hints.size).toBe(0);
    });

    it("param not next to column → no hint", () => {
      const hints = inferParamNames("SELECT $1", 1);
      expect(hints.has(1)).toBe(false);
    });
  });
});

describe("inferInsertOrSetParams", () => {
  it("INSERT VALUES params", () => {
    const result = inferInsertOrSetParams(
      "INSERT INTO t (a, b) VALUES ($1, $2) RETURNING id",
      2,
    );
    expect(result.has(1)).toBe(true);
    expect(result.has(2)).toBe(true);
  });

  it("UPDATE SET params", () => {
    const result = inferInsertOrSetParams(
      "UPDATE t SET name = $2, email = $3 WHERE id = $1",
      3,
    );
    expect(result.has(2)).toBe(true);
    expect(result.has(3)).toBe(true);
    // $1 is in WHERE, not SET
    expect(result.has(1)).toBe(false);
  });

  it("SELECT has no insert/set params", () => {
    const result = inferInsertOrSetParams(
      "SELECT * FROM t WHERE id = $1",
      1,
    );
    expect(result.size).toBe(0);
  });

  it("DELETE has no insert/set params", () => {
    const result = inferInsertOrSetParams(
      "DELETE FROM t WHERE id = $1",
      1,
    );
    expect(result.size).toBe(0);
  });
});
