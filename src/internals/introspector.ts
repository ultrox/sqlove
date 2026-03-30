/*
 * Talks to Postgres. No query is ever executed.
 *
 * Two introspection methods:
 *   1. Parse + Describe (extended query protocol)
 *      → param OIDs + column descriptors
 *   2. EXPLAIN (GENERIC_PLAN)
 *      → query plan tree for join nullability
 *
 * Nullability is resolved in layers:
 *   - pg_attribute.attnotnull for table columns
 *   - EXPLAIN plan tree for outer join sides
 *   - SQL AST (libpg-query) for expression nullability
 *   - pg_attribute name lookup for CTE/subquery columns
 *   - ?/! column alias suffixes as user overrides
 *
 * Enums/arrays/domains: delegated to TypeResolver.
 */

import pg from "pg";
import { Effect, Option, Data, Array as Arr } from "effect";
import { TypeResolver } from "./type-map.js";
import { detectNullableExpressions } from "./sql-ast.js";
import type {
  EnumDef,
  ParsedQuery,
  RawColumnDesc,
  RawQueryDesc,
  ResolvedColumn,
  ResolvedParam,
  TypedQuery,
} from "./types.js";
import type { SqloveError } from "./errors.js";
import * as Err from "./errors.js";

// ── Typed errors ────────────────────────────────────────────────────────────

/** Parse + Describe protocol failed — SQL is invalid or connection dropped. */
class PgDescribeError extends Data.TaggedError("PgDescribeError")<{
  readonly sql: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return extractMessage(this.cause);
  }
  get detail(): string | undefined {
    return extractDetail(this.cause);
  }
}

/** A pg_catalog query failed — pg_attribute, pg_class, pg_type, etc. */
class PgQueryError extends Data.TaggedError("PgQueryError")<{
  readonly sql: string;
  readonly cause: unknown;
}> {
  get message(): string {
    return extractMessage(this.cause);
  }
  get detail(): string | undefined {
    return extractDetail(this.cause);
  }
}

/** Type OID prefetch from pg_type/pg_enum failed. */
class PrefetchError extends Data.TaggedError("PrefetchError")<{
  readonly cause: unknown;
}> {
  get message(): string {
    return extractMessage(this.cause);
  }
}

/** A param or column has a Postgres type OID we don't know how to map. */
class UnsupportedTypeOID extends Data.TaggedError("UnsupportedTypeOID")<{
  readonly context: "param" | "column";
  readonly oid: number;
}> {}

type IntrospectError =
  | PgDescribeError
  | PgQueryError
  | PrefetchError
  | UnsupportedTypeOID;

function extractMessage(cause: unknown): string {
  if (typeof cause === "object" && cause !== null && "message" in cause) {
    return String((cause as { message: unknown }).message);
  }
  return String(cause);
}

function extractDetail(cause: unknown): string | undefined {
  if (typeof cause === "object" && cause !== null && "detail" in cause) {
    return String((cause as { detail: unknown }).detail);
  }
  return undefined;
}

/** Map an IntrospectError to a user-facing SqloveError. */
const toSqloveError = (pq: ParsedQuery, err: IntrospectError): SqloveError => {
  switch (err._tag) {
    case "UnsupportedTypeOID":
      return Err.UnsupportedType(pq.file.queryName, err.oid);
    case "PgDescribeError":
    case "PgQueryError":
      return Err.IntrospectionError(
        pq.file.queryName, pq.file.filePath, err.message, err.detail,
      );
    case "PrefetchError":
      return Err.IntrospectionError(
        pq.file.queryName, pq.file.filePath,
        `failed to prefetch type info: ${err.message}`,
      );
  }
};

// ── Plan node type ──────────────────────────────────────────────────────────

interface PlanNode {
  "Join Type"?: string;
  "Node Type"?: string;
  Alias?: string;
  Output?: string[];
  Plans?: PlanNode[];
}

// ── Public API ──────────────────────────────────────────────────────────────

export interface IntrospectResult {
  queries: TypedQuery[];
  enums: EnumDef[];
  errors: SqloveError[];
}

/**
 * Introspect all parsed queries. Errors accumulate —
 * one bad query doesn't kill the rest.
 */
