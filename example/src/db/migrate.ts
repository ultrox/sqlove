#!/usr/bin/env tsx

import pg from "pg";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const MIGRATIONS_DIR = new URL("./migrations", import.meta.url).pathname;

async function migrate() {
  const client = new pg.Client({
    connectionString:
      process.env["DATABASE_URL"] ??
      "postgresql://appuser:secret@localhost:5432/sqlove_test",
  });
  await client.connect();

  // Track applied migrations
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const { rows: applied } = await client.query<{ name: string }>(
    `SELECT name FROM _migrations ORDER BY name`
  );
  const appliedSet = new Set(applied.map((r) => r.name));

  // Read migration files
  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ran = 0;
  for (const file of files) {
    if (appliedSet.has(file)) continue;

    const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    console.log(`  ▸ ${file}`);
    await client.query(sql);
    await client.query(`INSERT INTO _migrations (name) VALUES ($1)`, [file]);
    ran++;
  }

  if (ran === 0) {
    console.log("Nothing to migrate.");
  } else {
    console.log(`Applied ${ran} migration(s).`);
  }

  await client.end();
}

migrate().catch((err) => {
  console.error(err);
  process.exit(1);
});
