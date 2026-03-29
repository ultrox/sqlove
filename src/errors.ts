export type SqloveError =
  | {
      readonly _tag: "FileReadError";
      readonly path: string;
      readonly cause: unknown;
    }
  | {
      readonly _tag: "ParseError";
      readonly path: string;
      readonly message: string;
    }
  | {
      readonly _tag: "ConnectionError";
      readonly message: string;
      readonly cause: unknown;
    }
  | {
      readonly _tag: "IntrospectionError";
      readonly queryName: string;
      readonly path: string;
      readonly message: string;
      readonly pgMessage?: string | undefined;
    }
  | {
      readonly _tag: "UnsupportedType";
      readonly queryName: string;
      readonly oid: number;
      readonly pgTypeName?: string | undefined;
    }
  | {
      readonly _tag: "InvalidQueryName";
      readonly path: string;
      readonly name: string;
      readonly reason: string;
    }
  | {
      readonly _tag: "WriteError";
      readonly path: string;
      readonly cause: unknown;
    }
  | {
      readonly _tag: "CheckDriftError";
      readonly path: string;
      readonly message: string;
    };

// ── Constructors ────────────────────────────────────────────────────────────

export const FileReadError = (path: string, cause: unknown): SqloveError => ({
  _tag: "FileReadError",
  path,
  cause,
});

export const ParseError = (path: string, message: string): SqloveError => ({
  _tag: "ParseError",
  path,
  message,
});

export const ConnectionError = (
  message: string,
  cause: unknown,
): SqloveError => ({
  _tag: "ConnectionError",
  message,
  cause,
});

export const IntrospectionError = (
  queryName: string,
  path: string,
  message: string,
  pgMessage?: string,
): SqloveError => ({
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
): SqloveError => ({
  _tag: "UnsupportedType",
  queryName,
  oid,
  pgTypeName,
});

export const InvalidQueryName = (
  path: string,
  name: string,
  reason: string,
): SqloveError => ({
  _tag: "InvalidQueryName",
  path,
  name,
  reason,
});

export const WriteError = (path: string, cause: unknown): SqloveError => ({
  _tag: "WriteError",
  path,
  cause,
});

export const CheckDriftError = (
  path: string,
  message: string,
): SqloveError => ({
  _tag: "CheckDriftError",
  path,
  message,
});

// ── Formatting ──────────────────────────────────────────────────────────────

const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export function formatError(error: SqloveError): string {
  switch (error._tag) {
    case "FileReadError":
      return `${RED}✗${RESET} ${error.path}\n  Could not read file: ${String(error.cause)}`;
    case "ParseError":
      return `${RED}✗${RESET} ${error.path}\n  ${error.message}`;
    case "ConnectionError":
      return `${RED}✗${RESET} Failed to connect to Postgres\n  ${error.message}`;
    case "IntrospectionError":
      return (
        `${RED}✗${RESET} ${error.path} ${DIM}(${error.queryName})${RESET}\n  ${error.message}` +
        (error.pgMessage ? `\n  ${YELLOW}${error.pgMessage}${RESET}` : "")
      );
    case "UnsupportedType":
      return (
        `${RED}✗${RESET} ${error.queryName}: unsupported type OID ${error.oid}` +
        (error.pgTypeName ? ` (${error.pgTypeName})` : "")
      );
    case "InvalidQueryName":
      return `${RED}✗${RESET} ${error.path}\n  Invalid query name "${error.name}": ${error.reason}`;
    case "WriteError":
      return `${RED}✗${RESET} ${error.path}\n  Could not write file: ${String(error.cause)}`;
    case "CheckDriftError":
      return `${RED}✗${RESET} ${error.path}\n  ${error.message}`;
  }
}
