/*
 * Pure functions. No I/O, no DB.
 *
 * Takes a SqlFile, returns a ParsedQuery:
 *   - extracts leading -- comments → docComment
 *   - strips comments from SQL body
 *   - counts $N params (highest N wins)
 *   - infers param names from SQL context
 *     WHERE email = $1 → "email"
 *     INSERT INTO t (a,b) VALUES ($1,$2) → "a","b"
 *     SET name = $2 → "name"
 *   - detects INSERT/SET params (for nullability)
 *
 * Also validates query names (must be snake_case).
 */

import type { ParsedQuery, SqlFile } from "./types.js";

/**
 * Parse a SQL file: extract doc comments, SQL body, parameter count,
 * and infer parameter names from SQL context.
 */
export function parse(file: SqlFile): ParsedQuery {
  const lines = file.content.split("\n");

  // Extract leading -- comments
  const commentLines: string[] = [];
  let bodyStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i]!.trim();
    if (trimmed.startsWith("--")) {
      commentLines.push(trimmed.slice(2).trim());
      bodyStart = i + 1;
    } else if (trimmed === "") {
      bodyStart = i + 1;
    } else {
      break;
    }
  }

  const sql = lines.slice(bodyStart).join("\n").trim();
  const docComment = commentLines.length > 0 ? commentLines.join("\n") : null;

  // Count parameters: find all $N placeholders
  const paramNums = new Set<number>();
  const paramRegex = /\$(\d+)/g;
  let match;
  while ((match = paramRegex.exec(sql)) !== null) {
    paramNums.add(Number(match[1]));
  }
  const paramCount = paramNums.size > 0 ? Math.max(...paramNums) : 0;

  // Infer param names and context from SQL
  const paramHints = inferParamNames(sql, paramCount);
  const paramInsertOrSet = inferInsertOrSetParams(sql, paramCount);

  return { file, docComment, sql, paramCount, paramHints, paramInsertOrSet };
}

/**
 * Detect which $N params are used in INSERT VALUES or SET assignments.
 * These target specific columns and can inherit column nullability.
 */
function inferInsertOrSetParams(sql: string, paramCount: number): Set<number> {
  const result = new Set<number>();
  if (paramCount === 0) return result;

  const norm = sql.replace(/\s+/g, " ");

  // INSERT INTO t (...) VALUES ($1, $2, ...)
  const insertRe = /INSERT\s+INTO\s+\w+\s*\([^)]+\)\s*VALUES\s*\(([^)]+)\)/i;
  const insertMatch = insertRe.exec(norm);
  if (insertMatch) {
    const vals = insertMatch[1]!.split(",").map((s) => s.trim());
    for (const v of vals) {
      const m = /^\$(\d+)/.exec(v);
      if (m) result.add(Number(m[1]));
    }
  }

  // SET col = $N
  const setRe = /\bSET\b\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i;
  const setMatch = setRe.exec(norm);
  if (setMatch) {
    const assignRe = /=\s*\$(\d+)/g;
    let m;
    while ((m = assignRe.exec(setMatch[1]!)) !== null) {
      result.add(Number(m[1]));
    }
  }

  return result;
}

/**
 * Infer parameter names from SQL patterns like:
 *   WHERE email = $1         → $1 = "email"
 *   WHERE age >= $2          → $2 = "age"
 *   WHERE name ILIKE $1      → $1 = "name"
 *   SET name = $2, colour=$3 → $2 = "name", $3 = "colour"
 *   INSERT INTO t (a, b) VALUES ($1, $2) → $1 = "a", $2 = "b"
 */
function inferParamNames(sql: string, paramCount: number): Map<number, string> {
  const hints = new Map<number, string>();
  if (paramCount === 0) return hints;

  // Normalize whitespace for easier matching
  const norm = sql.replace(/\s+/g, " ");

  // Pattern 1: column = $N, column > $N, column >= $N, etc.
  // Also handles: column LIKE $N, column ILIKE $N
  const comparisonRe = /(?:\w+\.)?(\w+)\s*(?:=|!=|<>|>=?|<=?|~~?\*?|!~~?\*?|(?:NOT\s+)?I?LIKE)\s*\$(\d+)/gi;
  let m;
  while ((m = comparisonRe.exec(norm)) !== null) {
    const col = m[1]!.toLowerCase();
    const idx = Number(m[2]);
    if (!isKeyword(col) && idx >= 1 && idx <= paramCount) {
      hints.set(idx, col);
    }
  }

  // Pattern 2: INSERT INTO t (col1, col2) VALUES ($1, $2)
  const insertRe = /INSERT\s+INTO\s+\w+\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i;
  const insertMatch = insertRe.exec(norm);
  if (insertMatch) {
    const cols = insertMatch[1]!.split(",").map((s) => s.trim().toLowerCase());
    const vals = insertMatch[2]!.split(",").map((s) => s.trim());
    for (let i = 0; i < vals.length && i < cols.length; i++) {
      const paramMatch = /^\$(\d+)/.exec(vals[i]!);
      if (paramMatch) {
        const idx = Number(paramMatch[1]);
        const col = cols[i]!;
        if (idx >= 1 && idx <= paramCount && /^\w+$/.test(col) && !isKeyword(col)) {
          // Don't overwrite if comparison pattern already set a better name
          if (!hints.has(idx)) hints.set(idx, col);
        }
      }
    }
  }

  // Pattern 3: SET col = $N (UPDATE statements)
  const setRe = /\bSET\b\s+([\s\S]*?)(?:\bWHERE\b|\bRETURNING\b|$)/i;
  const setMatch = setRe.exec(norm);
  if (setMatch) {
    const assignments = setMatch[1]!;
    const assignRe = /(\w+)\s*=\s*\$(\d+)/g;
    let am;
    while ((am = assignRe.exec(assignments)) !== null) {
      const col = am[1]!.toLowerCase();
      const idx = Number(am[2]);
      if (!isKeyword(col) && idx >= 1 && idx <= paramCount) {
        if (!hints.has(idx)) hints.set(idx, col);
      }
    }
  }

  return hints;
}

const SQL_KEYWORDS = new Set([
  "select", "from", "where", "and", "or", "not", "in", "is", "null",
  "true", "false", "insert", "into", "values", "update", "set", "delete",
  "order", "by", "limit", "offset", "group", "having", "join", "on",
  "left", "right", "inner", "outer", "full", "cross", "as", "case",
  "when", "then", "else", "end", "exists", "between", "like", "ilike",
  "asc", "desc", "distinct", "all", "any", "some", "union", "intersect",
  "except", "returning", "with", "recursive", "create", "alter", "drop",
  "table", "index", "type", "if", "cascade", "primary", "key", "foreign",
  "references", "default", "constraint", "unique", "check", "now",
]);

function isKeyword(word: string): boolean {
  return SQL_KEYWORDS.has(word.toLowerCase());
}

/**
 * Validate that a query name is a valid TypeScript identifier.
 */
export function validateQueryName(name: string): string | null {
  if (name.length === 0) return "empty name";
  if (/^\d/.test(name)) return "starts with a digit";
  if (!/^[a-z][a-z0-9_]*$/.test(name)) return "must be snake_case (lowercase letters, digits, underscores)";
  return null;
}
