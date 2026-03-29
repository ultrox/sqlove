import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Effect, ManagedRuntime, Redacted } from "effect";
import { PgClient } from "@effect/sql-pg";
import {
  listTodos,
  getTodo,
  createTodo,
  completeTodo,
  reopenTodo,
  deleteTodo,
  listByPriority,
  stats,
  type TodoPriority,
} from "./todos/sql.js";
import { toggleTodo, purgeCompleted, seed } from "./workflows.js";

// ── Runtime (one layer, built once) ─────────────────────────────────────────

const runtime = ManagedRuntime.make(
  PgClient.layer({
    url: Redacted.make(
      process.env["DATABASE_URL"] ??
        "postgresql://sqlove:sqlove@localhost:5555/sqlove_dev",
    ),
  }),
);

// ── Routes ──────────────────────────────────────────────────────────────────

const app = new Hono();

app.get("/todos/stats", async (c) => {
  const [row] = await runtime.runPromise(stats);
  return c.json(row ?? { total: 0, done: 0, pending: 0 });
});

app.get("/todos", async (c) => {
  const priority = c.req.query("priority") as TodoPriority | undefined;
  const rows = priority
    ? await runtime.runPromise(listByPriority({ priority }))
    : await runtime.runPromise(listTodos);
  return c.json(rows);
});

app.get("/todos/:id", async (c) => {
  const rows = await runtime.runPromise(
    getTodo({ id: Number(c.req.param("id")) }),
  );
  if (rows.length === 0) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

app.post("/todos", async (c) => {
  const body = await c.req.json<{
    title: string;
    description?: string;
    priority?: TodoPriority;
  }>();
  const rows = await runtime.runPromise(
    createTodo({
      title: body.title,
      description: body.description ?? "",
      priority: body.priority ?? "medium",
      shareWith: null,
    }),
  );
  return c.json(rows[0], 201);
});

app.post("/todos/:id/complete", async (c) => {
  const rows = await runtime.runPromise(
    completeTodo({ id: Number(c.req.param("id")) }),
  );
  if (rows.length === 0)
    return c.json({ error: "not found or already done" }, 404);
  return c.json(rows[0]);
});

app.post("/todos/:id/reopen", async (c) => {
  const rows = await runtime.runPromise(
    reopenTodo({ id: Number(c.req.param("id")) }),
  );
  if (rows.length === 0) return c.json({ error: "not found or not done" }, 404);
  return c.json(rows[0]);
});

app.delete("/todos/:id", async (c) => {
  await runtime.runPromise(deleteTodo({ id: Number(c.req.param("id")) }));
  return c.json({ ok: true });
});

// ── Workflow routes ─────────────────────────────────────────────────────────

app.post("/todos/:id/toggle", async (c) => {
  const result = await runtime.runPromise(
    toggleTodo(Number(c.req.param("id"))),
  );
  return c.json(result);
});

app.post("/todos/purge", async (c) => {
  const result = await runtime.runPromise(purgeCompleted);
  return c.json(result);
});

app.post("/todos/seed", async (c) => {
  await runtime.runPromise(seed);
  const rows = await runtime.runPromise(listTodos);
  return c.json(rows, 201);
});

// ── Start ───────────────────────────────────────────────────────────────────

const port = Number(process.env["PORT"] ?? 3000);
console.log(`📋 Todo API on http://localhost:${port}`);
serve({ fetch: app.fetch, port });
