/*
 * AST-based parameter name inference via libpg-query.
 *
 * Walks the SQL AST to find ParamRef ($1, $2, ...) nodes
 * and their neighboring ColumnRef nodes. Maps $N → column name.
 *
 * Covers:
 *   WHERE email = $1              → $1 = "email"
 *   WHERE r.refunded_at >= $2     → $2 = "refunded_at"
 *   WHERE name ILIKE $1           → $1 = "name"
 *   INSERT INTO t (a, b) VALUES ($1, $2) → $1 = "a", $2 = "b"
 *   SET name = $2, colour = $3   → $2 = "name", $3 = "colour"
 *
 * Also detects which params are INSERT/SET targets
 * (for nullable param inference).
 *
 * Requires loadModule() to be called once before use.
 */

import * as pgParser from "libpg-query";

let loaded = false;

export async function loadModule(): Promise<void> {
  if (!loaded) {
    await pgParser.loadModule();
    loaded = true;
  }
}

export function isLoaded(): boolean {
  return loaded;
}

// ── Public API ──────────────────────────────────────────

/**
 * Infer param names from SQL. Returns $N → column name map.
 * Returns empty map if AST module not loaded or parse fails.
 */
export function inferParamNames(
  sql: string,
  paramCount: number,
): Map<number, string> {
  const hints = new Map<number, string>();
  if (paramCount === 0 || !loaded) return hints;

  try {
    const ast = pgParser.parseSync(sql);
    const stmt = ast.stmts?.[0]?.stmt;
    if (!stmt) return hints;

    if (stmt.SelectStmt?.whereClause) {
      collectFromExpr(stmt.SelectStmt.whereClause, hints);
    }

    if (stmt.InsertStmt) {
      collectFromInsert(stmt.InsertStmt, hints);
    }

    if (stmt.UpdateStmt) {
      collectFromUpdate(stmt.UpdateStmt, hints);
      if (stmt.UpdateStmt.whereClause) {
        collectFromExpr(stmt.UpdateStmt.whereClause, hints);
      }
    }

    if (stmt.DeleteStmt?.whereClause) {
      collectFromExpr(stmt.DeleteStmt.whereClause, hints);
    }
  } catch {
    // parse failed — return empty
  }

  return hints;
}

/**
 * Detect which $N params are INSERT VALUES or SET targets.
 * These can inherit column nullability.
 */
export function inferInsertOrSetParams(
  sql: string,
  paramCount: number,
): Set<number> {
  const result = new Set<number>();
  if (paramCount === 0 || !loaded) return result;

  try {
    const ast = pgParser.parseSync(sql);
    const stmt = ast.stmts?.[0]?.stmt;
    if (!stmt) return result;

    if (stmt.InsertStmt) {
      const valuesLists = stmt.InsertStmt.selectStmt?.SelectStmt?.valuesLists;
      if (valuesLists) {
        const items = valuesLists[0]?.List?.items ?? [];
        for (const item of Array.isArray(items) ? items : []) {
          const num = extractParamNum(item);
          if (num) result.add(num);
        }
      }
    }

    if (stmt.UpdateStmt?.targetList) {
      for (const target of stmt.UpdateStmt.targetList) {
        const num = extractParamNum(target.ResTarget?.val);
        if (num) result.add(num);
      }
    }
  } catch {
    // parse failed — return empty
  }

  return result;
}

// ── AST walkers ─────────────────────────────────────────

/** Walk expression tree for ParamRef next to ColumnRef. */
function collectFromExpr(
  node: any,
  hints: Map<number, string>,
): void {
  if (!node || typeof node !== "object") return;

  if (node.A_Expr) {
    const expr = node.A_Expr;
    const rightParam = extractParamNum(expr.rexpr);
    const leftParam = extractParamNum(expr.lexpr);
    const leftCol = extractColName(expr.lexpr);
    const rightCol = extractColName(expr.rexpr);

    if (rightParam && leftCol && !hints.has(rightParam)) {
      hints.set(rightParam, leftCol);
    }
    if (leftParam && rightCol && !hints.has(leftParam)) {
      hints.set(leftParam, rightCol);
    }
  }

  if (node.BoolExpr?.args) {
    for (const arg of node.BoolExpr.args) {
      collectFromExpr(arg, hints);
    }
  }
}

/**
 * Extract ParamRef number, unwrapping TypeCast if present.
 * $1::user_role → TypeCast { arg: ParamRef { number: 1 } }
 */
function extractParamNum(node: any): number | null {
  if (!node) return null;
  if (node.ParamRef) return node.ParamRef.number;
  if (node.TypeCast?.arg?.ParamRef) return node.TypeCast.arg.ParamRef.number;
  return null;
}

/** INSERT INTO t (col1, col2) VALUES ($1, $2) → positional match. */
function collectFromInsert(
  insert: any,
  hints: Map<number, string>,
): void {
  const cols = insert.cols;
  const valuesLists = insert.selectStmt?.SelectStmt?.valuesLists;
  if (!cols || !valuesLists) return;

  const items = valuesLists[0]?.List?.items ?? [];
  const colNames: string[] = cols
    .map((c: any) => c.ResTarget?.name)
    .filter(Boolean);

  for (let i = 0; i < items.length && i < colNames.length; i++) {
    const paramNum = extractParamNum(items[i]);
    if (paramNum && !hints.has(paramNum)) {
      hints.set(paramNum, colNames[i]!.toLowerCase());
    }
  }
}

/** UPDATE SET col = $N → from ResTarget name. */
function collectFromUpdate(
  update: any,
  hints: Map<number, string>,
): void {
  if (!update.targetList) return;

  for (const target of update.targetList) {
    const name = target.ResTarget?.name;
    const paramNum = target.ResTarget?.val?.ParamRef?.number;
    if (name && paramNum && !hints.has(paramNum)) {
      hints.set(paramNum, name.toLowerCase());
    }
  }
}

/** Extract column name from ColumnRef (last field, handles t.col). */
function extractColName(node: any): string | null {
  if (!node?.ColumnRef?.fields) return null;
  const fields = node.ColumnRef.fields;
  const last = fields[fields.length - 1]?.String?.sval;
  return last?.toLowerCase() ?? null;
}
