/**
 * R-2185 — Ctrl+K: a company's phone typed as plain digits ("9876500031") found nothing,
 * while "98765 00031" worked.
 *
 * Why: the Companies group searches on the server with `col.ilike."%term%"` per typed word.
 * A number stored as "+91 98765 00031" does not CONTAIN "9876500031", so digits-only, the +91
 * form and a dashed form all missed; the spaced form only worked because its two words each
 * matched a piece. The company's own mobile (contact_mobile) was not searched at all.
 *
 * These tests build the real request (searchPaletteCustomers / searchPaletteContacts), parse
 * its or-groups with the data gateway's own parser (parseLogic — what runs on Cloud Run), and
 * evaluate them against a row the way Postgres does (ilike / ~*), so "found" here means the
 * filter the browser sends really matches the stored number.
 */
import { describe, expect, it } from "vitest";
import { parseLogic, type Condition, type Logic } from "@/server/postgrest/parse";
import { searchPaletteCustomers, searchPaletteContacts, paletteTerms } from "./palette-search";
import { customerKeywords } from "@/lib/search/keywords";

interface Call { table: string; or: string[]; eq: [string, string][] }

function fakeDb() {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, or: [], eq: [] };
      calls.push(call);
      const b = {
        select() { return b; },
        or(f: string) { call.or.push(f); return b; },
        eq(c: string, v: string) { call.eq.push([c, v]); return b; },
        neq() { return b; },
        order() { return b; },
        limit() { return Promise.resolve({ data: [], error: null }); },
      };
      return b;
    },
  };
  return { db: db as never, calls };
}

/** Postgres ILIKE / ~* on one value, the way the gateway's build.ts renders them. */
function condHolds(c: Condition, row: Record<string, string | null>): boolean {
  const v = row[c.column];
  if (v === null || v === undefined) return false;
  const pat = String(c.value);
  if (c.op === "ilike") {
    const re = new RegExp(
      "^" + pat.replace(/\*/g, "%").split("%").map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$",
      "is",
    );
    return re.test(v);
  }
  if (c.op === "imatch") return new RegExp(pat, "i").test(v);
  throw new Error(`op ${c.op} not expected in a palette search`);
}
function logicHolds(l: Logic, row: Record<string, string | null>): boolean {
  const results = l.items.map((i) => (i.kind === "logic" ? logicHolds(i, row) : condHolds(i, row)));
  const out = l.op === "or" ? results.some(Boolean) : results.every(Boolean);
  return l.negate ? !out : out;
}
/** Every or-group the request sent (repeated `or` params are ANDed) holds for this row. */
function requestMatches(call: Call, row: Record<string, string | null>): boolean {
  return call.or.every((g) => logicHolds(parseLogic("or", false, `(${g})`), row));
}

const company = {
  id: "c1", tenant_id: "t1", name: "ABDCA Technologies", display_name: null, domain: "abdca.in",
  contact_name: "Rohit", contact_email: "rohit@abdca.in", contact_phone: "+91 98765 00031",
  contact_mobile: null, gstin: "07ABDCA0000A1Z5", customer_number: "CUS-00031",
};

async function customersFor(query: string, hide = false) {
  const { db, calls } = fakeDb();
  await searchPaletteCustomers(db, query, "t1", hide);
  return calls[0];
}

const FORMS = ["9876500031", "98765 00031", "+919876500031", "+91 98765 00031", "98765-00031", "098765 00031"];

