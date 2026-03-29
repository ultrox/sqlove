/** Raw SQL file discovered on disk */
export interface SqlFile {
  readonly filePath: string;
  readonly queryName: string;
  /** Directory containing the sql/ folder, relative to srcDir */
  readonly modulePath: string;
  readonly content: string;
}

/** Result of parsing a SQL file */
export interface ParsedQuery {
  readonly file: SqlFile;
  readonly docComment: string | null;
  /** SQL body with leading comments stripped */
  readonly sql: string;
  readonly paramCount: number;
  /** Inferred param names from SQL context: index → name */
  readonly paramHints: ReadonlyMap<number, string>;
  /** Params used in INSERT VALUES or SET assignments (could accept null) */
  readonly paramInsertOrSet: ReadonlySet<number>;
}

/** A column returned by the query, with resolved types */
export interface ResolvedColumn {
  readonly name: string;
  readonly oid: number;
  readonly tsType: TsType;
  readonly nullable: boolean;
}

/** A parameter ($1, $2...) with its resolved type */
export interface ResolvedParam {
  readonly index: number;
  /** Inferred name from SQL context, e.g. "email" from `WHERE email = $1` */
  readonly name: string;
  readonly oid: number;
  readonly tsType: TsType;
  /** Whether this param accepts null (target column is nullable in INSERT/SET) */
  readonly nullable: boolean;
}

/** Mapped TypeScript type information */
export interface TsType {
  /** Schema constructor, e.g. "Schema.String" */
  readonly schema: string;
  /** Plain TS annotation, e.g. "string" */
  readonly tsAnnotation: string;
  readonly isArray: boolean;
  readonly enumDef?: EnumDef | undefined;
}

export interface EnumDef {
  /** PascalCase name */
  readonly name: string;
  /** Original pg enum name */
  readonly pgName: string;
  readonly variants: readonly string[];
}

/** Fully typed query descriptor — ready for codegen */
export interface TypedQuery {
  readonly file: SqlFile;
  readonly docComment: string | null;
  readonly sql: string;
  readonly params: readonly ResolvedParam[];
  readonly columns: readonly ResolvedColumn[];
  /** INSERT/UPDATE/DELETE without RETURNING */
  readonly isMutation: boolean;
}

/** A generated module (one per sql/ directory) */
export interface GeneratedModule {
  readonly outputPath: string;
  readonly source: string;
  readonly queries: readonly TypedQuery[];
}

/** Raw protocol-level column description */
export interface RawColumnDesc {
  readonly name: string;
  readonly tableOID: number;
  readonly columnID: number;
  readonly dataTypeOID: number;
}

/** Raw protocol-level query description */
export interface RawQueryDesc {
  readonly paramOIDs: number[];
  readonly columns: RawColumnDesc[];
}