export const introspect = (
  client: pg.Client,
  parsedQueries: ParsedQuery[],
): Effect.Effect<IntrospectResult, never> =>
  Effect.gen(function* () {
    const resolver = new TypeResolver(client);

    const results = yield* Effect.forEach(parsedQueries, (pq) =>
      introspectOne(client, resolver, pq).pipe(
        Effect.mapError((err) => toSqloveError(pq, err)),
        Effect.either,
      ),
    );

    return {
      queries: Arr.getRights(results),
      enums: resolver.getEnums(),
      errors: Arr.getLefts(results),
    };
  });

export function createClient(): pg.Client {
  const url = process.env["DATABASE_URL"];
  if (url) return new pg.Client({ connectionString: url });
  return new pg.Client();
}

// ── DB helpers ──────────────────────────────────────────────────────────────

const queryEffect = <T extends pg.QueryResultRow>(
  client: pg.Client,
  sql: string,
  params?: unknown[],
) =>
  Effect.tryPromise({
    try: () => client.query<T>(sql, params),
    catch: (cause) => new PgQueryError({ sql, cause }),
  });

// ── Introspect one query ────────────────────────────────────────────────────

const introspectOne = (
  client: pg.Client,
  resolver: TypeResolver,
  pq: ParsedQuery,
): Effect.Effect<TypedQuery, IntrospectError> =>
  Effect.gen(function* () {
    const raw = yield* describeRaw(client, pq.file.content);
    const { cleanColumns, nullOverrides } = applyColumnOverrides(raw.columns);

    yield* Effect.tryPromise({
      try: () =>
        resolver.prefetch([
          ...raw.paramOIDs,
          ...cleanColumns.map((c) => c.dataTypeOID),
        ]),
      catch: (cause) => new PrefetchError({ cause }),
    });

    const nullable = yield* resolveNullability(client, cleanColumns, pq.file.content);
    for (const [idx, forced] of nullOverrides) {
      nullable[idx] = forced;
    }

    const paramNullability = yield* resolveParamNullability(client, raw, pq);
    const params = yield* buildParams(raw.paramOIDs, resolver, pq, paramNullability);
    const columns = yield* buildColumns(cleanColumns, resolver, nullable);

    // isMutation: no columns returned (INSERT/UPDATE/DELETE without RETURNING).
    // DO blocks also return zero columns but aren't mutations —
    // acceptable since DO blocks won't be in sql/ files.
    const isMutation = raw.columns.length === 0;

    return {
      file: pq.file,
      docComment: pq.docComment,
      sql: pq.sql,
      params,
      columns,
      isMutation,
    } satisfies TypedQuery;
  });

// ── Parse + Describe (extended query protocol) ──────────────────────────────

class DescribeSubmittable {
  private paramOIDs: number[] = [];
  private columns: RawColumnDesc[] = [];
  private conn: any = null;
  private settled = false;

  constructor(
    private sql: string,
    private _resolve: (r: RawQueryDesc) => void,
    private _reject: (e: Error) => void,
  ) {}

  submit(connection: any) {
    this.conn = connection;
    connection.on("parameterDescription", this._onParamDesc);
    connection.on("noData", this._onNoData);
    connection.parse({ name: "", text: this.sql, types: [] });
    connection.describe({ type: "S", name: "" });
    connection.sync();
  }

  private _cleanup() {
    if (this.conn) {
      this.conn.removeListener("parameterDescription", this._onParamDesc);
      this.conn.removeListener("noData", this._onNoData);
    }
  }

  private _onParamDesc = (msg: any) => {
    this.paramOIDs = msg.dataTypeIDs ?? [];
  };
  private _onNoData = () => {
    this.columns = [];
  };

  handleParseComplete() {}
  handleRowDescription(msg: any) {
    this.columns = (msg.fields ?? []).map((f: any) => ({
      name: f.name as string,
      tableOID: f.tableID as number,
      columnID: f.columnID as number,
      dataTypeOID: f.dataTypeID as number,
    }));
  }
  handleError(err: any, _conn: any) {
    this._cleanup();
    if (!this.settled) {
      this.settled = true;
      this._reject(err);
    }
  }
  handleReadyForQuery() {
    this._cleanup();
    if (!this.settled) {
      this.settled = true;
      this._resolve({ paramOIDs: this.paramOIDs, columns: this.columns });
    }
  }
  handleEmptyQuery() {}
  handleCommandComplete() {}
}

