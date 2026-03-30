# Design Decisions & Open Questions

Raw notes on choices made, alternatives considered, and things
still unresolved. Written as we built it, updated as we learned.

---

## The core insight

The database already knows every type. When you `PREPARE` a
statement, Postgres tells you exactly what goes in and what
comes out — parameter types, column types, enums, arrays.
That's not a guess. It's the live system.

So instead of maintaining types by hand or generating them
from a schema file that might be stale, just ask the database.
Write SQL, ask Postgres what the types are, generate TypeScript.

For example, given this query:

```sql
-- order_details.sql
SELECT
  o.id AS order_id,
  o.status,
  u.name AS customer,
  p.name AS product,
  p.price,
  li.quantity,
  (li.quantity * li.unit_price)::numeric(10,2) AS line_total,
  pay.method AS payment_method,
  pay.paid_at,
  r.reason AS refund_reason
FROM orders o
JOIN users u ON u.id = o.user_id
JOIN line_items li ON li.order_id = o.id
JOIN products p ON p.id = li.product_id
LEFT JOIN payments pay ON pay.order_id = o.id
LEFT JOIN refunds r ON r.order_id = o.id
WHERE o.id = $1 AND o.status = $2::order_status
```

<details>
<summary>Postgres tells us everything — click to see the raw catalog output</summary>

**1. Parameter types** — `PREPARE` + `pg_prepared_statements`:

```
    parameter_types
------------------------
 {integer,order_status}
```

`$1` is `integer`, `$2` is `order_status` (an enum). No guessing.

**2. Column types + schema nullability** — `pg_attribute`:

```
 column_name │ source_table │         pg_type          │ schema_null
─────────────┼──────────────┼──────────────────────────┼─────────────
 id          │ orders       │ integer                  │ NOT NULL
 status      │ orders       │ order_status             │ NOT NULL
 name        │ users        │ text                     │ NOT NULL
 name        │ products     │ text                     │ NOT NULL
 price       │ products     │ numeric(10,2)            │ NOT NULL
 quantity    │ line_items   │ integer                  │ NOT NULL
 unit_price  │ line_items   │ numeric(10,2)            │ NOT NULL
 method      │ payments     │ text                     │ NOT NULL
 paid_at     │ payments     │ timestamp with time zone │ NOT NULL
 reason      │ refunds      │ text                     │ nullable
```

**3. Join types** — `EXPLAIN (GENERIC_PLAN)`:

```
 "Join Type": "Inner"   ← orders ↔ users
 "Join Type": "Inner"   ← orders ↔ line_items
 "Join Type": "Inner"   ← line_items ↔ products
 "Join Type": "Left"    ← LEFT JOIN payments (nullable side: pay)
 "Join Type": "Left"    ← LEFT JOIN refunds (nullable side: r)
```

`pay.method`, `pay.paid_at`, and `r.reason` are on the nullable
side of LEFT JOINs — so they're nullable in the result even
though `method` and `paid_at` are `NOT NULL` in their tables.

**4. Enum variants** — `pg_enum`:

```
 order_status: {pending, confirmed, shipped, delivered, cancelled}
```

**5. Operator strictness** — `pg_proc.proisstrict`:

```
 oprname │   proname   │ proisstrict
─────────┼─────────────┼─────────────
 *       │ int4mul     │ true
 *       │ numeric_mul │ true
```

The `*` operator is strict — `NULL * x` returns `NULL`.
So `(li.quantity * li.unit_price)` is nullable if either
operand is nullable (they're not, so the expression is
not nullable).

**6. What sqlove generates from all of this:**

```ts
export class OrderDetailsRow extends Schema.Class<OrderDetailsRow>("OrderDetailsRow")({
  orderId: Schema.propertySignature(Schema.Number).pipe(Schema.fromKey("order_id")),
  status: OrderStatus,                                    // enum
  customer: Schema.String,
  product: Schema.String,
  price: Schema.String,                                   // numeric → string
  quantity: Schema.Number,
  lineTotal: Schema.propertySignature(Schema.String)      // computed, non-null
    .pipe(Schema.fromKey("line_total")),
  paymentMethod: Schema.propertySignature(                 // LEFT JOIN → nullable
    Schema.NullOr(Schema.String)
  ).pipe(Schema.fromKey("payment_method")),
  paidAt: Schema.propertySignature(                        // LEFT JOIN → nullable
    Schema.NullOr(Schema.DateFromString)
  ).pipe(Schema.fromKey("paid_at")),
  refundReason: Schema.propertySignature(                  // LEFT JOIN + nullable column
    Schema.NullOr(Schema.String)
  ).pipe(Schema.fromKey("refund_reason")),
}) {}
```

