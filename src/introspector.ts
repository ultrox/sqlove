/*
 * Talks to Postgres. No query is ever executed.
 *
 * Uses the extended query protocol: Parse + Describe.
 * Parse sends the SQL, Postgres parses it.
 * Describe returns param OIDs + column descriptors.
 * We never send Bind or Execute.
 *
 * DescribeSubmittable: pg-compatible Submittable that
 * plugs into pg's Client query queue. Sends Parse →
 * Describe → Sync, collects parameterDescription +
 * rowDescription events (not routed by pg Client,
 * so we listen on the connection directly).
 *
 * Nullability: pg_attribute.attnotnull for columns.
 * For INSERT/SET params, cross-reference the target
 * column's nullability to mark params as nullable.
 *
 * Enums/arrays/domains: delegated to TypeResolver.
 */

import pg from "pg";
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

// ── Submittable for Parse + Describe ────────────────────────────────────────
// Uses pg's extended query protocol to introspect a query without executing.
// Implements the Submittable interface so it plays nicely with pg's Client
// query queue.

class DescribeSubmittable {
  private paramOIDs: number[] = [];
  private columns: RawColumnDesc[] = [];
  private conn: any = null;
  private settled = false;

  constructor(
    private sql: string,
    private _resolve: (r: RawQueryDesc) => void,
    private _reject: (e: Error) => void
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

function describeRaw(client: pg.Client, sql: string): Promise<RawQueryDesc> {
  return new Promise((resolve, reject) => {
    (client as any).query(new DescribeSubmittable(sql, resolve, reject));
  });
}

// ── Nullability via pg_attribute ────────────────────────────────────────────

async function resolveNullability(
  client: pg.Client,
  columns: RawColumnDesc[]
): Promise<boolean[]> {
  const nullable = new Array<boolean>(columns.length).fill(false);
  const tableCols = columns
    .map((c, i) => ({ ...c, idx: i }))
    .filter((c) => c.tableOID !== 0 && c.columnID !== 0);

  if (tableCols.length === 0) return nullable;

  const pairs = tableCols.map((c) => `(${c.tableOID}, ${c.columnID})`);
  const { rows } = await client.query<{
    attrelid: number;
    attnum: number;
    attnotnull: boolean;
  }>(
    `SELECT attrelid::int, attnum::int, attnotnull
     FROM pg_attribute WHERE (attrelid, attnum) IN (${pairs.join(",")})`
  );

  const notNull = new Map<string, boolean>();
  for (const r of rows) notNull.set(`${r.attrelid}:${r.attnum}`, r.attnotnull);

  for (const c of tableCols) {
    nullable[c.idx] = !(notNull.get(`${c.tableOID}:${c.columnID}`) ?? false);
  }
  return nullable;
}

// ── Param nullability for INSERT/SET ─────────────────────────────────────────
// If a param is used in INSERT VALUES or SET and the target column is nullable,
// the param should accept null.

async function resolveParamNullability(
  client: pg.Client,
  raw: RawQueryDesc,
  pq: ParsedQuery
): Promise<Map<number, boolean>> {
  const result = new Map<number, boolean>();

  // Only check params that are in INSERT/SET context
  const insertOrSetParams = [...pq.paramInsertOrSet];
  if (insertOrSetParams.length === 0) return result;

  // We need a table to look up columns. Get it from the first column with a tableOID,
  // or parse the INSERT INTO <table> from the SQL.
  let tableOID = 0;
  for (const col of raw.columns) {
    if (col.tableOID !== 0) {
      tableOID = col.tableOID;
      break;
    }
  }

  // If no tableOID from columns (e.g., INSERT without RETURNING), parse table name from SQL
  if (tableOID === 0) {
    const tableMatch = /\b(?:INSERT\s+INTO|UPDATE)\s+(\w+)/i.exec(pq.sql);
    if (tableMatch) {
      const { rows } = await client.query<{ oid: number }>(
        `SELECT oid::int FROM pg_class WHERE relname = $1`,
        [tableMatch[1]]
      );
      if (rows[0]) tableOID = rows[0].oid;
    }
  }

  if (tableOID === 0) return result;

  // Get all column nullability for this table
  const { rows } = await client.query<{
    attname: string;
    attnotnull: boolean;
  }>(
    `SELECT attname, attnotnull FROM pg_attribute
     WHERE attrelid = $1 AND attnum > 0 AND NOT attisdropped`,
    [tableOID]
  );

  const colNullable = new Map<string, boolean>();
  for (const r of rows) {
    colNullable.set(r.attname, !r.attnotnull);
  }

  // For each INSERT/SET param, check if its target column is nullable
  for (const idx of insertOrSetParams) {
    const colName = pq.paramHints.get(idx);
    if (colName && colNullable.has(colName)) {
      result.set(idx, colNullable.get(colName)!);
    }
  }

  return result;
}

// ── High-level introspection ────────────────────────────────────────────────

export interface IntrospectResult {
  queries: TypedQuery[];
  enums: EnumDef[];
  errors: SqloveError[];
}

export async function introspect(
  client: pg.Client,
  parsedQueries: ParsedQuery[]
): Promise<IntrospectResult> {
  const resolver = new TypeResolver(client);
  const queries: TypedQuery[] = [];
  const errors: SqloveError[] = [];

  for (const pq of parsedQueries) {
    try {
      const raw = await describeRaw(client, pq.file.content);
      const allOids = [...raw.paramOIDs, ...raw.columns.map((c) => c.dataTypeOID)];
      await resolver.prefetch(allOids);

      const nullable = await resolveNullability(client, raw.columns);

      // Resolve param nullability for INSERT/SET params
      const paramNullability = await resolveParamNullability(
        client, raw, pq
      );

      const params: ResolvedParam[] = raw.paramOIDs.map((oid, i) => {
        const tsType = resolver.resolve(oid);
        if (!tsType) {
          throw Object.assign(new Error(`unsupported param type OID ${oid}`), { oid });
        }
        const idx = i + 1;
        const name = pq.paramHints.get(idx) ?? `arg${idx}`;
        const nullable = paramNullability.get(idx) ?? false;
        return { index: idx, name, oid, tsType, nullable };
      });

      const columns: ResolvedColumn[] = raw.columns.map((col, i) => {
        const tsType = resolver.resolve(col.dataTypeOID);
        if (!tsType) {
          throw Object.assign(new Error(`unsupported column type OID ${col.dataTypeOID}`), {
            oid: col.dataTypeOID,
          });
        }
        return { name: col.name, oid: col.dataTypeOID, tsType, nullable: nullable[i]! };
      });

      const isMutation = raw.columns.length === 0;

      queries.push({
        file: pq.file,
        docComment: pq.docComment,
        sql: pq.sql,
        params,
        columns,
        isMutation,
      });
    } catch (err: any) {
      if (err.oid !== undefined) {
        errors.push(Err.UnsupportedType(pq.file.queryName, err.oid));
      } else {
        errors.push(
          Err.IntrospectionError(
            pq.file.queryName,
            pq.file.filePath,
            err.message ?? String(err),
            err.detail
          )
        );
      }
    }
  }

  return { queries, enums: resolver.getEnums(), errors };
}

// ── Connection ──────────────────────────────────────────────────────────────

export function createClient(): pg.Client {
  const url = process.env["DATABASE_URL"];
  if (url) return new pg.Client({ connectionString: url });
  return new pg.Client();
}
