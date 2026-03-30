/*
 * SQL AST analysis via libpg-query (Postgres's own parser as WASM)
 * + pg_proc.proisstrict for function null propagation.
 *
 * Two sources of truth:
 *   AST node types — CASE, NULLIF, SubLink, JSONB ops, CoalesceExpr
 *     are nullable/not-nullable by definition (SQL spec).
 *   pg_proc.proisstrict — "strict" functions return NULL if ANY
 *     argument is NULL. Covers ~60-65% of built-in functions
 *     and ALL operators. No hardcoded function lists needed.
 *
 * The AST tells us WHAT the expression is.
 * The catalog tells us HOW functions behave.
 */

import * as pgParser from "libpg-query";
import type pg from "pg";

let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (!loaded) {
    await pgParser.loadModule();
    loaded = true;
  }
}

// ── Public API ──────────────────────────────────────────

/**
 * Parse a SELECT query and return which target columns
 * (by 0-based index) are nullable based on expression analysis.
 *
 * Pass a pg.Client to enable pg_proc.proisstrict lookups.
 * Without it, only structural analysis is performed.
 */
export async function detectNullableExpressions(
  sql: string,
  client?: pg.Client,
  nullableColumns?: Set<string>,
): Promise<Set<number>> {
  await ensureLoaded();

  const nullable = new Set<number>();
  const strictnessCache = client ? await buildStrictnessCache(client, sql) : null;

  try {
    const ast = pgParser.parseSync(sql);
    const stmt = ast.stmts?.[0]?.stmt;
    const select = stmt?.SelectStmt;
    if (!select?.targetList) return nullable;

    for (let i = 0; i < select.targetList.length; i++) {
      const resTarget = select.targetList[i]?.ResTarget;
      if (!resTarget?.val) continue;

      if (isNullableNode(resTarget.val, strictnessCache, nullableColumns)) {
        nullable.add(i);
      }
    }
  } catch {
    // Parse failure — return empty set, fall back to other detection
  }

  return nullable;
}

// ── Strictness cache from pg_proc ───────────────────────

type StrictnessMap = Map<string, boolean>;

/**
 * Query pg_proc for all function names used in the SQL.
 * Returns a map of function_name → proisstrict.
 *
 * This covers built-in functions, extension functions,
 * and user-defined functions. One query, all answers.
 */
async function buildStrictnessCache(
  client: pg.Client,
  sql: string,
): Promise<StrictnessMap> {
  const cache = new Map<string, boolean>();

  try {
    const ast = pgParser.parseSync(sql);
    const funcNames = new Set<string>();
    collectFuncNames(ast, funcNames);

    if (funcNames.size === 0) return cache;

    const { rows } = await client.query<{
      proname: string;
      proisstrict: boolean;
    }>(
      `SELECT DISTINCT proname, proisstrict
       FROM pg_proc
       WHERE proname = ANY($1)`,
      [[...funcNames]],
    );

    for (const r of rows) {
      cache.set(r.proname, r.proisstrict);
    }
  } catch {
    // Catalog query failed — return empty cache, fall back to structural analysis
  }

  return cache;
}

/** Walk the entire AST and collect all function names. */
function collectFuncNames(node: any, names: Set<string>): void {
  if (node === null || node === undefined || typeof node !== "object") return;

  if (node.FuncCall?.funcname) {
    const name = node.FuncCall.funcname
      .map((n: any) => n.String?.sval)
      .filter(Boolean)
      .pop()
      ?.toLowerCase();
    if (name) names.add(name);
  }

  for (const val of Object.values(node)) {
    if (Array.isArray(val)) {
      for (const item of val) collectFuncNames(item, names);
    } else if (typeof val === "object" && val !== null) {
      collectFuncNames(val, names);
    }
  }
}

// ── AST nullability analysis ────────────────────────────

/**
 * Check if an AST node can produce null.
 *
 * Structural rules (SQL spec):
 *   CoalesceExpr     → not nullable (if any arg is non-null)
 *   CaseExpr         → nullable if ELSE is null/missing
 *   SubLink          → nullable (scalar subquery, no match → null)
 *   A_Expr(NULLIF)   → nullable (equal args → null)
 *   A_Expr(->>/->)   → nullable (JSONB key might not exist)
 *
 * Catalog-backed (pg_proc.proisstrict):
 *   FuncCall/OpExpr  → if strict AND any arg could be null → nullable
 *   This replaces hardcoded function lists entirely.
 */