const describeRaw = (
  client: pg.Client,
  sql: string,
): Effect.Effect<RawQueryDesc, PgDescribeError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<RawQueryDesc>((resolve, reject) => {
        (client as any).query(new DescribeSubmittable(sql, resolve, reject));
      }),
    catch: (cause) => new PgDescribeError({ sql, cause }),
  });

// ── Column override: ?/! suffixes (pure) ────────────────────────────────────

function applyColumnOverrides(columns: RawColumnDesc[]): {
  cleanColumns: RawColumnDesc[];
  nullOverrides: Map<number, boolean>;
} {
  const nullOverrides = new Map<number, boolean>();
  const cleanColumns = columns.map((col, i) => {
    if (col.name.endsWith("?")) {
      nullOverrides.set(i, true);
      return { ...col, name: col.name.slice(0, -1) };
    }
    if (col.name.endsWith("!")) {
      nullOverrides.set(i, false);
      return { ...col, name: col.name.slice(0, -1) };
    }
    return col;
  });
  return { cleanColumns, nullOverrides };
}

// ── Nullability: pg_attribute + EXPLAIN ─────────────────────────────────────

const resolveNullability = (
  client: pg.Client,
  columns: RawColumnDesc[],
  sql: string,
): Effect.Effect<boolean[], PgQueryError> =>
  Effect.gen(function* () {
    const nullable = new Array<boolean>(columns.length).fill(false);
    const tableCols = columns
      .map((c, i) => ({ ...c, idx: i }))
      .filter((c) => c.tableOID !== 0 && c.columnID !== 0);

    // Layer 1: column-level NOT NULL from pg_attribute
    if (tableCols.length > 0) {
      const pairs = tableCols.map((c) => `(${c.tableOID}, ${c.columnID})`);
      const { rows } = yield* queryEffect<{
        attrelid: number;
        attnum: number;
        attnotnull: boolean;
      }>(
        client,
        `SELECT attrelid::int, attnum::int, attnotnull
         FROM pg_attribute WHERE (attrelid, attnum) IN (${pairs.join(",")})`,
      );

      const notNull = new Map<string, boolean>();
      for (const r of rows) notNull.set(`${r.attrelid}:${r.attnum}`, r.attnotnull);

      for (const c of tableCols) {
        nullable[c.idx] = !(notNull.get(`${c.tableOID}:${c.columnID}`) ?? false);
      }
    }

    // Layer 2: EXPLAIN plan for outer join nullability
    // Infallible — EXPLAIN failures → empty set
    const joinNullable = yield* resolveJoinNullability(client, columns, sql);
    for (const idx of joinNullable) {
      nullable[idx] = true;
    }

    // Layer 3: SQL AST + pg_proc.proisstrict for expression nullability
    // AST gives us node types. pg_proc tells us which functions are strict
    // (null in → null out). Together they replace hardcoded function lists.
    //
    // We need to know which SOURCE columns (not result columns) are nullable.
    // Query pg_attribute for all tables referenced in the query.
    const sourceNullableCols = yield* resolveSourceNullableColumns(client, sql);

    const exprNullable = yield* Effect.tryPromise({
      try: () => detectNullableExpressions(sql, client, sourceNullableCols),
      catch: () => new PgQueryError({ sql: "<ast-parse>", cause: "AST parse failed" }),
    }).pipe(Effect.orElseSucceed(() => new Set<number>()));

    for (const idx of exprNullable) {
      nullable[idx] = true;
    }

    // Layer 4: for remaining tableOID=0 columns, check if a column
    // with the same name exists in any table and is nullable there
    // (covers CTEs, subqueries that pass through table columns)
    const unresolvedCols = columns
      .map((c, i) => ({ ...c, idx: i }))
      .filter((c) => c.tableOID === 0 && !nullable[c.idx]);

    if (unresolvedCols.length > 0) {
      const colNames = unresolvedCols.map((c) => c.name);
      const { rows } = yield* queryEffect<{
        attname: string;
        attnotnull: boolean;
      }>(
        client,
        `SELECT DISTINCT a.attname, a.attnotnull
         FROM pg_attribute a
         WHERE a.attname = ANY($1)
           AND a.attnum > 0
           AND NOT a.attisdropped
           AND NOT a.attnotnull`,
        [colNames],
      );

      const nullableCols = new Set(rows.map((r) => r.attname));
      for (const c of unresolvedCols) {
        if (nullableCols.has(c.name)) {
          nullable[c.idx] = true;
        }
      }
    }

    return nullable;
  });

