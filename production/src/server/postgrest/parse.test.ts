import { describe, expect, it } from "vitest";
import { parseLogic, parseOpValue, parseQuery, type Condition, type Logic } from "./parse";
import { customerSearchOr } from "@/lib/queries/customers";

const cond = (l: Logic, i: number) => l.items[i] as Condition;

describe("R-467: quoted values inside or()/and() — unquoted like PostgREST", () => {
  it('or=(name.ilike."%a,b%") → value %a,b% (the comma stays inside the value)', () => {
    const l = parseLogic("or", false, '(name.ilike."%a,b%")');
    expect(l.items).toHaveLength(1);
    expect(cond(l, 0)).toMatchObject({ column: "name", op: "ilike", negate: false, value: "%a,b%" });
  });

  it('or=(name.ilike."%sharma%",contact_phone.ilike."%98123%") → no quotes reach SQL', () => {
    const l = parseLogic("or", false, '(name.ilike."%sharma%",contact_phone.ilike."%98123%")');
    expect(l.items.map((c) => (c as Condition).value)).toEqual(["%sharma%", "%98123%"]);
  });

  it('unescapes \\" and \\ inside a quoted value', () => {
    // PostgREST: a backslash escapes the next character, so a literal backslash is "\\".
    const l = parseLogic("or", false, String.raw`(name.eq."say \"hi\" \\ bye")`);
    expect(cond(l, 0).value).toBe(String.raw`say "hi" \ bye`);
  });

  it("not.op and nested and() are unquoted too; unquoted values unchanged", () => {
    const l = parseLogic("or", false, '(name.not.ilike."%x,y%",and(a.eq."1.5",b.is.null),c.eq.plain)');
    expect(cond(l, 0)).toMatchObject({ negate: true, op: "ilike", value: "%x,y%" });
    const inner = l.items[1] as Logic;
    expect(cond(inner, 0).value).toBe("1.5");
    expect(cond(inner, 1).value).toBe("null");
    expect(cond(l, 2).value).toBe("plain");
  });

  it("in.() inside a logic tree still parses its own quoted list", () => {
    const l = parseLogic("or", false, '(id.in.("a,b",c))');
    expect(cond(l, 0).value).toEqual(["a,b", "c"]);
  });

  it("a top-level filter keeps its value as sent (PostgREST does not unquote there)", () => {
    expect(parseOpValue("name", 'eq."x"').value).toBe('"x"');
  });

  it("the Customers search box end to end: URL → parse → every value without quotes", () => {
    const or = customerSearchOr(" Sharma, 98123 ")!;
    expect(or).toContain('contact_phone.ilike."%sharma, 98123%"');
    const q = parseQuery(new URLSearchParams({ select: "*", or: `(${or})` }));
    const l = q.scopes.get("")!.filters[0] as Logic;
    const values = l.items.map((c) => (c as Condition).value);
    expect(values).toHaveLength(6);
    for (const v of values) expect(v).toBe("%sharma, 98123%");
    expect(l.items.map((c) => (c as Condition).column)).toContain("contact_phone");
  });
});
