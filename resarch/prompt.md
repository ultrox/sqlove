Problem: SQL query-level nullability inference for SELECT column expressions
 Given a SQL SELECT query and a Postgres schema, determine which output columns can be NULL at query time — not just based on the column's table definition, but
 based on the full query context: WHERE clauses, JOIN types, expression semantics, and function behavior.
 This is distinct from schema-level nullability (which pg_attribute.attnotnull answers). A column marked NOT NULL in the schema can still produce NULL in a query
 result (e.g., from a LEFT JOIN). Conversely, a nullable column might never be NULL in a specific query's result set (e.g., WHERE col IS NOT NULL).
 What we currently handle:
 - Table-level NOT NULL constraints (pg_attribute)
 - Outer join nullability (EXPLAIN GENERIC_PLAN, plan tree walk)
 - Expression nullability via AST (libpg-query): aggregates, JSONB operators, NULLIF, CASE, scalar subqueries, lag/lead
 - CTE column passthrough (name-based pg_attribute lookup)
 What we can't handle:
 - WHERE clause narrowing (WHERE x IS NOT NULL makes x non-null in results, but only under AND — OR breaks the guarantee)
 - Function null propagation (upper(nullable_col) is nullable because most SQL functions return NULL on NULL input — called "strict" functions in Postgres — but we
 don't check pg_proc.proisstrict)
 - Arithmetic null propagation (a + b is NULL if either is NULL)
 - COALESCE with all-nullable arguments (we assume COALESCE always removes NULL, but coalesce(null, null) is NULL)
 - CHECK constraints that effectively prevent NULL
 - Generated columns with NOT NULL expressions
 Prior art / related work:
 - Squirrel (Gleam) — same approach, same limitations, uses ?/! overrides
 - pgtyped — does not attempt expression nullability
 - Prisma — schema-level only
 - sqlc (Go) — uses sqlc.narg() annotation for nullable params, no expression inference
 - Postgres pg_proc.proisstrict — flag indicating if a function returns NULL on NULL input (could solve the function propagation problem)
 - Academic: "Nullability analysis of SQL queries" — type-theoretic approaches to NULL propagation through relational algebra operators
 The core tension: NULL in SQL is not a type — it's a value that any type can take. Tracking its flow through arbitrary expressions is equivalent to dataflow
 analysis on a dynamically-typed language. Full precision requires understanding the semantics of every operator, function, and predicate in the query. Partial
 detection creates an inconsistent user experience ("sometimes it works, sometimes it doesn't").
 Key question for research: Is there an existing tool, algorithm, or Postgres catalog feature that provides query-level (not schema-level) nullability information
 for SELECT output columns? Specifically, does pg_proc.proisstrict combined with WHERE clause analysis give us enough to be consistent rather than heuristic?
