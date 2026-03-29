import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { discover } from "../src/internals/discovery.js";

const TMP = join(tmpdir(), `sqlove-test-${Date.now()}`);

beforeAll(() => {
  // Build a fixture tree:
  // src/
  //   app/
  //     sql/
  //       find_user.sql
  //       list_users.sql
  //       .hidden.sql         ← should be ignored
  //       readme.md           ← should be ignored
  //   other/
  //     sql/
  //       get_thing.sql
  //   empty/
  //     sql/                  ← no .sql files
  //   no_sql_dir/
  //     stuff.ts              ← no sql/ directory

  const dirs = [
    "src/app/sql",
    "src/other/sql",
    "src/empty/sql",
    "src/no_sql_dir",
    "src/node_modules/bad/sql", // should be skipped
  ];
  for (const d of dirs) mkdirSync(join(TMP, d), { recursive: true });

  const files: Record<string, string> = {
    "src/app/sql/find_user.sql": "SELECT * FROM users WHERE id = $1",
    "src/app/sql/list_users.sql": "SELECT * FROM users",
    "src/app/sql/.hidden.sql": "SELECT 1",
    "src/app/sql/readme.md": "not sql",
    "src/other/sql/get_thing.sql": "SELECT * FROM things WHERE id = $1",
    "src/no_sql_dir/stuff.ts": "export const x = 1",
    "src/node_modules/bad/sql/sneaky.sql": "SELECT 1",
  };
  for (const [path, content] of Object.entries(files)) {
    writeFileSync(join(TMP, path), content);
  }
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("discover", () => {
  it("finds sql/ directories and returns correct output paths", async () => {
    const result = await discover(join(TMP, "src"));
    const outPaths = [...result.keys()].sort();

    // Should find app/sql.ts and other/sql.ts
    expect(outPaths).toHaveLength(2);
    expect(outPaths[0]).toContain(join("app", "sql.ts"));
    expect(outPaths[1]).toContain(join("other", "sql.ts"));
  });

  it("collects only .sql files, ignores dotfiles and non-sql", async () => {
    const result = await discover(join(TMP, "src"));
    const appFiles = result.get([...result.keys()].find((k) => k.includes("app"))!)!;
    const names = appFiles.map((f) => f.queryName);

    expect(names).toContain("find_user");
    expect(names).toContain("list_users");
    expect(names).not.toContain(".hidden");
    expect(names).not.toContain("readme");
  });

  it("returns files sorted by query name", async () => {
    const result = await discover(join(TMP, "src"));
    const appFiles = result.get([...result.keys()].find((k) => k.includes("app"))!)!;
    const names = appFiles.map((f) => f.queryName);

    expect(names).toEqual([...names].sort());
  });

  it("skips empty sql/ directories", async () => {
    const result = await discover(join(TMP, "src"));
    const hasEmpty = [...result.keys()].some((k) => k.includes("empty"));
    expect(hasEmpty).toBe(false);
  });

  it("skips node_modules", async () => {
    const result = await discover(join(TMP, "src"));
    const hasBad = [...result.keys()].some((k) => k.includes("node_modules"));
    expect(hasBad).toBe(false);
  });

  it("reads file content correctly", async () => {
    const result = await discover(join(TMP, "src"));
    const appFiles = result.get([...result.keys()].find((k) => k.includes("app"))!)!;
    const findUser = appFiles.find((f) => f.queryName === "find_user")!;

    expect(findUser.content).toBe("SELECT * FROM users WHERE id = $1");
  });

  it("returns empty map when no sql/ directories exist", async () => {
    const result = await discover(join(TMP, "src", "no_sql_dir"));
    expect(result.size).toBe(0);
  });
});
