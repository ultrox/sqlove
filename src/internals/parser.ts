/*
 * Pure functions. No I/O, no DB.
 *
 * Takes a SqlFile, returns a ParsedQuery:
 *   - extracts leading -- comments → docComment
 *   - strips comments from SQL body
 *   - counts $N params (highest N wins)
 *   - infers param names via AST (param-inference.ts)
 *   - detects INSERT/SET params (for nullability)
 *
 * Also validates query names (must be snake_case).
 */

import type { ParsedQuery, SqlFile } from "./types.js";
import * as ParamInference from "./param-inference.js";

/**
 * Parse a SQL file: extract doc comments, SQL body, parameter count,
 * and infer parameter names from the AST.
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

  // Infer param names and INSERT/SET context via AST
  const paramHints = ParamInference.inferParamNames(sql, paramCount);
  const paramInsertOrSet = ParamInference.inferInsertOrSetParams(sql, paramCount);

  return { file, docComment, sql, paramCount, paramHints, paramInsertOrSet };
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

/** Load the AST parser module. Call once before parsing. */
export const loadParserModule = ParamInference.loadModule;
