import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import pg from "pg";

const DATABASE_URL = "postgresql://sqlove:sqlove@localhost:5555/sqlove_test";
const CLI = join(import.meta.dirname, "../src/cli.ts");
const TMP = join(tmpdir(), `sqlove-cli-${Date.now()}`);

function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "npx",
      ["tsx", CLI, ...args],
      {
        cwd: TMP,
        env: { ...process.env, DATABASE_URL, ...env },
        timeout: 15_000,
      },
      (error, stdout, stderr) => {
        resolve({
          code: error?.code ?? 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        });
      },
    );
  });
}

beforeAll(async () => {
  const client = new pg.Client({ connectionString: DATABASE_URL });
  await client.connect();
  await client.query(`
    CREATE TABLE IF NOT EXISTS todo (
      id serial PRIMARY KEY,
      title text NOT NULL,
      description text,
      done boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
  await client.end();

  // Good queries
  mkdirSync(join(TMP, "src/app/sql"), { recursive: true });
  writeFileSync(
    join(TMP, "src/app/sql/list_todos.sql"),
    "-- List all todos.\nSELECT id, title, done FROM todo ORDER BY id",
  );
  writeFileSync(
    join(TMP, "src/app/sql/get_todo.sql"),
    "SELECT id, title, description FROM todo WHERE id = $1",
  );
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("cli", () => {
  it("generates files and exits 0", async () => {
    const { code, stdout } = await runCli(["--src", "./src"]);
    expect(code).toBe(0);
    expect(stdout).toContain("✓");
    expect(stdout).toContain("list_todos.sql");
    expect(stdout).toContain("get_todo.sql");
    expect(stdout).toContain("Generated");

    // File was actually written
    const content = readFileSync(join(TMP, "src/app/sql.ts"), "utf8");
    expect(content).toContain("listTodos");
    expect(content).toContain("getTodo");
  });

  it("is idempotent — second run says up-to-date", async () => {
    const { code, stdout } = await runCli(["--src", "./src"]);
    expect(code).toBe(0);
    expect(stdout).toContain("up-to-date");
    expect(stdout).not.toContain("Generated");
  });

  it("check passes when files are current", async () => {
    const { code, stdout } = await runCli(["check", "--src", "./src"]);
    expect(code).toBe(0);
    expect(stdout).toContain("up-to-date");
  });

  it("check fails when file is stale", async () => {
    writeFileSync(join(TMP, "src/app/sql.ts"), "// tampered");
    const { code, stderr } = await runCli(["check", "--src", "./src"]);
    expect(code).toBe(1);
    expect(stderr).toContain("out of date");

    // Restore
    await runCli(["--src", "./src"]);
  });

  it("reports bad SQL and exits 1", async () => {
    writeFileSync(
      join(TMP, "src/app/sql/bad_query.sql"),
      "SELECT FROM WHERE NOPE",
    );
    const { code, stderr, stdout } = await runCli(["--src", "./src"]);
    expect(code).toBe(1);
    // Bad query reported
    expect(stderr).toContain("bad_query");
    // Good queries still succeed
    expect(stdout).toContain("list_todos.sql");

    rmSync(join(TMP, "src/app/sql/bad_query.sql"));
    await runCli(["--src", "./src"]);
  });

  it("reports connection error with bad DATABASE_URL", async () => {
    const { code, stderr } = await runCli(
      ["--src", "./src"],
      { DATABASE_URL: "postgresql://nobody:wrong@localhost:9999/nope" },
    );
    expect(code).toBe(1);
    expect(stderr).toContain("connect");
  });

  it("prints help with --help", async () => {
    const { code, stdout } = await runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("sqlove");
    expect(stdout).toContain("--src");
  });

  it("prints version with --version", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exits 0 when no sql/ directories found", async () => {
    const emptyDir = join(TMP, "empty");
    mkdirSync(join(emptyDir, "src"), { recursive: true });
    const { code, stdout } = await runCli(["--src", join(emptyDir, "src")]);
    expect(code).toBe(0);
    expect(stdout).toContain("No sql/");
  });
});
