/*
 * SQL AST analysis via libpg-query (Postgres's own parser as WASM).
 *
 * Used to detect expression nullability without regex.
 * The parser gives us typed AST nodes — FuncCall, CaseExpr,
 * SubLink, A_Expr, CoalesceExpr — so we check node types
 * instead of pattern-matching strings.
 */

import * as pg from "libpg-query";

let loaded = false;

/** Ensure the WASM module is loaded (once). */
async function ensureLoaded(): Promise<void> {
  if (!loaded) {
    await pg.loadModule();
    loaded = true;
  }
}

/** Aggregate functions that return null on zero rows. */
const NULLABLE_AGGREGATES = new Set([
  "max", "min", "sum", "avg",
  "string_agg", "array_agg",
  "json_agg", "jsonb_agg",
  "json_object_agg", "jsonb_object_agg",
  "xmlagg",
  "every", "bool_and", "bool_or",
  "bit_and", "bit_or",
]);

/** Window functions that return null at boundaries. */
const NULLABLE_WINDOW_FNS = new Set([
  "lag", "lead",
  "first_value", "last_value", "nth_value",
]);

/**
 * Parse a SELECT query and return which target columns
 * (by 0-based index) are nullable based on expression analysis.
 *
 * Detects:
 *   - Nullable aggregates (max, min, sum, avg, string_agg, etc.)
 *   - JSONB operators (->>, ->)
 *   - NULLIF
 *   - CASE with ELSE NULL or no ELSE
 *   - Scalar subqueries
 *   - lag/lead window functions
 *
 * Does NOT flag:
 *   - coalesce() — explicitly removes null
 *   - count() — always returns a number
 *   - Window aggregates (sum OVER) — partition always has rows
 */
export async function detectNullableExpressions(
  sql: string,
): Promise<Set<number>> {
  await ensureLoaded();

  const nullable = new Set<number>();

  try {
    const ast = pg.parseSync(sql);
    const stmt = ast.stmts?.[0]?.stmt;
    const select = stmt?.SelectStmt;
    if (!select?.targetList) return nullable;

    for (let i = 0; i < select.targetList.length; i++) {
      const resTarget = select.targetList[i]?.ResTarget;
      if (!resTarget?.val) continue;

      if (isNullableNode(resTarget.val)) {
        nullable.add(i);
      }
    }
  } catch {
    // Parse failure — return empty set, fall back to other detection
  }

  return nullable;
}

/**
 * Recursively check if an AST node can produce null.
 * Returns true if the expression is nullable.
 */
function isNullableNode(node: any): boolean {
  const type = Object.keys(node)[0];
  if (!type) return false;

  const val = node[type];

  switch (type) {
    case "FuncCall":
      return isFuncCallNullable(val);

    case "CoalesceExpr":
      // coalesce() explicitly removes null
      return false;

    case "CaseExpr":
      return isCaseNullable(val);

    case "SubLink":
      // Scalar subquery — can return null when no row matches
      return true;

    case "A_Expr":
      return isAExprNullable(val);

    case "TypeCast":
      // Cast preserves nullability of the inner expression
      if (val.arg) return isNullableNode(val.arg);
      return false;

    default:
      return false;
  }
}

function isFuncCallNullable(fc: any): boolean {
  const funcName = fc.funcname
    ?.map((n: any) => n.String?.sval)
    .filter(Boolean)
    .join(".")
    ?.toLowerCase();

  if (!funcName) return false;

  // Window functions: lag/lead are always nullable
  // Other window fns (sum OVER, avg OVER) are NOT nullable
  if (fc.over) {
    return NULLABLE_WINDOW_FNS.has(funcName);
  }

  // Regular aggregates that return null on zero rows
  return NULLABLE_AGGREGATES.has(funcName);
}

function isCaseNullable(ce: any): boolean {
  // No ELSE clause → implicit NULL
  if (!ce.defresult) return true;

  // ELSE NULL → explicitly null
  const def = ce.defresult;
  if (def.A_Const?.isnull) return true;

  // ELSE <expr> → check if that expr is nullable
  return isNullableNode(def);
}

function isAExprNullable(expr: any): boolean {
  // NULLIF
  if (expr.kind === "AEXPR_NULLIF") return true;

  // JSONB operators: -> and ->>
  const opName = expr.name?.[0]?.String?.sval;
  if (opName === "->>" || opName === "->") return true;

  return false;
}