Every type, every nullability decision, every enum — derived
from the live database. Not a schema file. Not a guess.

</details>

This is what [Squirrel](https://github.com/giacomocavalieri/squirrel)
does for Gleam. We ported the philosophy to TypeScript + Effect.

---

## Why not an ORM

The actual trajectory with ORMs:

1. Learn the ORM
2. Learn SQL anyway (you always have to)
3. Fight the ORM when it can't express your query
4. Drop into raw queries for the hard stuff
5. Maintain two mental models forever

The ORM didn't remove SQL from your life. It added a layer.
And when something breaks at 3am, you're reading the ORM's
source code instead of your query.

sqlove deletes the only thing an ORM ever actually saved you:
the boilerplate (type definitions, parameter wiring, row
decoding). Nothing else. You keep full control.

---

## Decisions we made

### SQL returns tables. Always.

Every query returns `ReadonlyArray<Row>`. Even
`SELECT ... WHERE id = $1` on a primary key. Because SQL
returns result sets — that's the model.

This means you destructure:
`const [user] = yield* getUser({ id: 1 })`.

We considered returning `Option<Row>` for queries that provably
return 0 or 1 rows (unique key lookup, `LIMIT 1`). Decided
against it for v0.1 — detecting this reliably requires
understanding primary keys, unique constraints, and query
semantics. A wrong `Option` is worse than a correct array.

### No-param queries are `const`, param queries are functions

```ts
export const listTodos: Effect.Effect<...> = ...
export const getTodo = (params: { ... }): Effect.Effect<...> => ...
```

`yield* listTodos` (no parens) vs `yield* getTodo({ id: 1 })`
(call it). If there's nothing to pass, don't pretend there is.

### Param names are inferred from SQL context

Instead of `arg1`, `arg2`, we parse the SQL to figure out
what `$1` means:

- `WHERE email = $1` → `email`
- `INSERT INTO t (name, email) VALUES ($1, $2)` → `name`, `email`
- `SET colour = $3` → `colour`

Falls back to `argN` when we can't infer. The inference
uses regex on normalized SQL (not the libpg-query AST — the
AST is used for nullability, not param naming). Works for
common patterns. Exotic SQL might get `argN` names.

A future improvement: use the AST for param naming too.
The `ColumnRef` nodes in `WHERE`, `INSERT`, and `SET` clauses
would give us exact column names without regex.

### snake_case → camelCase at the boundary

Postgres columns are `snake_case`. TypeScript convention is
`camelCase`. We transform at two boundaries:

**Row types** use `Schema.fromKey`:
```ts
createdAt: Schema.propertySignature(Schema.DateFromString)
  .pipe(Schema.fromKey("created_at"))
```

**Param names** are camelCased in the function signature:
```ts
params: { readonly shareWith: string | null }
```

The SQL itself always keeps the original column names.

---

## Nullability: the hardest problem in SQL codegen

"Can this column be null?" sounds simple. The answer depends on
table constraints, join types, function behavior, expression
semantics, WHERE clauses, CTE boundaries, and runtime parameter
values. No existing tool — Squirrel, sqlc, pgtyped, Prisma,
Kysely — handles all of these.

We went through seven iterations to get here.

### Iteration 1: pg_attribute only

Check `pg_attribute.attnotnull` for each result column. Works
for simple `SELECT col FROM table` queries. Breaks immediately
on outer joins — a `NOT NULL` column becomes nullable when
it's on the right side of a `LEFT JOIN`.

### Iteration 2: regex on SQL

Parse the SQL with regex to find `LEFT JOIN`, `RIGHT JOIN`,
`FULL JOIN`. Broke on schema-qualified names (`public.orders`),
subqueries, CTEs, and comments containing `LEFT JOIN`.

### Iteration 3: EXPLAIN with NULL params

Use `PREPARE` + `EXPLAIN EXECUTE` with NULL arguments. The
plan collapsed — `WHERE id = NULL` is always false, so Postgres
optimized away all join nodes. No join info to read.

### Iteration 4: EXPLAIN with dummy typed values

Replace NULLs with typed dummy values (`0` for int, `''` for
text). Postgres optimized `LEFT JOIN` → `INNER JOIN` when the
WHERE clause filtered on the nullable side. Wrong plan, wrong
nullability.

### Iteration 5: EXPLAIN GENERIC_PLAN

Postgres 16+ option. Gives the plan without knowing parameter
values. No collapse, no optimization artifacts. Same approach
Squirrel uses. Walk the plan tree, collect aliases from the
nullable side of each join. This solved join nullability
correctly for all cases — schema-qualified names, subqueries,
CTEs, LATERAL, nested parens, same table with different aliases.

### Iteration 6: regex on EXPLAIN Output strings

For expression columns (`tableOID = 0`), matched patterns like
`max(`, `->>`, `NULLIF` in the plan's Output entries. Worked
but fragile — same problem as iteration 2, just one level up.
If Postgres changes the EXPLAIN Output format, our regex breaks.

### Iteration 7: libpg-query AST

Postgres's own C parser compiled to WASM. Parses SQL into typed
AST nodes. `FuncCall`, `CaseExpr`, `SubLink`, `A_Expr` — we
check node types, not strings. Can't be wrong about what the
SQL means because the parser IS Postgres.

This was the foundation that made iterations 8 and 9 possible.

### Iteration 8: pg_proc.proisstrict

The biggest breakthrough. Researched how PostgreSQL's own
planner handles nullability internally. The planner doesn't
use hardcoded function lists — it checks `pg_proc.proisstrict`
for every function and operator.

`proisstrict = true` means "this function returns NULL if ANY
argument is NULL." Enforced at the executor level, not by
function authors. The guarantee is ironclad. About 60-65% of
PostgreSQL's ~3,200 built-in functions are strict — covering
all arithmetic operators, all string functions, all comparison
operators, and most type casts.

Before: hardcoded list of nullable aggregates. No way to handle
`upper(nullable_col)` or `age + 1`.

After: one `pg_proc` query per SQL file. Every function — built-in,
extension, or user-defined — is covered. The AST gives us what
functions are called and what their arguments are. `pg_proc`
tells us how they propagate null. No lists to maintain.

This also fixed `coalesce(nullable, nullable)`: the AST
recursively checks if ALL coalesce arguments are nullable,
and only then marks the result as nullable.

### Iteration 9: WHERE clause null-rejection

The NULL-substitution technique from StarRocks / PostgreSQL's
`find_nonnullable_vars`. For each nullable column, substitute
NULL into the WHERE predicate. If the predicate becomes FALSE
or NULL → row filtered → column is non-null in results.

This handles any strict predicate automatically:
- `WHERE bio IS NOT NULL` → obvious
- `WHERE bio = $1` → `=` is strict, `NULL = x` → NULL → filtered
- `WHERE length(bio) > 0` → `length` is strict
- AND: any conjunct rejects → column non-null
- OR: ALL disjuncts must reject → column non-null

Initially we decided NOT to implement this because of
inconsistent UX (sometimes narrows, sometimes doesn't). But
after implementing `pg_proc.proisstrict`, the inconsistency
argument weakened — strict operators in WHERE clauses are
detectable, and AND/OR rules are well-defined. We implemented
it as a separate module (`where-nullability.ts`) that can be
read, questioned, or removed independently.

### The final stack

Six layers, each backed by Postgres itself:

```
Layer 1: pg_attribute.attnotnull
         Table column constraints.

Layer 2: EXPLAIN GENERIC_PLAN
         Outer join sides (alias-based plan tree walk).

Layer 3: libpg-query AST + pg_proc.proisstrict
         Expression structure + function null propagation.
         Covers: aggregates, JSONB ops, CASE, NULLIF,
         SubLink, TypeCast, strict function args, coalesce.

Layer 4: pg_attribute by name
         CTE/subquery columns that lost their tableOID.

Layer 5: WHERE null-rejection
         NULL-substitution on WHERE predicates.

Layer 6: ?/! column alias suffixes
         User override. Always has final say.
```

### Known limitations (tested, documented)

Three cases where the tool gets it wrong, each with a
`limitation_*.sql` fixture and a test asserting the current
(wrong) behavior:

1. **Non-strict custom function** — tool says not-nullable,
   function might return null. Can't know without running it.

2. **Strict function returning null on non-null input** —
   `proisstrict` guarantees null-in→null-out, but a function
   could also return null for other reasons. Rare.

3. **WHERE in nested CTE** — outer query doesn't see inner
   WHERE narrowing. CTE columns have `tableOID = 0`, so
   Layer 4 (name lookup) says nullable based on the source
   table, ignoring the CTE's own WHERE clause.

Each test has a comment explaining what's actually correct
and how to override with `?`/`!`. If we fix any of these,
the test fails — telling us to flip the assertion.

### How we compare to other tools

| Feature | Squirrel | sqlc | pgtyped | sqlove |
|---|---|---|---|---|
| Table NOT NULL | ✅ | ✅ | ✅ | ✅ |
| Outer join | ✅ | partial | ❌ | ✅ |
| Function propagation | ❌ | ❌ | ❌ | ✅ pg_proc |
| Expression nullability | ❌ | ❌ | ❌ | ✅ AST |
| Aggregate nullability | ❌ | partial | ❌ | ✅ |
| JSONB operators | ❌ | ❌ | ❌ | ✅ |
| COALESCE analysis | ❌ | buggy | ❌ | ✅ |
| CTE passthrough | ❌ | ❌ | ❌ | ✅ |
| WHERE narrowing | ❌ | ❌ | ❌ | ✅ |
| User override | ❌ | partial | ✅ !/?| ✅ !/?|

---

## Open questions / unresolved tensions

### `null` vs `undefined` vs `optional` for nullable params

Current state: nullable INSERT/SET params are `string | null`.

```ts
createTodo({ title: "x", description: null, shareWith: null })
```

You must pass every field. Explicit but verbose.

Alternative: `shareWith?: string | null` — optional property.
Cleaner DX. But `undefined` flows into SQL params. Postgres
receives `NULL` either way. The question is whether the type
system should distinguish "not provided" from "explicitly null."

Currently keeping `| null` (explicit). Revisit if users complain.

### Column nullability for params

Postgres does NOT expose parameter nullability. When you write
`$1` going into a nullable column, Postgres says the parameter
is `text` — not "this parameter could be null."

Our workaround: detect INSERT/SET params, find the target
column, check if it's nullable. Works for simple INSERT/UPDATE.
Doesn't work for `COALESCE($1, default)` or subquery params.

### Should generated code be committed?

Yes. Same as Squirrel. `sqlove check` in CI verifies they match.
Code review shows what changed. No build step for editor types.

### Effect in generated code — is it too opinionated?

Hard dependency on Effect + @effect/sql + Schema. Only useful
if you're already using Effect. If there's demand, a
`--target plain` flag that generates `async/await` with `pg`
directly would make sqlove universal.

### The `ManagedRuntime` bridge in Hono handlers

Our first attempt was a `runSql` wrapper with 6 imports. The
fix was `ManagedRuntime` — build the runtime once, each handler
is `runtime.runPromise(effect)`. One line, three imports. In a
fully Effect-based server, the bridge wouldn't exist at all.

### Snapshot tests need guardrails

Snapshots capture regressions, not correctness. We layer three
test types: targeted assertions (specific bugs), structural
invariants (classes of bugs), and snapshot (regressions). The
invariants catch bad snapshots.

---

## Things we explicitly chose NOT to do

- **No config file.** `DATABASE_URL` and `sql/` directories.
- **No query builder.** You write SQL.
- **No migration tool.** Use whatever you want.
- **No runtime dependency.** sqlove is a devDependency.
- **No watch mode (yet).** One-shot + `check` in CI.
- **No custom type overrides.** OID → Schema mapping is fixed.

---

## Performance

The pipeline for 50 queries runs in ~40-70ms. Breakdown:

```
parser:       <1ms / 50 files    (pure string processing)
codegen:      <1ms / 50 queries  (pure string building)
introspect:  40-60ms / 50 queries (Postgres round-trips)
discovery:   10-30ms / 50 files   (filesystem walk)
```

Bottleneck is network I/O to Postgres. `libpg-query` WASM
loads once (~1ms) and parses each SQL file in microseconds.

---

## Lineage

Direct port of ideas from
[Squirrel](https://github.com/giacomocavalieri/squirrel)
by Giacomo Cavalieri:

> Instead of trying to hide SQL, embrace it and leave you
> in control.

Same conventions (sql/ directories, one query per file,
generated sibling module), same approach (protocol-level
introspection, no execution), same opinion (the database
is the source of truth). We diverged on nullability inference
— adding AST analysis, `pg_proc.proisstrict`, and WHERE
narrowing — but the philosophy is identical.