function isNullableNode(
  node: any,
  strictness: StrictnessMap | null,
  nullableCols?: Set<string>,
): boolean {
  const type = Object.keys(node)[0];
  if (!type) return false;

  const val = node[type];

  switch (type) {
    case "FuncCall":
      return isFuncCallNullable(val, strictness, nullableCols);

    case "CoalesceExpr":
      return isCoalesceNullable(val, strictness, nullableCols);

    case "CaseExpr":
      return isCaseNullable(val, strictness, nullableCols);

    case "SubLink":
      return true;

    case "A_Expr":
      return isAExprNullable(val, strictness, nullableCols);

    case "TypeCast":
      if (val.arg) return isNullableNode(val.arg, strictness, nullableCols);
      return false;

    case "ColumnRef":
      // A bare column reference — nullable if the column is in our nullable set
      if (nullableCols) {
        const colName = val.fields
          ?.map((f: any) => f.String?.sval)
          .filter(Boolean)
          .pop()
          ?.toLowerCase();
        if (colName && nullableCols.has(colName)) return true;
      }
      return false;

    default:
      return false;
  }
}

function isFuncCallNullable(
  fc: any,
  strictness: StrictnessMap | null,
  nullableCols?: Set<string>,
): boolean {
  const funcName = fc.funcname
    ?.map((n: any) => n.String?.sval)
    .filter(Boolean)
    .pop()
    ?.toLowerCase();

  if (!funcName) return false;

  // count() never returns null
  if (funcName === "count") return false;

  // Window functions that return null at boundaries
  if (fc.over && NULLABLE_WINDOW_FNS.has(funcName)) return true;

  // Non-boundary window aggregates (sum OVER, avg OVER) — partition always has rows
  if (fc.over) return false;

  // Aggregates that return null on zero rows (no pg_proc needed — SQL spec)
  if (NULLABLE_AGGREGATES.has(funcName)) return true;

  // pg_proc.proisstrict: if strict AND any arg is nullable → output is nullable
  if (strictness) {
    const isStrict = strictness.get(funcName);
    if (isStrict === true) {
      // Strict function: null in → null out
      // Check if any argument references a nullable column
      const args = fc.args ?? [];
      for (const arg of args) {
        if (isNullableNode(arg, strictness, nullableCols)) return true;
      }
      return false;
    }
    if (isStrict === false) {
      // Non-strict function: can handle nulls internally
      // We can't know what it returns — conservatively say not nullable
      // (user can override with ?)
      return false;
    }
  }

  // No catalog info — can't determine, default to not nullable
  return false;
}

function isCoalesceNullable(
  ce: any,
  strictness: StrictnessMap | null,
  nullableCols?: Set<string>,
): boolean {
  // coalesce is nullable only if ALL arguments are nullable
  const args = ce.args ?? [];
  if (args.length === 0) return true;

  for (const arg of args) {
    if (!isNullableNode(arg, strictness, nullableCols)) {
      // At least one non-null arg → coalesce is not nullable
      return false;
    }
  }
  // All args nullable → coalesce can return null
  return true;
}

function isCaseNullable(
  ce: any,
  strictness: StrictnessMap | null,
  nullableCols?: Set<string>,
): boolean {
  // No ELSE clause → implicit NULL
  if (!ce.defresult) return true;

  // ELSE NULL → explicitly null
  if (ce.defresult.A_Const?.isnull) return true;

  // ELSE <expr> → check if that expr is nullable
  return isNullableNode(ce.defresult, strictness, nullableCols);
}

function isAExprNullable(
  expr: any,
  strictness: StrictnessMap | null,
  nullableCols?: Set<string>,
): boolean {
  // NULLIF — always nullable (equal args → null)
  if (expr.kind === "AEXPR_NULLIF") return true;

  // JSONB operators: -> and ->>
  const opName = expr.name?.[0]?.String?.sval;
  if (opName === "->>" || opName === "->") return true;

  // Other operators are strict (arithmetic, comparison, string ops)
  // Check if any operand is nullable
  if (strictness) {
    const leftNullable = expr.lexpr ? isNullableNode(expr.lexpr, strictness, nullableCols) : false;
    const rightNullable = expr.rexpr ? isNullableNode(expr.rexpr, strictness, nullableCols) : false;
    if (leftNullable || rightNullable) return true;
  }

  return false;
}

// ── Known aggregates / window functions ─────────────────
// These are from SQL spec, not pg_proc — they return null
// on zero rows regardless of strictness.

const NULLABLE_AGGREGATES = new Set([
  "max", "min", "sum", "avg",
  "string_agg", "array_agg",
  "json_agg", "jsonb_agg",
  "json_object_agg", "jsonb_object_agg",
  "xmlagg",
  "every", "bool_and", "bool_or",
  "bit_and", "bit_or",
]);

const NULLABLE_WINDOW_FNS = new Set([
  "lag", "lead",
  "first_value", "last_value", "nth_value",
]);
