# Design Decisions & Open Questions

Raw notes on choices made, alternatives considered, and things still unresolved. Written as we built it, not cleaned up after.

---

## The core insight

The database already knows every type. When you `PREPARE` a statement, Postgres tells you exactly what goes in and what comes out — parameter types, column types, nullability, enums, arrays. That's not a guess. It's the live system.

So instead of maintaining types by hand or generating them from a schema file that might be stale, just ask the database. Write SQL, ask Postgres what the types are, generate TypeScript. Done.

This is what [Squirrel](https://github.com/giacomocavalieri/squirrel) does for Gleam. We ported the philosophy to TypeScript + Effect.

---

## Why not an ORM

The actual trajectory with ORMs:

1. Learn the ORM
2. Learn SQL anyway (you always have to)
3. Fight the ORM when it can't express your query
4. Drop into raw queries for the hard stuff
5. Maintain two mental models forever

The ORM didn't remove SQL from your life. It added a layer. And when something breaks at 3am, you're reading the ORM's source code instead of your query.

sqlove deletes the only thing an ORM ever actually saved you: the boilerplate (type definitions, parameter wiring, row decoding). Nothing else. You keep full control.

---

## Decisions we made

### SQL returns tables. Always.

Every query returns `ReadonlyArray<Row>`. Even `SELECT ... WHERE id = $1` on a primary key. Because SQL returns result sets — that's the model. There's no "return a single row" in SQL.

This means you destructure: `const [user] = yield* getUser({ id: 1 })`.

We considered returning `Option<Row>` for queries that provably return 0 or 1 rows (unique key lookup, `LIMIT 1`). Decided against it for v0.1 — detecting this reliably requires understanding primary keys, unique constraints, and query semantics. Too complex, too easy to get wrong. A wrong `Option` is worse than a correct array.

### No-param queries are `const`, param queries are functions

```ts
export const listTodos: Effect.Effect<...> = ...           // no params, just a value
export const getTodo = (params: { ... }): Effect.Effect<...> => ...  // has params, it's a function
```

This means `yield* listTodos` (no parens) vs `yield* getTodo({ id: 1 })` (call it). It reads differently and that's intentional — if there's nothing to pass, don't pretend there is.

### Param names are inferred from SQL context

Instead of `arg1`, `arg2`, we parse the SQL to figure out what `$1` means:

- `WHERE email = $1` → `email`
- `INSERT INTO t (name, email) VALUES ($1, $2)` → `name`, `email`
- `SET colour = $3` → `colour`

Falls back to `argN` when we can't infer. The inference is heuristic-based (regex on normalized SQL), not a real SQL parser. It works for common patterns. Exotic SQL might get `argN` names.

We debated whether to build or use a proper SQL parser. Decided against it — a regex that handles 90% of cases is better than a dependency that handles 100% but adds complexity. If a name is wrong, you just rename the file or alias in SQL.

### snake_case → camelCase at the boundary

Postgres columns are `snake_case`. TypeScript convention is `camelCase`. We transform at two boundaries:

**Row types** use `Schema.fromKey` to map at decode time:
```ts
createdAt: Schema.propertySignature(Schema.DateFromString).pipe(Schema.fromKey("created_at"))
```

**Param names** are camelCased in the function signature and template interpolation:
```ts
params: { readonly shareWith: string | null }
// SQL template uses ${params.shareWith} which maps to the $N placeholder
```

The SQL itself always keeps the original column names. Only the TypeScript-facing API is camelCase.

---

## Open questions / unresolved tensions

### `null` vs `undefined` vs `optional` for nullable params

This is genuinely hard in TypeScript. Current state: nullable INSERT/SET params are `string | null`.

```ts
createTodo({ title: "x", description: null, shareWith: null })
```

You must pass every field. Explicit but verbose.

Alternative: `shareWith?: string | null` — optional property, omit means null.

```ts
createTodo({ title: "x" })  // shareWith omitted = NULL in Postgres
```

Cleaner DX. But now `undefined` flows into your SQL params. Does `@effect/sql` handle that correctly? Probably. But it's a runtime assumption hiding behind a type-level convenience.

The deeper question: what does Postgres receive? It receives `NULL`. Not `undefined`, not "missing". `NULL`. So `null` is the honest representation.

We went back and forth on this. Currently keeping `| null` (explicit). The `?:` optional approach might be better DX but we want to think about it more before committing.

**What would Evan (Elm) do?** Elm has no null or undefined. It has `Maybe a = Just a | Nothing`. The Effect equivalent is `Option<T>`. But `Option` for every nullable SQL param feels heavy. And it doesn't match what Postgres actually does.

### Column nullability for params

Postgres tells us column nullability (via `pg_attribute`). But it does NOT tell us parameter nullability. When you write `$1` going into a nullable `text` column, Postgres says "this parameter is `text`" — not "this parameter could be null."

This is the same limitation Squirrel has. From their README:
> Postgres doesn't expose any data about the nullability of query parameters

Our workaround: we detect if a `$N` appears in an INSERT VALUES or SET assignment, find the target column, check if that column is nullable. If yes, the param gets `| null`.

This works for INSERT/UPDATE SET. It doesn't work for WHERE clauses — and that's correct. `WHERE email = $1` should require a value. You're filtering, you need something to filter by.

Edge cases we don't handle:
- `INSERT ... ON CONFLICT DO UPDATE SET` — the SET params might be nullable
- Subqueries — param used in a subquery's INSERT
- `COALESCE($1, default)` — param is intentionally nullable but we can't detect it

For these, you can always cast: `$1::text` or handle nullability in application code.

### Should generated code be committed?

Yes. Same as Squirrel. The generated `sql.ts` files are committed to version control. `sqlove check` in CI verifies they match the database.

Why not `.gitignore` them and generate in CI? Because:
1. Code review — you see what changed when a migration alters types
2. No build step needed to get type checking in your editor
3. Diffs show exactly what a schema change affects

### One query per file — is that too granular?

Squirrel enforces this. We follow it. The argument: each file is a single responsibility. The filename IS the function name. There's no ambiguity about what goes where.

The counterargument: 50 queries = 50 files. That's a lot of files.

In practice, it's fine. They're tiny files (2-10 lines each). Your IDE handles it. And when you need to find the query for "list todos by priority", you look for `list_by_priority.sql`. No searching through a 500-line file.

### Effect in generated code — is it too opinionated?

sqlove generates code that depends on Effect, @effect/sql, and Schema. That's a hard dependency on a specific ecosystem.

Alternative: generate plain `pg` code (what we built first, actually). Simpler, works everywhere, no ecosystem lock-in.

We chose Effect because:
- `SqlClient` as a service in context = no passing `db` around
- `Schema.Class` = runtime validation + static types in one declaration
- `Effect.gen` + `yield*` = composable queries without try/catch
- Error channel = typed errors, no thrown exceptions

But this means sqlove is only useful if you're already using Effect. That's a real trade-off. If there's demand, we could add a `--target plain` flag that generates simple `async/await` code with `pg` directly.

### The `ManagedRuntime` bridge in Hono handlers — and the `runSql` mistake

Our first attempt at bridging Effect with Hono was a `runSql` wrapper:

```ts
import { Effect, Layer, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"
import { SqlClient } from "@effect/sql/SqlClient"
import type { SqlError } from "@effect/sql/SqlError"

const DbLayer = PgClient.layer({
  url: Redacted.make(process.env.DATABASE_URL!),
})

function runSql<A>(effect: Effect.Effect<A, SqlError, SqlClient>): Promise<A> {
  return Effect.runPromise(Effect.provide(effect, DbLayer))
}

// Every handler:
app.get("/todos", async (c) => {
  const rows = await runSql(listTodos)
  return c.json(rows)
})
```

This worked but it was ugly. You had to import 6 things (`Effect`, `Layer`, `Redacted`, `PgClient`, `SqlClient`, `SqlError`) just to set up one wrapper function. The `runSql` name was meaningless — it's just "run this effect with the DB layer." And `Effect.provide(effect, DbLayer)` inside every call meant the layer was being evaluated per request.

The fix was `ManagedRuntime`:

```ts
import { ManagedRuntime, Redacted } from "effect"
import { PgClient } from "@effect/sql-pg"

const runtime = ManagedRuntime.make(
  PgClient.layer({ url: Redacted.make(process.env.DATABASE_URL!) })
)

app.get("/todos", async (c) =>
  c.json(await runtime.runPromise(listTodos))
)
```

Three imports instead of six. The runtime is built once with the layer baked in. Each handler is one line — `runtime.runPromise(effect)`. No wrapper function, no re-providing the layer. The bridge is still there (Effect → Promise) but it's minimal and obvious.

In a fully Effect-based server (e.g., @effect/platform HTTP), this bridge wouldn't exist at all. You'd compose Effects all the way up. We accept the bridge because Hono is a real-world framework people use.

---

### Nullability is harder than it looks

"Can this column be null?" sounds simple. The answer depends on:

- **Table constraints** — `NOT NULL` in `pg_attribute`. Easy.
- **Join type** — LEFT/RIGHT/FULL makes the other side nullable. We use `EXPLAIN (GENERIC_PLAN)` to walk the plan tree and collect aliases from nullable sides. Same approach as Squirrel.
- **Aggregates** — `max()` returns null on zero rows, `count()` never does, `coalesce()` removes null. We can't detect this — it requires understanding SQL function semantics.
- **JSONB operators** — `->>'key'` returns null if key doesn't exist. Expression column, `tableOID = 0`, invisible to `pg_attribute`.
- **CTE columns** — lose their table metadata. `tableOID = 0`.
- **Runtime parameter values** — `WHERE ($1 IS NULL OR c.id = $1)` changes join behavior depending on the value. `GENERIC_PLAN` handles this correctly by not optimizing for specific values.

We went through several iterations on the join detection:

1. **Regex on SQL** — broke on schema-qualified names (`public.orders`), subqueries, CTEs, and comments containing `LEFT JOIN`.
2. **EXPLAIN with NULL params** — plan collapsed (`WHERE id = NULL` → always false, no join nodes).
3. **EXPLAIN with dummy typed values** — Postgres optimized LEFT→INNER when filtering on nullable side.
4. **EXPLAIN (GENERIC_PLAN)** — Postgres 16+ option. Gives the plan without knowing parameter values. No collapse, no optimization artifacts. Same approach Squirrel uses. This is what we ship.

For the cases we can't detect (aggregates, JSONB, CTEs), we added `?` and `!` suffixes on column aliases — same escape hatch as Squirrel:

```sql
-- Force nullable: tool can't know max() returns null on empty
SELECT max(o.created_at) AS "last_order_at?"
FROM users u LEFT JOIN orders o ON o.user_id = u.id

-- Force non-null: you know bio is always set for active users
SELECT bio AS "bio!" FROM users WHERE active = true
```

The suffix is stripped from the column name. Postgres never sees it. One character, explicit, no magic.

### Snapshot tests need guardrails

Snapshots capture regressions ("did the output change?") but not correctness ("is the output right?"). A wrong snapshot accepted once passes forever.

We layer three kinds of tests:

1. **Targeted assertions** (`complex-queries.test.ts`, `joins.test.ts`) — "this column IS nullable", "this param IS camelCase". Catches specific bugs.
2. **Structural invariants** (`fixtures.test.ts`) — "every Schema.Class has a matching function", "no raw $N leaks into templates", "no ?/! suffixes in field names". Catches classes of bugs.
3. **Snapshot** (`fixtures.test.ts`) — "nothing changed". Catches regressions.

The invariant checks run alongside the snapshot. If someone accepts a wrong snapshot, the invariants catch it. If the invariants pass but the output is subtly wrong, the targeted assertions catch it.

---

## Things we explicitly chose NOT to do

- **No config file.** Convention over configuration. `DATABASE_URL` and `sql/` directories. That's it.
- **No query builder.** You write SQL. The tool doesn't help you write SQL.
- **No migration tool.** Use whatever you want. sqlove only reads the database.
- **No runtime dependency.** Generated code imports from `effect` and `@effect/sql`. sqlove itself is a devDependency.
- **No watch mode (yet).** One-shot generate + `check` in CI. Watch mode is planned but not essential.
- **No custom type overrides.** The OID → Schema mapping is fixed. If you need a custom mapping, that's a future feature.

---

## Performance

Not a concern. The entire pipeline for 50 queries runs in ~40ms. Breakdown:

```
parser:       0.7ms / 50 files     (pure string processing)
codegen:      0.5ms / 50 queries   (pure string building)
introspect:  41ms / 50 queries     (Postgres round-trips — the bottleneck)
discovery:   18ms / 50 files       (filesystem walk)
```

The bottleneck is network I/O to Postgres. There's nothing to optimize in the tool itself. It's faster than a single React component render.

---

## Lineage

Direct port of ideas from [Squirrel](https://github.com/giacomocavalieri/squirrel) by Giacomo Cavalieri. The philosophy is identical:

> Instead of trying to hide SQL, embrace it and leave you in control.

Squirrel does this for Gleam + pog. sqlove does this for TypeScript + Effect + @effect/sql. Same conventions (sql/ directories, one query per file, generated sibling module), same approach (protocol-level introspection, no execution), same opinion (the database is the source of truth).
