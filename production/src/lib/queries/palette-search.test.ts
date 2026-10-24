/**
 * R-1121 — the palette's searches ask for a few matching rows, never a whole table.
 * doneWhen: typing "ac" sends <= 6 requests of 8 rows, no full-table paging.
 */
import { describe, expect, it } from "vitest";
import {
  PALETTE_LIMIT, PALETTE_INVOICE_COLUMNS, paletteTerms, ilikeAny,
  searchPaletteCustomers, searchPaletteQuotes, searchPaletteInvoices,
  searchPaletteSubscriptions, searchPaletteContacts, searchPalettePayments,
} from "./palette-search";

interface Call { table: string; select?: string; or: string[]; eq: [string, string][]; neq: [string, string][]; limit?: number; range?: boolean }

/** A query-builder double that records what was asked. */
function fakeDb() {
  const calls: Call[] = [];
  const db = {
    from(table: string) {
      const call: Call = { table, or: [], eq: [], neq: [] };
      calls.push(call);
      const b = {
        select(cols: string) { call.select = cols; return b; },
        or(f: string) { call.or.push(f); return b; },
        eq(c: string, v: string) { call.eq.push([c, v]); return b; },
        neq(c: string, v: string) { call.neq.push([c, v]); return b; },
        order() { return b; },
        range() { call.range = true; return b; },
        limit(n: number) { call.limit = n; return Promise.resolve({ data: [], error: null }); },
      };
      return b;
    },
  };
  return { db: db as never, calls };
}

describe("paletteTerms", () => {
  it("splits words, lower-cases, drops LIKE wildcards and quotes", () => {
    expect(paletteTerms('  Acme  "Pvt%" * ')).toEqual(["acme", "pvt"]);
  });
  it("caps a pasted paragraph at four words", () => {
    expect(paletteTerms("a b c d e f")).toHaveLength(4);
  });
  it("empty → nothing", () => {
    expect(paletteTerms("   ")).toEqual([]);
  });
});

describe("ilikeAny", () => {
  it("quotes the value so a comma or bracket cannot split the filter", () => {
    expect(ilikeAny(["name", "domain"], "a,b")).toBe('name.ilike."%a,b%",domain.ilike."%a,b%"');
  });
});