// ── EXPLAIN-based join nullability ──────────────────────────────────────────

const getQueryPlan = (
  client: pg.Client,
  sql: string,
): Effect.Effect<Option.Option<PlanNode>, never> =>
  queryEffect(client, `EXPLAIN (FORMAT JSON, VERBOSE, GENERIC_PLAN) ${sql}`).pipe(
    Effect.map((result) =>
      Option.fromNullable(
        (result.rows[0] as any)?.["QUERY PLAN"]?.[0]?.Plan as PlanNode | undefined,
      ),
    ),
    Effect.orElseSucceed(() => Option.none()),
  );

const resolveJoinNullability = (
  client: pg.Client,
  columns: RawColumnDesc[],
  sql: string,
): Effect.Effect<Set<number>, never> =>
  getQueryPlan(client, sql).pipe(
    Effect.map((planOpt) =>
      planOpt.pipe(
        Option.map((plan) => nullableIndicesFromPlan(plan, columns)),
        Option.getOrElse(() => new Set<number>()),
      ),
    ),
  );

// ── Plan tree walkers (pure, no DB) ─────────────────────────────────────────

function nullableIndicesFromPlan(
  plan: PlanNode,
  columns: RawColumnDesc[],
): Set<number> {
  const result = new Set<number>();

  const nullableAliases = new Set<string>();
  collectNullableAliases(plan, nullableAliases);
  if (nullableAliases.size === 0) return result;

  const output = plan.Output ?? [];
  for (let i = 0; i < output.length && i < columns.length; i++) {
    const alias = extractAliasFromOutput(output[i]!);
    if (alias && nullableAliases.has(alias)) {
      result.add(i);
    }
  }

  return result;
}

function collectNullableAliases(node: PlanNode, result: Set<string>): void {
  const joinType = node["Join Type"];
  const plans = node.Plans ?? [];

  if (joinType && plans.length === 2) {
    const [outer, inner] = plans;
    if (joinType === "Left" || joinType === "Full") {
      collectAllAliases(inner!, result);
    }
    if (joinType === "Right" || joinType === "Full") {
      collectAllAliases(outer!, result);
    }
  }

  for (const child of plans) {
    collectNullableAliases(child, result);
  }
}

function collectAllAliases(node: PlanNode, result: Set<string>): void {
  if (node.Alias) result.add(node.Alias);
  for (const child of node.Plans ?? []) {
    collectAllAliases(child, result);
  }
}

function extractAliasFromOutput(ref: string): string | null {
  if (ref.startsWith('"')) {
    const closeQuote = ref.indexOf('"', 1);
    if (closeQuote > 1 && ref[closeQuote + 1] === ".") {
      return ref.slice(1, closeQuote);
    }
    return null;
  }
  const dotIdx = ref.indexOf(".");
  if (dotIdx > 0) return ref.slice(0, dotIdx);
  return null;
}

// ── Param nullability for INSERT/SET ────────────────────────────────────────

/**
 * Get all nullable column names from all tables referenced in the SQL.
 * Parses the SQL to find table names, resolves via pg_class + pg_attribute.
 * Used to feed the AST analyzer for function null propagation.
 */
const resolveSourceNullableColumns = (
  client: pg.Client,
  sql: string,
): Effect.Effect<Set<string>, PgQueryError> =>
  Effect.gen(function* () {
    // Extract table names from the SQL AST
    const tableNames = yield* Effect.tryPromise({
      try: async () => {
        const pgParser = await import("libpg-query");
        await pgParser.loadModule();
        const ast = pgParser.parseSync(sql);
        const names = new Set<string>();
        collectTableNames(ast, names);
        return [...names];
      },
      catch: () => new PgQueryError({ sql, cause: "table name extraction failed" }),
    }).pipe(Effect.orElseSucceed(() => [] as string[]));

    if (tableNames.length === 0) return new Set<string>();

    // Resolve table names → nullable columns in one query
    const { rows } = yield* queryEffect<{ attname: string }>(
      client,
      `SELECT DISTINCT a.attname
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       WHERE c.relname = ANY($1)
         AND a.attnum > 0
         AND NOT a.attisdropped
         AND NOT a.attnotnull`,
      [tableNames],
    );

    return new Set(rows.map((r) => r.attname.toLowerCase()));
  });

