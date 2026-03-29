import { describe, it, expect } from "vitest";
import { TypeResolver } from "../src/internals/type-map.js";

// TypeResolver needs a pg.Client for prefetch, but resolve() works
// for builtin OIDs without any DB connection.
const resolver = new TypeResolver(null as any);

describe("type-map builtin OIDs", () => {
  const cases: [string, number, { schema: string; ts: string }][] = [
    ["bool",        16,   { schema: "Schema.Boolean",        ts: "boolean" }],
    ["int2",        21,   { schema: "Schema.Number",         ts: "number" }],
    ["int4",        23,   { schema: "Schema.Number",         ts: "number" }],
    ["int8",        20,   { schema: "Schema.String",         ts: "string" }],  // bigint safety
    ["text",        25,   { schema: "Schema.String",         ts: "string" }],
    ["varchar",     1043, { schema: "Schema.String",         ts: "string" }],
    ["float4",      700,  { schema: "Schema.Number",         ts: "number" }],
    ["float8",      701,  { schema: "Schema.Number",         ts: "number" }],
    ["numeric",     1700, { schema: "Schema.String",         ts: "string" }],  // precision safety
    ["uuid",        2950, { schema: "Schema.String",         ts: "string" }],
    ["json",        114,  { schema: "Schema.Unknown",        ts: "unknown" }],
    ["jsonb",       3802, { schema: "Schema.Unknown",        ts: "unknown" }],
    ["timestamp",   1114, { schema: "Schema.DateFromString", ts: "Date" }],
    ["timestamptz", 1184, { schema: "Schema.DateFromString", ts: "Date" }],
    ["bytea",       17,   { schema: "Schema.instanceOf(Buffer)", ts: "Buffer" }],
  ];

  for (const [name, oid, expected] of cases) {
    it(`maps ${name} (OID ${oid}) → ${expected.schema}`, () => {
      const result = resolver.resolve(oid);
      expect(result).not.toBeNull();
      expect(result!.schema).toBe(expected.schema);
      expect(result!.tsAnnotation).toBe(expected.ts);
    });
  }

  it("returns null for unknown OIDs", () => {
    expect(resolver.resolve(999999)).toBeNull();
  });

  describe("builtin array OIDs", () => {
    const arrayCases: [string, number, string][] = [
      ["int4[]",  1007, "Schema.Array(Schema.Number)"],
      ["text[]",  1009, "Schema.Array(Schema.String)"],
      ["bool[]",  1000, "Schema.Array(Schema.Boolean)"],
      ["uuid[]",  2951, "Schema.Array(Schema.String)"],
      ["jsonb[]", 3807, "Schema.Array(Schema.Unknown)"],
    ];

    for (const [name, oid, expectedSchema] of arrayCases) {
      it(`maps ${name} (OID ${oid}) → ${expectedSchema}`, () => {
        const result = resolver.resolve(oid);
        expect(result).not.toBeNull();
        expect(result!.schema).toBe(expectedSchema);
        expect(result!.isArray).toBe(true);
      });
    }
  });
});