describe("palette searches (R-1121)", () => {
  const searches = [
    ["customers", (db: never) => searchPaletteCustomers(db, "ac", "t1")],
    ["quotes", (db: never) => searchPaletteQuotes(db, "ac", "t1")],
    ["invoices", (db: never) => searchPaletteInvoices(db, "ac", "t1")],
    ["subscriptions", (db: never) => searchPaletteSubscriptions(db, "ac", "t1")],
    ["contacts", (db: never) => searchPaletteContacts(db, "ac", "t1")],
    ["payments", (db: never) => searchPalettePayments(db, "ac", [], "t1")],
  ] as const;

  for (const [table, run] of searches) {
    it(`${table}: one request, at most ${PALETTE_LIMIT} rows, filtered by the typed text and the tenant`, async () => {
      const { db, calls } = fakeDb();
      await run(db);
      expect(calls).toHaveLength(1);
      expect(calls[0].table).toBe(table);
      expect(calls[0].limit).toBe(8);
      expect(calls[0].range).toBeUndefined();               // no fetchAllRows paging
      expect(calls[0].or.join(",")).toContain('"%ac%"');
      expect(calls[0].eq).toContainEqual(["tenant_id", "t1"]);
    });
  }

  it("slim columns — not select('*') — except subscriptions, which Add seats needs whole", async () => {
    for (const [table, run] of searches) {
      const { db, calls } = fakeDb();
      await run(db);
      if (table === "subscriptions") continue;
      expect(calls[0].select).not.toBe("*");
    }
  });

  it("nothing typed → no request at all", async () => {
    const { db, calls } = fakeDb();
    expect(await searchPaletteCustomers(db, "  ")).toEqual([]);
    expect(await searchPalettePayments(db, "", [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("every typed word must match: one or-group per word", async () => {
    const { db, calls } = fakeDb();
    await searchPaletteCustomers(db, "acme delhi");
    expect(calls[0].or).toHaveLength(2);
    expect(calls[0].or[0]).toContain("%acme%");
    expect(calls[0].or[1]).toContain("%delhi%");
  });

  it("payments match the companies found, the reference, or the amount typed", async () => {
    const id = "11111111-2222-3333-4444-555555555555";
    const { db, calls } = fakeDb();
    await searchPalettePayments(db, "5000", [id, "not-a-uuid"]);
    const or = calls[0].or.join(",");
    expect(or).toContain('reference.ilike."%5000%"');
    expect(or).toContain("amount.eq.5000");
    expect(or).toContain(`customer_id.in.(${id})`);
    expect(or).not.toContain("not-a-uuid");
  });

  it("contacts leave out the hidden enquiry anchors, as the contact book does", async () => {
    const { db, calls } = fakeDb();
    await searchPaletteContacts(db, "rohit");
    expect(calls[0].neq).toContainEqual(["source", "enquiry"]);
  });
});

describe("R-1639: Ctrl+K finds a payment by receipt number and invoice number", () => {
  it("the receipt voucher number and the quote / imported-invoice id are searched on the server", async () => {
    const { db, calls } = fakeDb();
    await searchPalettePayments(db, "RV-2026-0042", [], "t1");
    const or = calls[0].or.join(",");
    expect(or).toContain('receipt_voucher_no.ilike."%rv-2026-0042%"');
    expect(or).toContain('quote_id.ilike."%rv-2026-0042%"');
    expect(or).toContain('invoice_id.ilike."%rv-2026-0042%"');
    expect(calls[0].eq).toContainEqual(["tenant_id", "t1"]);
  });

  it("a GST invoice the Invoices search found brings its payments (by its quote, or by the invoice itself)", async () => {
    const { db, calls } = fakeDb();
    await searchPalettePayments(db, "INV-2026-0031", [], "t1", [
      { id: "INV-2026-0031", quote_id: "Q-2026-0107" },
      { id: "zb-uuid-1", quote_id: null },
    ]);
    const or = calls[0].or.join(",");
    expect(or).toContain('quote_id.in.("Q-2026-0107")');
    expect(or).toContain('invoice_id.in.("INV-2026-0031","zb-uuid-1")');
  });

  it("a found payment is named from its quote's customer when it has no customer of its own", async () => {
    const tables: Record<string, unknown[]> = {
      payments: [{ id: "p1", amount: 500, method: "upi", reference: null, received_at: null, customer_id: null, quote_id: "Q-1", invoice_id: null, receipt_voucher_no: "RV-1" }],
      quotes: [{ id: "Q-1", customer_name: "Acme Pvt Ltd" }],
    };
    type Asked = { table: string; in?: [string, string[]]; eq: [string, string][] };
    const asked: Asked[] = [];
    const db = {
      from(table: string) {
        const call: Asked = { table, eq: [] };
        asked.push(call);
        const done = () => Promise.resolve({ data: tables[table] ?? [], error: null });
        const b = {
          select() { return b; }, or() { return b; }, order() { return b; },
          eq(c: string, v: string) { call.eq.push([c, v]); return b; },
          in(c: string, v: string[]) { call.in = [c, v]; return done(); },
          limit() { return done(); },
        };
        return b;
      },
    };
    const rows = await searchPalettePayments(db as never, "RV-1", [], "t1");
    expect(rows[0].customer_name).toBe("Acme Pvt Ltd");
    const q = asked.find((a) => a.table === "quotes");
    expect(q?.in).toEqual(["id", ["Q-1"]]);
    expect(q?.eq).toContainEqual(["tenant_id", "t1"]);
  });

  it("the invoices search returns quote_id, so the payment search can use it", () => {
    expect(PALETTE_INVOICE_COLUMNS).toContain("quote_id");
  });
});