/** Walk AST to find all table names referenced in FROM/JOIN clauses. */
function collectTableNames(node: any, names: Set<string>): void {
  if (node === null || node === undefined || typeof node !== "object") return;

  // RangeVar is a table reference in FROM/JOIN
  if (node.RangeVar?.relname) {
    names.add(node.RangeVar.relname);
  }

  for (const val of Object.values(node)) {
    if (Array.isArray(val)) {
      for (const item of val) collectTableNames(item, names);
    } else if (typeof val === "object" && val !== null) {
      collectTableNames(val, names);
    }
  }
}

/** Find the OID of the table targeted by an INSERT/UPDATE. */
const findTableOID = (
  client: pg.Client,
  raw: RawQueryDesc,
  sql: string,
): Effect.Effect<Option.Option<number>, PgQueryError> =>
  Effect.gen(function* () {
    // Try RETURNING columns first — they carry the table OID
    for (const col of raw.columns) {
      if (col.tableOID !== 0) return Option.some(col.tableOID);
    }
    // Fall back to parsing table name from SQL
    const tableMatch = /\b(?:INSERT\s+INTO|UPDATE)\s+(\w+)/i.exec(sql);
    if (!tableMatch) return Option.none();

    const { rows } = yield* queryEffect<{ oid: number }>(
      client,
      `SELECT oid::int FROM pg_class WHERE relname = $1`,
      [tableMatch[1]],
    );
    return Option.fromNullable(rows[0]?.oid);
  });

const resolveParamNullability = (
  client: pg.Client,
  raw: RawQueryDesc,
  pq: ParsedQuery,
): Effect.Effect<Map<number, boolean>, PgQueryError> =>
  Effect.gen(function* () {
    if (pq.paramInsertOrSet.size === 0) return new Map<number, boolean>();

    const tableOID = yield* findTableOID(client, raw, pq.sql);
    if (Option.isNone(tableOID)) return new Map<number, boolean>();

    const { rows } = yield* queryEffect<{
      attname: string;
      attnotnull: boolean;
    }>(
      client,
      `SELECT attname, attnotnull FROM pg_attribute
       WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`,
      [tableOID.value],
    );

    const colNullable = new Map(rows.map((r) => [r.attname, !r.attnotnull]));
    const result = new Map<number, boolean>();
    for (const idx of pq.paramInsertOrSet) {
      const colName = pq.paramHints.get(idx);
      if (colName && colNullable.has(colName)) {
        result.set(idx, colNullable.get(colName)!);
      }
    }
    return result;
  });

// ── Build params + columns ──────────────────────────────────────────────────

const buildParams = (
  paramOIDs: number[],
  resolver: TypeResolver,
  pq: ParsedQuery,
  paramNullability: Map<number, boolean>,
): Effect.Effect<ResolvedParam[], UnsupportedTypeOID> =>
  Effect.forEach(paramOIDs, (oid, i) =>
    Effect.fromNullable(resolver.resolve(oid)).pipe(
      Effect.mapError(() => new UnsupportedTypeOID({ context: "param", oid })),
      Effect.map((tsType) => {
        const idx = i + 1;
        return {
          index: idx,
          name: pq.paramHints.get(idx) ?? `arg${idx}`,
          oid,
          tsType,
          nullable: paramNullability.get(idx) ?? false,
        };
      }),
    ),
  );

const buildColumns = (
  columns: RawColumnDesc[],
  resolver: TypeResolver,
  nullable: boolean[],
): Effect.Effect<ResolvedColumn[], UnsupportedTypeOID> =>
  Effect.forEach(columns, (col, i) =>
    Effect.fromNullable(resolver.resolve(col.dataTypeOID)).pipe(
      Effect.mapError(() => new UnsupportedTypeOID({ context: "column", oid: col.dataTypeOID })),
      Effect.map((tsType) => ({
        name: col.name,
        oid: col.dataTypeOID,
        tsType,
        nullable: nullable[i]!,
      })),
    ),
  );
