/*
 * WHERE clause null-rejection analysis.
 *
 * Determines which columns cannot be NULL in query results
 * because the WHERE clause would filter those rows out.
 *
 * Algorithm (from StarRocks / PostgreSQL's find_nonnullable_vars):
 *   For each column, substitute NULL into the WHERE predicate.
 *   If the predicate evaluates to FALSE or NULL → row filtered
 *   → column cannot be null in results.
 *
 * This handles ANY strict predicate, not just IS NOT NULL:
 *   WHERE bio IS NOT NULL       → bio non-null (obvious)
 *   WHERE length(bio) > 10      → bio non-null (length is strict)
 *   WHERE bio = 'hello'         → bio non-null (= is strict)
 *   WHERE bio LIKE '%test%'     → bio non-null (LIKE is strict)
 *
 * AND/OR rules (from PostgreSQL's planner):
 *   AND: if ANY conjunct rejects nulls → column non-null
 *   OR:  ALL disjuncts must reject nulls → column non-null
 *
 * This module is intentionally isolated. It depends only on
 * libpg-query for AST parsing. No database connection needed —
 * strictness is assumed for standard operators (=, <>, <, >, etc.)
 * since they are all strict in PostgreSQL.
 */

import * as pgParser from "libpg-query";

let loaded = false;

async function ensureLoaded(): Promise<void> {
  if (!loaded) {
    await pgParser.loadModule();
    loaded = true;
  }
}

/**
 * Given a SQL query and a set of columns known to be nullable
 * (from schema), return the subset that the WHERE clause
 * guarantees are non-null in the result.
 *
 * Returns column names (lowercase) that are proven non-null.
 */
export async function whereNonNullColumns(
  sql: string,
  nullableColumns: Set<string>,
): Promise<Set<string>> {
  await ensureLoaded();

  const nonNull = new Set<string>();
  if (nullableColumns.size === 0) return nonNull;

  try {
    const ast = pgParser.parseSync(sql);
    const where = ast.stmts?.[0]?.stmt?.SelectStmt?.whereClause;
    if (!where) return nonNull;

    for (const col of nullableColumns) {
      if (predicateRejectsNull(where, col)) {
        nonNull.add(col);
      }
    }
  } catch {
    // Parse failure — return empty, don't narrow anything
  }

  return nonNull;
}

/**
 * Does this predicate reject rows where `colName` is NULL?
 *
 * Substitute NULL for the column. If the predicate becomes
 * FALSE or NULL, the row is filtered → column is non-null.
 */
function predicateRejectsNull(node: any, colName: string): boolean {
  const type = Object.keys(node)[0];
  if (!type) return false;

  const val = node[type];

  switch (type) {
    case "BoolExpr":
      return boolExprRejectsNull(val, colName);

    case "NullTest":
      return nullTestRejectsNull(val, colName);

    case "A_Expr":
      return aExprRejectsNull(val, colName);

    case "FuncCall":
      // WHERE some_func(col) — if func is strict and col is
      // the target, then NULL col → NULL result → filtered.
      // We assume most WHERE functions are strict (conservative
      // for the common case).
      return funcCallReferencesCol(val, colName);

    case "BooleanTest":
      // WHERE col IS TRUE / IS FALSE / IS NOT UNKNOWN
      // These reject NULL.
      if (val.booltesttype === "IS_TRUE" ||
          val.booltesttype === "IS_FALSE" ||
          val.booltesttype === "IS_NOT_UNKNOWN") {
        return nodeReferencesCol(val.arg, colName);
      }
      return false;

    default:
      return false;
  }
}

/**
 * AND: any conjunct rejecting null → rejects null
 * OR: all disjuncts must reject null → rejects null
 */
function boolExprRejectsNull(
  expr: any,
  colName: string,
): boolean {
  const args: any[] = expr.args ?? [];

  switch (expr.boolop) {
    case "AND_EXPR":
      // Any arm rejects → whole AND rejects
      return args.some((arg: any) => predicateRejectsNull(arg, colName));

    case "OR_EXPR":
      // All arms must reject → whole OR rejects
      return args.length > 0 &&
        args.every((arg: any) => predicateRejectsNull(arg, colName));

    case "NOT_EXPR":
      // NOT doesn't change null-rejection for the inner expr
      // (NOT NULL → NULL → still filtered)
      return args.length > 0 && predicateRejectsNull(args[0], colName);

    default:
      return false;
  }
}

/**
 * IS NOT NULL directly rejects null.
 * IS NULL does NOT reject null (it selects null rows).
 */
function nullTestRejectsNull(expr: any, colName: string): boolean {
  if (expr.nulltesttype !== "IS_NOT_NULL") return false;
  return nodeReferencesCol(expr.arg, colName);
}

/**
 * Standard operators (=, <>, <, >, <=, >=, LIKE, ILIKE, etc.)
 * are all strict. If the target column is an operand,
 * NULL → NULL result → row filtered.
 */
function aExprRejectsNull(expr: any, colName: string): boolean {
  // Check if either side references the column
  const leftRefs = expr.lexpr ? nodeReferencesCol(expr.lexpr, colName) : false;
  const rightRefs = expr.rexpr ? nodeReferencesCol(expr.rexpr, colName) : false;
  return leftRefs || rightRefs;
}

/**
 * A function call in WHERE that references the column.
 * Most functions are strict — NULL in → NULL out → row filtered.
 */
function funcCallReferencesCol(fc: any, colName: string): boolean {
  const args: any[] = fc.args ?? [];
  return args.some((arg: any) => nodeReferencesCol(arg, colName));
}

/**
 * Does this AST node reference a specific column?
 * Checks ColumnRef nodes, handles qualified names (t.col).
 */
function nodeReferencesCol(node: any, colName: string): boolean {
  if (!node || typeof node !== "object") return false;

  // Direct column reference
  if (node.ColumnRef) {
    const fields = node.ColumnRef.fields ?? [];
    const lastField = fields[fields.length - 1]?.String?.sval?.toLowerCase();
    return lastField === colName;
  }

  // Recurse into child nodes
  for (const val of Object.values(node)) {
    if (Array.isArray(val)) {
      for (const item of val) {
        if (nodeReferencesCol(item, colName)) return true;
      }
    } else if (typeof val === "object" && val !== null) {
      if (nodeReferencesCol(val, colName)) return true;
    }
  }

  return false;
}
