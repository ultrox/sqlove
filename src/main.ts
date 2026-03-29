/*
 * Public API re-exports for library/programmatic use.
 */

export { run, check } from "./internals/_pipeline.js";
export { discover } from "./internals/discovery.js";
export { parse, validateQueryName } from "./internals/parser.js";
export { generate } from "./internals/codegen.js";
export type {
  SqlFile,
  ParsedQuery,
  TypedQuery,
  ResolvedColumn,
  ResolvedParam,
  TsType,
  EnumDef,
  GeneratedModule,
} from "./internals/types.js";
export type { SqloveError } from "./internals/errors.js";
export { formatError } from "./internals/errors.js";
