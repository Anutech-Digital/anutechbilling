/**
 * R-2776 (mustBeforeH03 of R-2775, finding 4): what the model is offered as a tool's input schema must be
 * (a) valid for Claude's STRICT tool use — closed objects at every depth, only keywords it supports — and
 * (b) the same thing the private parser accepts. Every REAL registered tool is checked, so a new tool
 * cannot ship a schema that makes the API refuse every request.
 */
import { describe, it, expect, vi } from "vitest";
import { z } from "zod";

vi.mock("@/lib/supabase/server", () => ({ createClient: () => ({ supabaseKey: "x.e30.y", from: () => { throw new Error("no table"); } }) }));

const { defineHelpTool } = await import("./types");
const { HELP_TOOL_REGISTRY } = await import("./registry");

/** Keywords strict tool use accepts in an input schema (we emit no length / range keywords: the parser enforces those). */
const ALLOWED = new Set(["type", "properties", "required", "additionalProperties", "enum", "format", "anyOf", "items", "description", "const"]);
const FORMATS = new Set(["date-time", "time", "date", "duration", "email", "hostname", "uri", "ipv4", "ipv6", "uuid"]);
const TYPES = new Set(["object", "array", "string", "number", "integer", "boolean", "null"]);

function problems(s: unknown, path = "$", depth = 0): string[] {
  if (depth > 12) return [`${path}: too deep`];
  if (typeof s !== "object" || s === null || Array.isArray(s)) return [`${path}: schema is not an object`];
  const o = s as Record<string, unknown>;
  const out: string[] = [];
  for (const k of Object.keys(o)) if (!ALLOWED.has(k)) out.push(`${path}: unsupported keyword '${k}'`);
  if ("type" in o && !(typeof o.type === "string" && TYPES.has(o.type))) out.push(`${path}: bad type`);
  if (o.type === "object") {
    if (o.additionalProperties !== false) out.push(`${path}: object not closed (additionalProperties:false)`);
    const props = (o.properties ?? {}) as Record<string, unknown>;
    for (const [k, v] of Object.entries(props)) out.push(...problems(v, `${path}.${k}`, depth + 1));
    const req = Array.isArray(o.required) ? (o.required as unknown[]) : [];
    for (const r of req) if (!(typeof r === "string" && r in props)) out.push(`${path}: required '${String(r)}' is not a property`);
  }
  if (o.type === "array") {
    if (!o.items) out.push(`${path}: array without items`);
    else out.push(...problems(o.items, `${path}[]`, depth + 1));
  }
  if ("format" in o && !(typeof o.format === "string" && FORMATS.has(o.format))) out.push(`${path}: unsupported format '${String(o.format)}'`);
  if ("enum" in o) {
    const e = o.enum;
    if (!Array.isArray(e) || !e.length) out.push(`${path}: empty enum`);
    else {
      const ty = o.type;
      for (const v of e) {
        if (v === null && ty !== "null") out.push(`${path}: enum holds null but type is ${String(ty)} (contradictory)`);
        if (typeof v === "string" && ty !== "string") out.push(`${path}: enum string but type ${String(ty)}`);
      }
    }
  }
  if (Array.isArray(o.anyOf)) o.anyOf.forEach((v, i) => out.push(...problems(v, `${path}|${i}`, depth + 1)));
  else if ("anyOf" in o) out.push(`${path}: anyOf is not a list`);
  if (!("type" in o) && !("anyOf" in o) && !("enum" in o)) out.push(`${path}: no type`);
  return out;
}

const mk = (input: z.ZodTypeAny) => defineHelpTool({ name: "probe_tool", describe: "p", input, roles: ["owner"], tier: "read", page: "/customers", label: "Open", async run() { return { text: "x", sources: [] }; } } as never);

describe("every real registered tool offers a valid strict-tool schema", () => {
  const tools = HELP_TOOL_REGISTRY.values();
  it("the registry has tools", () => { expect(tools.length).toBeGreaterThanOrEqual(6); });
  for (const t of tools) {
    it(`${t.name}: closed objects at every depth, supported keywords only, top level is an object`, () => {
      const schema = t.inputSchema as Record<string, unknown>;
      expect(schema.type).toBe("object");
      expect(problems(schema)).toEqual([]);
    });
  }
  it("the checker itself finds the faults it is meant to find", () => {
    expect(problems({ type: "object", properties: {} })).toHaveLength(1);
    expect(problems({ type: "object", properties: { a: { type: "string", maxLength: 3 } }, additionalProperties: false })).toHaveLength(1);
    expect(problems({ type: "object", properties: { a: { type: "object", properties: {} } }, additionalProperties: false })).toHaveLength(1);
    expect(problems({ type: "object", properties: { a: { type: "string", enum: [null] } }, additionalProperties: false })).toHaveLength(1);
    expect(problems({ type: "object", properties: { a: { type: "string", format: "date-time-x" } }, additionalProperties: false })).toHaveLength(1);
  });
});

describe("the schema the model reads equals what the parser accepts", () => {
  it("a date or a null literal is refused at registration (the parser and the schema could not agree)", () => {
    expect(() => mk(z.object({ d: z.date() }).strict())).toThrow(/z\.date\(\)/);
    expect(() => mk(z.object({ d: z.date().optional() }).strict())).toThrow(/z\.date\(\)/);
    expect(() => mk(z.object({ d: z.null() }).strict())).toThrow(/null/);
    expect(() => mk(z.object({ d: z.literal(null) }).strict())).toThrow(/null/);
    expect(() => mk(z.object({ n: z.object({ d: z.array(z.date()) }).strict() }).strict())).toThrow(/z\.date\(\)/);
  });
  it("a date is a string with a regex: schema string, parser takes only YYYY-MM-DD", () => {
    const t = mk(z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict());
    expect(t.inputSchema).toMatchObject({ properties: { from: { type: "string" } }, required: ["from"] });
    expect(t.input.safeParse({ from: "2026-11-01" }).success).toBe(true);
    expect(t.input.safeParse({ from: "01/11/2026" }).success).toBe(false);
    expect(t.input.safeParse({ from: new Date() }).success).toBe(false);
  });
  it("an optional field wrapped in refine / nullable stays optional in the schema (as the parser has it)", () => {
    const t = mk(z.object({
      a: z.string().optional().refine((v) => v === undefined || v.length > 0),
      b: z.string().optional().nullable(),
      c: z.string().default("x"),
      d: z.string(),
    }).strict());
    const req = (t.inputSchema as { required: string[] }).required;
    expect(req).toEqual(["d"]);
    expect(t.input.safeParse({ d: "x" }).success).toBe(true);
    expect(t.input.safeParse({}).success).toBe(false);
  });
  it("nullable maps to anyOf with a null type, not a contradictory enum", () => {
    const t = mk(z.object({ n: z.string().nullable() }).strict());
    expect(t.inputSchema).toMatchObject({ properties: { n: { anyOf: [{ type: "string" }, { type: "null" }] } } });
    expect(problems(t.inputSchema)).toEqual([]);
  });
});
