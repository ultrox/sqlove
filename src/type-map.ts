import type pg from "pg";
import type { TsType, EnumDef } from "./types.js";

// ── Well-known OIDs ─────────────────────────────────────────────────────────

const BUILTIN: Record<number, TsType> = {
  16:   { schema: "Schema.Boolean",        tsAnnotation: "boolean",                  isArray: false },
  17:   { schema: "Schema.instanceOf(Buffer)", tsAnnotation: "Buffer",               isArray: false },
  18:   { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // char
  19:   { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // name
  20:   { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // int8 (bigint → string)
  21:   { schema: "Schema.Number",         tsAnnotation: "number",                   isArray: false }, // int2
  23:   { schema: "Schema.Number",         tsAnnotation: "number",                   isArray: false }, // int4
  25:   { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // text
  26:   { schema: "Schema.Number",         tsAnnotation: "number",                   isArray: false }, // oid
  114:  { schema: "Schema.Unknown",        tsAnnotation: "unknown",                  isArray: false }, // json
  142:  { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // xml
  700:  { schema: "Schema.Number",         tsAnnotation: "number",                   isArray: false }, // float4
  701:  { schema: "Schema.Number",         tsAnnotation: "number",                   isArray: false }, // float8
  790:  { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // money
  1042: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // bpchar
  1043: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // varchar
  1082: { schema: "Schema.DateFromString", tsAnnotation: "Date",                     isArray: false }, // date
  1083: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // time
  1114: { schema: "Schema.DateFromString", tsAnnotation: "Date",                     isArray: false }, // timestamp
  1184: { schema: "Schema.DateFromString", tsAnnotation: "Date",                     isArray: false }, // timestamptz
  1186: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // interval
  1266: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // timetz
  1700: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // numeric
  2950: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // uuid
  3802: { schema: "Schema.Unknown",        tsAnnotation: "unknown",                  isArray: false }, // jsonb
  3614: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // tsvector
  3615: { schema: "Schema.String",         tsAnnotation: "string",                   isArray: false }, // tsquery
};

// Known array OID → element OID
const ARRAY_ELEMENT: Record<number, number> = {
  1000: 16,    1001: 17,    1002: 18,    1003: 19,
  1005: 21,    1007: 23,    1009: 25,    1016: 20,
  1014: 1042,  1015: 1043,  1021: 700,   1022: 701,
  1028: 26,    1115: 1114,  1182: 1082,  1183: 1083,
  1185: 1184,  1231: 1700,  1270: 1266,
  199:  114,   2951: 2950,  3807: 3802,
};

// ── Resolver ────────────────────────────────────────────────────────────────

export class TypeResolver {
  private cache = new Map<number, TsType>();
  private enums = new Map<string, EnumDef>();

  constructor(private client: pg.Client) {
    for (const [oid, t] of Object.entries(BUILTIN)) {
      this.cache.set(Number(oid), t);
    }
  }

  resolve(oid: number): TsType | null {
    const cached = this.cache.get(oid);
    if (cached) return cached;

    // Check known array types
    const elemOid = ARRAY_ELEMENT[oid];
    if (elemOid !== undefined) {
      const elem = this.resolve(elemOid);
      if (!elem) return null;
      const arr: TsType = {
        schema: `Schema.Array(${elem.schema})`,
        tsAnnotation: `ReadonlyArray<${elem.tsAnnotation}>`,
        isArray: true,
      };
      this.cache.set(oid, arr);
      return arr;
    }

    return null;
  }

  getEnums(): EnumDef[] {
    return [...this.enums.values()];
  }

  /**
   * Batch-resolve unknown OIDs via pg_type and pg_enum.
   */
  async prefetch(oids: number[]): Promise<void> {
    const unknown = [...new Set(oids.filter((o) => !this.cache.has(o) && !(o in ARRAY_ELEMENT)))];
    if (unknown.length === 0) return;

    const { rows } = await this.client.query<{
      oid: number;
      typname: string;
      typtype: string;
      typelem: number;
      typarray: number;
      typbasetype: number;
    }>(
      `SELECT oid::int, typname, typtype, typelem::int, typarray::int, typbasetype::int
       FROM pg_type WHERE oid = ANY($1::oid[])`,
      [unknown]
    );

    const enumOids: number[] = [];

    for (const row of rows) {
      if (row.typtype === "e") {
        enumOids.push(row.oid);
      } else if (row.typelem !== 0 && row.typname.startsWith("_")) {
        // Dynamic array type
        ARRAY_ELEMENT[row.oid] = row.typelem;
      } else if (row.typbasetype !== 0) {
        // Domain → resolve to base
        await this.prefetch([row.typbasetype]);
        const base = this.resolve(row.typbasetype);
        if (base) this.cache.set(row.oid, base);
      } else {
        this.cache.set(row.oid, { schema: "Schema.Unknown", tsAnnotation: "unknown", isArray: false });
      }
    }

    if (enumOids.length > 0) {
      const enumResult = await this.client.query<{
        enumtypid: number;
        enumlabel: string;
      }>(
        `SELECT enumtypid::int, enumlabel FROM pg_enum
         WHERE enumtypid = ANY($1::oid[]) ORDER BY enumtypid, enumsortorder`,
        [enumOids]
      );

      const variantsByOid = new Map<number, string[]>();
      for (const r of enumResult.rows) {
        let v = variantsByOid.get(r.enumtypid);
        if (!v) { v = []; variantsByOid.set(r.enumtypid, v); }
        v.push(r.enumlabel);
      }

      for (const row of rows) {
        if (row.typtype !== "e") continue;
        const variants = variantsByOid.get(row.oid) ?? [];
        const name = snakeToPascal(row.typname);
        const enumDef: EnumDef = { name, pgName: row.typname, variants };
        this.enums.set(row.typname, enumDef);

        const literalArgs = variants.map((v) => `"${v}"`).join(", ");
        this.cache.set(row.oid, {
          schema: name,
          tsAnnotation: name,
          isArray: false,
          enumDef,
        });

        if (row.typarray !== 0) {
          ARRAY_ELEMENT[row.typarray] = row.oid;
        }
      }
    }

    // Resolve any newly discovered array types
    for (const oid of unknown) {
      if (!this.cache.has(oid) && oid in ARRAY_ELEMENT) {
        const elemOid = ARRAY_ELEMENT[oid]!;
        await this.prefetch([elemOid]);
        const elem = this.resolve(elemOid);
        if (elem) {
          this.cache.set(oid, {
            schema: `Schema.Array(${elem.schema})`,
            tsAnnotation: `ReadonlyArray<${elem.tsAnnotation}>`,
            isArray: true,
          });
        }
      }
    }
  }
}

function snakeToPascal(s: string): string {
  return s
    .split("_")
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join("");
}
