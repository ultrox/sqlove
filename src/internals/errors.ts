/*
 * Tagged union of every error sqlove can produce.
 * Constructors build them, formatError renders them
 * to ANSI-colored terminal output.
 * No error is ever thrown — they accumulate in arrays
 * so one bad query doesn't kill the whole run.
 */

export type FileReadErr = {
  readonly _tag: "FileReadError";
  readonly path: string;
  readonly cause: unknown;
};

export type ParseErr = {
  readonly _tag: "ParseError";
  readonly path: string;
  readonly message: string;
};

export type ConnectionErr = {
  readonly _tag: "ConnectionError";
  readonly message: string;
  readonly cause: unknown;
};

export type IntrospectionErr = {
  readonly _tag: "IntrospectionError";
  readonly queryName: string;
  readonly path: string;
  readonly message: string;
  readonly pgMessage?: string | undefined;
};

export type UnsupportedTypeErr = {
  readonly _tag: "UnsupportedType";
  readonly queryName: string;
  readonly oid: number;
  readonly pgTypeName?: string | undefined;
};

export type InvalidQueryNameErr = {
  readonly _tag: "InvalidQueryName";
  readonly path: string;
  readonly name: string;
  readonly reason: string;
};

export type WriteErr = {
  readonly _tag: "WriteError";
  readonly path: string;
  readonly cause: unknown;
};

export type CheckDriftErr = {
  readonly _tag: "CheckDriftError";
  readonly path: string;
  readonly message: string;
};

export type SqloveError =
  | FileReadErr
  | ParseErr
  | ConnectionErr
  | IntrospectionErr
  | UnsupportedTypeErr
  | InvalidQueryNameErr
  | WriteErr
  | CheckDriftErr;

// ── Constructors ────────────────────────────────────────

export const FileReadError = (
  path: string,
  cause: unknown,
): FileReadErr => ({
  _tag: "FileReadError",
  path,
  cause,
});

export const ParseError = (
  path: string,
  message: string,
): ParseErr => ({
  _tag: "ParseError",
  path,
  message,
});

export const ConnectionError = (
  message: string,
  cause: unknown,
): ConnectionErr => ({
  _tag: "ConnectionError",
  message,
  cause,
});

export const IntrospectionError = (
  queryName: string,
  path: string,
  message: string,
  pgMessage?: string,
): IntrospectionErr => ({
  _tag: "IntrospectionError",
  queryName,
  path,
  message,
  pgMessage,
});

export const UnsupportedType = (
  queryName: string,
  oid: number,
  pgTypeName?: string,
): UnsupportedTypeErr => ({
  _tag: "UnsupportedType",
  queryName,
  oid,
  pgTypeName,
});

export const InvalidQueryName = (
  path: string,
  name: string,
  reason: string,
): InvalidQueryNameErr => ({
  _tag: "InvalidQueryName",
  path,
  name,
  reason,
});

export const WriteError = (
  path: string,
  cause: unknown,
): WriteErr => ({
  _tag: "WriteError",
  path,
  cause,
});

export const CheckDriftError = (
  path: string,
  message: string,
): CheckDriftErr => ({
  _tag: "CheckDriftError",
  path,
  message,
});

// ── Formatting ──────────────────────────────────────────

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

const PRE = `${RED}✗${RESET}`;

export function formatError(error: SqloveError): string {
  switch (error._tag) {
    case "FileReadError":
      return `${PRE} ${error.path}\n  Could not read file: ${String(error.cause)}`;

    case "ParseError":
      return `${PRE} ${error.path}\n  ${error.message}`;

    case "ConnectionError":
      return `${PRE} Failed to connect to Postgres\n  ${error.message}`;

    case "IntrospectionError":
      return (
        `${PRE} ${error.path} ${DIM}(${error.queryName})${RESET}\n  ${error.message}` +
        (error.pgMessage ? `\n  ${YELLOW}${error.pgMessage}${RESET}` : "")
      );

    case "UnsupportedType":
      return (
        `${PRE} ${error.queryName}: unsupported type OID ${error.oid}` +
        (error.pgTypeName ? ` (${error.pgTypeName})` : "")
      );

    case "InvalidQueryName":
      return `${PRE} ${error.path}\n  Invalid query name "${error.name}": ${error.reason}`;

    case "WriteError":
      return `${PRE} ${error.path}\n  Could not write file: ${String(error.cause)}`;

    case "CheckDriftError":
      return `${PRE} ${error.path}\n  ${error.message}`;

    default: {
      const _enforce = error satisfies never;
      return `${PRE} Unknown error: ${_enforce}`;
    }
  }
}
