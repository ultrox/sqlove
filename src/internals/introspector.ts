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
 *   - ?/! column alias suffixes as user overrides
 *
 * Enums/arrays/domains: delegated to TypeResolver.
 */

import pg from "pg";
import { Effect, Option, Data } from "effect";
import { TypeResolver } from "./type-map.js";
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
        Effect.map((query) => ({ _tag: "ok" as const, query, pq })),
        Effect.catchAll((err) =>
          Effect.succeed({ _tag: "err" as const, error: toSqloveError(pq, err), pq }),
        ),
      ),
    );

    const queries: TypedQuery[] = [];
    const errors: SqloveError[] = [];
    for (const r of results) {
      if (r._tag === "ok") queries.push(r.query);
      else errors.push(r.error);
    }

    return { queries, enums: resolver.getEnums(), errors };
  });

export function createClient(): pg.Client {
  const url = process.env["DATABASE_URL"];
  if (url) return new pg.Client({ connectionString: url });
  return new pg.Client();
}

// ── Typed errors ────────────────────────────────────────────────────────────

class PgDescribeError extends Data.TaggedError("PgDescribeError")<{
  readonly sql: string;
  readonly cause: unknown;
}> {}

class PgQueryError extends Data.TaggedError("PgQueryError")<{
  readonly sql: string;
  readonly cause: unknown;
}> {}

class UnsupportedTypeOID extends Data.TaggedError("UnsupportedTypeOID")<{
  readonly context: "param" | "column";
  readonly oid: number;
}> {}

type IntrospectError = PgDescribeError | PgQueryError | UnsupportedTypeOID;

/** Map an IntrospectError to a user-facing SqloveError. */
const toSqloveError = (pq: ParsedQuery, err: IntrospectError): SqloveError => {
  switch (err._tag) {
    case "UnsupportedTypeOID":
      return Err.UnsupportedType(pq.file.queryName, err.oid);
    case "PgDescribeError":
      return Err.IntrospectionError(
        pq.file.queryName,
        pq.file.filePath,
        String((err.cause as any)?.message ?? err.cause),
        (err.cause as any)?.detail,
      );
    case "PgQueryError":
      return Err.IntrospectionError(
        pq.file.queryName,
        pq.file.filePath,
        String((err.cause as any)?.message ?? err.cause),
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
      catch: (cause) => new PgQueryError({ sql: "prefetch", cause }),
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

    if (tableCols.length === 0) return nullable;

    // Layer 1: column-level NOT NULL from pg_attribute
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

    // Layer 2: outer join nullability from EXPLAIN plan
    const joinNullable = yield* resolveJoinNullability(client, columns, sql);
    for (const idx of joinNullable) {
      nullable[idx] = true;
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
      Option.match(planOpt, {
        onNone: () => new Set<number>(),
        onSome: (plan) => nullableIndicesFromPlan(plan, columns),
      }),
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

/**
 * At join nodes, collect aliases from the nullable side:
 *   Left  → Inner child is nullable
 *   Right → Outer child is nullable
 *   Full  → both sides nullable
 */
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

/**
 * Extract alias prefix from an EXPLAIN Output entry.
 *   "u.name"                → "u"
 *   "\"*SELECT* 1\".amount" → "*SELECT* 1"
 *   "(expression)"          → null
 */
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

const resolveParamNullability = (
  client: pg.Client,
  raw: RawQueryDesc,
  pq: ParsedQuery,
): Effect.Effect<Map<number, boolean>, PgQueryError> =>
  Effect.gen(function* () {
    const result = new Map<number, boolean>();

    const insertOrSetParams = [...pq.paramInsertOrSet];
    if (insertOrSetParams.length === 0) return result;

    let tableOID = 0;
    for (const col of raw.columns) {
      if (col.tableOID !== 0) {
        tableOID = col.tableOID;
        break;
      }
    }

    if (tableOID === 0) {
      const tableMatch = /\b(?:INSERT\s+INTO|UPDATE)\s+(\w+)/i.exec(pq.sql);
      if (tableMatch) {
        const { rows } = yield* queryEffect<{ oid: number }>(
          client,
          `SELECT oid::int FROM pg_class WHERE relname = $1`,
          [tableMatch[1]],
        );
        if (rows[0]) tableOID = rows[0].oid;
      }
    }

    if (tableOID === 0) return result;

    const { rows } = yield* queryEffect<{
      attname: string;
      attnotnull: boolean;
    }>(
      client,
      `SELECT attname, attnotnull FROM pg_attribute
       WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`,
      [tableOID],
    );

    const colNullable = new Map<string, boolean>();
    for (const r of rows) colNullable.set(r.attname, !r.attnotnull);

    for (const idx of insertOrSetParams) {
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
  Effect.forEach(paramOIDs, (oid, i) => {
    const tsType = resolver.resolve(oid);
    if (!tsType) return Effect.fail(new UnsupportedTypeOID({ context: "param", oid }));
    const idx = i + 1;
    return Effect.succeed({
      index: idx,
      name: pq.paramHints.get(idx) ?? `arg${idx}`,
      oid,
      tsType,
      nullable: paramNullability.get(idx) ?? false,
    });
  });

const buildColumns = (
  columns: RawColumnDesc[],
  resolver: TypeResolver,
  nullable: boolean[],
): Effect.Effect<ResolvedColumn[], UnsupportedTypeOID> =>
  Effect.forEach(columns, (col, i) => {
    const tsType = resolver.resolve(col.dataTypeOID);
    if (!tsType) return Effect.fail(new UnsupportedTypeOID({ context: "column", oid: col.dataTypeOID }));
    return Effect.succeed({
      name: col.name,
      oid: col.dataTypeOID,
      tsType,
      nullable: nullable[i]!,
    });
  });