describe("R-2185: Ctrl+K finds a company by its phone however it is typed", () => {
  for (const q of FORMS) {
    it(`"${q}" finds the company whose work phone is "+91 98765 00031"`, async () => {
      const call = await customersFor(q);
      expect(requestMatches(call, company)).toBe(true);
    });
  }

  for (const q of FORMS) {
    it(`"${q}" also finds a company whose number is stored bare ("9876500031")`, async () => {
      const call = await customersFor(q);
      expect(requestMatches(call, { ...company, contact_phone: "9876500031" })).toBe(true);
    });
  }

  it("the company's own mobile (contact_mobile) is searched too", async () => {
    const row = { ...company, contact_phone: null, contact_mobile: "+91-98765-00031" };
    for (const q of FORMS) expect(requestMatches(await customersFor(q), row), q).toBe(true);
  });

  it("a different number is not found (no loose digit-scatter match)", async () => {
    const call = await customersFor("9876500032");
    expect(requestMatches(call, company)).toBe(false);
    expect(requestMatches(await customersFor("9876500031"), { ...company, contact_phone: "+91 98765 10031" })).toBe(false);
  });

  it("names, domains and short numbers still search as before", async () => {
    expect(requestMatches(await customersFor("abdca tech"), company)).toBe(true);
    expect(requestMatches(await customersFor("00031"), company)).toBe(true);     // part of a number
    expect(requestMatches(await customersFor("cus-00031"), company)).toBe(true); // customer number
    expect(requestMatches(await customersFor("zzz"), company)).toBe(false);
  });

  it("the tenant filter is still on every request (no other company's rows)", async () => {
    for (const q of FORMS) expect((await customersFor(q)).eq).toContainEqual(["tenant_id", "t1"]);
  });

  it("R-1821: a role that sees masked contacts gets no hit by phone, and no phone/mobile column is filtered", async () => {
    for (const q of FORMS) {
      const call = await customersFor(q, true);
      expect(call.or.join(",")).not.toMatch(/contact_phone|contact_mobile|contact_email/);
      expect(requestMatches(call, company), q).toBe(false);
    }
  });

  it("contacts (contact book) match a phone typed digits-only too", async () => {
    const { db, calls } = fakeDb();
    await searchPaletteContacts(db, "9876500031", "t1");
    expect(requestMatches(calls[0], { full_name: "Rohit", email: null, phone: "+91 98765 00031", company: "ABDCA" })).toBe(true);
    const hidden = fakeDb();
    await searchPaletteContacts(hidden.db, "9876500031", "t1", true);
    expect(hidden.calls[0].or.join(",")).not.toMatch(/phone|email/);
  });

  it("other groups keep their plain word terms (a quote number typed with spaces is unchanged)", () => {
    expect(paletteTerms("2026 0042")).toEqual(["2026", "0042"]);
  });

  /* Review findings (code-review high, 7 Nov) — kept as tests. */
  it("letters never sit between matched digits: '7093' does not find a GSTIN 27AAPFU0939F1ZV", async () => {
    const row = { ...company, contact_phone: null, gstin: "27AAPFU0939F1ZV", name: "Plot 2, Sector 0, Block 26" };
    expect(requestMatches(await customersFor("7093"), row)).toBe(false);
    expect(requestMatches(await customersFor("2026"), row)).toBe(false);
  });

  it("a partial number typed with +91 finds a number stored without it", async () => {
    const bare = { ...company, contact_phone: "9876500031" };
    expect(requestMatches(await customersFor("+9198765"), bare)).toBe(true);
  });

  it("two numbers or a spaced reference are not squashed into one term", async () => {
    const call = await customersFor("98765 00031 98765 00032");
    expect(call.or.length).toBeGreaterThan(1);
    expect(requestMatches(await customersFor("2026 0042 1234"), { ...company, customer_number: "CUS-2026-0042-1234" })).toBe(true);
  });

  it("a non-phone column keeps plain ilike for a typed number (no regex on names / emails / GSTIN)", async () => {
    const call = await customersFor("9876500031");
    expect(call.or[0]).toMatch(/contact_phone\.imatch/);
    expect(call.or[0]).toMatch(/contact_mobile\.imatch/);
    expect(call.or[0]).not.toMatch(/(name|gstin|contact_email|domain|customer_number)\.imatch/);
  });

  it("a contact saved with only a WhatsApp number is found by it", async () => {
    const { db, calls } = fakeDb();
    await searchPaletteContacts(db, "98765 00031", "t1");
    expect(requestMatches(calls[0], { full_name: "Rohit", email: null, phone: null, whatsapp: "+919876500031", company: null })).toBe(true);
  });
});

describe("R-2185: keywords carry the company's phone and mobile as digits", () => {
  it("work phone '+91 98765 00031' → '9876500031'", () => {
    expect(customerKeywords({ contact_phone: "+91 98765 00031" })).toContain("9876500031");
  });
  it("mobile is indexed too", () => {
    expect(customerKeywords({ contact_mobile: "+91-98765-00031" } as never)).toContain("9876500031");
  });
});
