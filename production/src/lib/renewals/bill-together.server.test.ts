/**
 * R-2807 — the DB half of Bill together on a fake client: reads are filtered to the caller's company (a non-uuid
 * is never sent), a live together proforma is found also for a NON-lead member (its part only on a line) with the
 * part's period, an invoiced part does not count, a failed next-part read says it in plain words, and laying
 * picks the preview's period, re-checks the holds right before writing, reprices only a freed part and marks a
 * new term's first part (R-2735) through layOnly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const st = vi.hoisted(() => ({
  tables: {} as Record<string, Array<Record<string, unknown>>>,
  filters: [] as Array<{ table: string; op: string; col: string; val: unknown }>,
  updates: [] as Array<{ table: string; values: Record<string, unknown> }>,
  syncCalls: [] as Array<Record<string, unknown>>,
  layInserts: [] as Array<Record<string, unknown>>,
  previewFails: false,
  price: null as null | { from: number; to: number },
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcAnswer: (() => ({ data: null, error: null })) as (name: string, args: Record<string, unknown>) => { data: unknown; error: null | { code?: string; message: string } },
  priceCalls: 0,
}));

vi.mock("./bill-next.server", () => ({
  billNextPreview: async (_db: unknown, sub: { id: string }) => {
    if (st.previewFails) throw new Error("permission denied for table subscription_billings");
    return {
      cycle: "monthly", seats: 10, seatRate: 161, partTaxable: 1610, taxRate: 18, unpaidEarlier: [],
      amounts: { taxable: 1610, tax: 290, gross: 1900 }, firstStart: "2026-10-12",
      periods: [{ start: sub.id.endsWith("b") ? "2026-11-12" : "2026-10-12", end: "2026-11-11", existing: null }],
    };
  },
}));
vi.mock("@/lib/billing/sync-instalments.server", () => ({
  INSTALMENT_SUB_SELECT: "id, tenant_id, quote_id, mrr, billing_cycle, term_months, term_amount, start_date, renewal_date",
  readQuotePaymentFacts: async () => undefined,
  unbilledPartPrice: async () => { st.priceCalls++; return st.price; },
  syncSubscriptionInstalments: async (args: Record<string, unknown>) => {
    st.syncCalls.push(args);
    for (const r of st.layInserts) st.tables.subscription_billings.push(r);
    return { skip: null };
  },
}));

import { readTogetherFacts, fillNextParts, layTogetherPart, TogetherRefusal, billTogetherReady, findInvoicedTogether, INVOICED_RETRY_MINUTES,
  type TogetherSubRow } from "./bill-together.server";

/** A tiny PostgREST-like fake: eq / in / is / not filters on in-memory rows; update records its values. */
function fakeDb(): SupabaseClient {
  return {
    rpc: async (name: string, args: Record<string, unknown>) => { st.rpcCalls.push({ name, args }); return st.rpcAnswer(name, args); },
    from(table: string) {
      const preds: Array<(r: Record<string, unknown>) => boolean> = [];
      let update: Record<string, unknown> | null = null;
      const rec = (op: string, col: string, val: unknown) => st.filters.push({ table, op, col, val });
      const rows = () => (st.tables[table] ?? []).filter((r) => preds.every((p) => p(r)));
      const q = {
        select: () => q,
        order: () => q,
        limit: () => q,
        update: (v: Record<string, unknown>) => { update = v; return q; },
        eq: (c: string, v: unknown) => { rec("eq", c, v); preds.push((r) => r[c] === v); return q; },
        in: (c: string, v: unknown[]) => { rec("in", c, v); preds.push((r) => v.includes(r[c])); return q; },
        is: (c: string, v: unknown) => { preds.push((r) => (r[c] ?? null) === v); return q; },
        /* only "prefix%" patterns are used */
        like: (c: string, v: string) => { rec("like", c, v); preds.push((r) => String(r[c] ?? "").startsWith(v.replace(/%$/, ""))); return q; },
        gte: (c: string, v: string) => { rec("gte", c, v); preds.push((r) => String(r[c]) >= v); return q; },
        not: (c: string, op: string, v: string) => {
          if (op === "is") preds.push((r) => r[c] != null);
          else preds.push((r) => !v.replace(/[()]/g, "").split(",").includes(String(r[c])));
          return q;
        },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (res: (x: { data: unknown; error: null }) => unknown) => {
          if (update) {
            const hit = rows();
            for (const r of hit) Object.assign(r, update);
            st.updates.push({ table, values: update });
            return res({ data: hit, error: null });
          }
          return res({ data: rows(), error: null });
        },
      };
      return q;
    },
  } as unknown as SupabaseClient;
}

const T = "t-1";
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", B = "bbbbbbbb-bbbb-4aaa-8aaa-aaaaaaaaaaab";
const sub = (id: string, o: Record<string, unknown> = {}) => ({
  id, tenant_id: T, customer_id: "c-1", customer_name: "ITBUZZ", plan: id === A ? "Business Standard" : "Business Starter",
  seats: 10, mrr: 1610, billing_cycle: "monthly", term_months: 12, term_amount: null, start_date: "2025-10-12",
  renewal_date: "2026-10-11", renewal_quote_id: null, status: "active", auto_renew: true, billed_externally_until: null, quote_id: null, ...o,
});
const live = (id: string, lead: string, parts: string[]) => ({ id, tenant_id: T, customer_id: "c-1", status: "sent", subscription_billing_id: lead,
  cancelled_at: null, invoice_id: null, superseded_by: null, line_items: parts.map((p) => ({ billing_id: p })) });

beforeEach(() => {
  st.filters = []; st.updates = []; st.syncCalls = []; st.layInserts = []; st.previewFails = false; st.price = null;
  st.rpcCalls = []; st.rpcAnswer = () => ({ data: null, error: null }); st.priceCalls = 0;
  st.tables = { subscriptions: [sub(A), sub(B)], subscription_billings: [], quotes: [] };
});

describe("readTogetherFacts", () => {
  it("company-filtered reads; a non-uuid id is never sent; unknown → sub null", async () => {
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    const facts = await readTogetherFacts(fakeDb(), T, [A, "1; drop table", C]);
    expect(facts.map((f) => [f.id, !!f.sub])).toEqual([[A, true], ["1; drop table", false], [C, false]]);
    expect(st.filters.find((f) => f.table === "subscriptions" && f.op === "in")?.val).toEqual([A, C]);
    expect(st.filters).toContainEqual({ table: "subscriptions", op: "eq", col: "tenant_id", val: T });
  });

  it("another company's subscription id is not found (tenant filter)", async () => {
    st.tables.subscriptions = [sub(A, { tenant_id: "t-other" })];
    expect((await readTogetherFacts(fakeDb(), T, [A]))[0].sub).toBeNull();
  });

  it("a live together proforma is found for the lead AND the member named only on a line, with the part's period", async () => {
    st.tables.subscription_billings = [
      { id: "p-a", tenant_id: T, subscription_id: A, invoice_id: null, period_start: "2026-10-12" },
      { id: "p-b", tenant_id: T, subscription_id: B, invoice_id: null, period_start: "2026-10-12" },
    ];
    st.tables.quotes = [live("PI-1", "p-a", ["p-a", "p-b"])];
    const [fa, fb] = await readTogetherFacts(fakeDb(), T, [A, B]);
    expect(fa.togetherBills).toEqual([{ quoteId: "PI-1", status: "sent", subscriptionIds: [A, B], partPeriodStart: "2026-10-12", earliestOpen: true, withPlans: ["Business Starter"] }]);
    expect(fb.togetherBills[0]).toMatchObject({ quoteId: "PI-1", earliestOpen: true, withPlans: ["Business Standard"] });
  });

  it("an older open part makes the proforma's part NOT the earliest open one", async () => {
    st.tables.subscription_billings = [
      { id: "p-a0", tenant_id: T, subscription_id: A, invoice_id: null, period_start: "2026-09-12" },
      { id: "p-a", tenant_id: T, subscription_id: A, invoice_id: null, period_start: "2026-10-12" },
      { id: "p-b", tenant_id: T, subscription_id: B, invoice_id: null, period_start: "2026-10-12" },
    ];
    st.tables.quotes = [live("PI-1", "p-a", ["p-a", "p-b"])];
    const [fa, fb] = await readTogetherFacts(fakeDb(), T, [A, B]);
    expect(fa.togetherBills[0].earliestOpen).toBe(false);
    expect(fb.togetherBills[0].earliestOpen).toBe(true);
  });

  it("a cancelled / single-part request, or an invoiced part, is not a live together bill", async () => {
    st.tables.subscription_billings = [
      { id: "p-a", tenant_id: T, subscription_id: A, invoice_id: "INV-1", period_start: "2026-10-12" },
      { id: "p-b", tenant_id: T, subscription_id: B, invoice_id: null, period_start: "2026-10-12" },
    ];
    st.tables.quotes = [
      { ...live("PI-gone", "p-b", ["p-b", "p-a"]), cancelled_at: "2026-11-01" },
      live("PI-own", "p-b", ["p-b"]),
      live("PI-half", "p-a", ["p-a", "p-b"]),
    ];
    const facts = await readTogetherFacts(fakeDb(), T, [A, B]);
    expect(facts[0].togetherBills).toEqual([]);                     // its part on PI-half is invoiced
    expect(facts[1].togetherBills.map((t) => t.quoteId)).toEqual(["PI-half"]);
    expect(facts[1].togetherBills[0].subscriptionIds).toEqual([B]);
  });
});

describe("fillNextParts", () => {
  it("fills each billable sub's next part; skips a yearly one", async () => {
    st.tables.subscriptions = [sub(A), sub(B, { billing_cycle: "yearly" })];
    const facts = await fillNextParts(fakeDb(), await readTogetherFacts(fakeDb(), T, [A, B]), T);
    expect(facts[0].next).toMatchObject({ periodStart: "2026-10-12", periodEnd: "2026-11-11", taxable: 1610, taxRate: 18 });
    expect(facts[1].next).toBeNull();
  });

  it("a failed read is a plain phrase, never the database's text (§24)", async () => {
    st.previewFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [f] = await fillNextParts(fakeDb(), await readTogetherFacts(fakeDb(), T, [A]), T);
    expect(f.next).toBeNull();
    expect(f.nextError).toBe("its billing data could not be read");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe("layTogetherPart", () => {
  const row = (o: Record<string, unknown> = {}) => sub(A, o) as unknown as TogetherSubRow;
  const laid = (o: Record<string, unknown> = {}) => ({ id: "p-1", tenant_id: T, subscription_id: A, period_start: "2026-10-12", invoice_id: null, taxable_amount: 1610, ...o });

  it("an already laid part at the preview's period is returned as is — nothing laid, nothing repriced", async () => {
    st.tables.subscription_billings = [laid()];
    st.price = { from: 1610, to: 2000 };   // not freed → never applied
    expect(await layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).toBe("p-1");
    expect(st.syncCalls).toHaveLength(0);
    expect(st.updates).toHaveLength(0);
  });

  it("a FREED part (its proforma cancelled) is re-synced to today's seats × rate — the preview's figure (review F3)", async () => {
    st.tables.subscription_billings = [laid()];
    st.tables.quotes = [{ id: "PI-old", tenant_id: T, cancelled_part_billing_id: "p-1" }];
    st.price = { from: 1610, to: 2000 };
    expect(await layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).toBe("p-1");
    expect(st.updates).toEqual([{ table: "subscription_billings", values: expect.objectContaining({ taxable_amount: 2000 }) }]);
    expect(st.tables.subscription_billings[0].taxable_amount).toBe(2000);
  });

  it("an invoiced part, or two parts laid for that period → plain refusal", async () => {
    st.tables.subscription_billings = [laid({ invoice_id: "INV-9" })];
    await expect(layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).rejects.toThrow(/already has tax invoice INV-9/);
    st.tables.subscription_billings = [laid(), laid({ id: "p-2" })];
    await expect(layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).rejects.toThrow(/two parts laid/);
  });

  it("renewal_date moved, a renewal quote opened, or Won't renew since the preview → 'changed while billing', nothing laid (review F4)", async () => {
    for (const change of [{ renewal_date: "2027-10-11" }, { renewal_quote_id: "Q-9" }, { auto_renew: false }, { status: "suspended" }]) {
      st.tables.subscriptions = [sub(A, change)];
      await expect(layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).rejects.toThrow(TogetherRefusal);
    }
    expect(st.syncCalls).toHaveLength(0);
  });

  it("a part in the next term: laid layOnly as if renewed, with the R-2735 roll; returns the new row", async () => {
    st.layInserts = [laid({ id: "p-new" })];
    expect(await layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).toBe("p-new");
    expect(st.syncCalls).toHaveLength(1);
    expect(st.syncCalls[0]).toMatchObject({ layOnly: true, todayISO: "2026-11-14", termRoll: { from: "2026-10-11", to: "2027-10-11" },
      sub: { id: A, renewal_date: "2027-10-11" } });
  });

  it("nothing laid (e.g. billed elsewhere) → refusal naming Bill next part", async () => {
    await expect(layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).rejects.toThrow(/could not be laid.*Bill next part/);
  });
});

describe("R-2831 — sale-quote facts for the preview (first part of a sale, R-2092 siblings), read at the next part", () => {
  const S = "dddddddd-dddd-4ddd-8ddd-dddddddddddd", Y = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", O = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const bill = (id: string, subId: string, start: string, o: Record<string, unknown> = {}) =>
    ({ id, tenant_id: T, subscription_id: subId, period_start: start, period_index: 2, term_start: "2025-10-12", credited_invoice_ids: [], invoice_id: null, ...o });

  it("a sub sold on a sale quote: its part at the next period, earliest term, every same-quote sibling (counted flag, unbilled starts); unsold → none", async () => {
    st.tables.subscriptions = [
      sub(A, { quote_id: "Q-1" }), sub(B),
      { ...sub(S, { quote_id: "Q-1" }), plan: "Vault" },                         // counted sibling with an unbilled part
      { ...sub(Y, { quote_id: "Q-1", billing_cycle: "yearly" }), plan: "Yearly" }, // same quote, not counted
      { ...sub(O, { quote_id: "Q-1", tenant_id: "t-other" }), plan: "Theirs" },  // other company → never read
    ];
    st.tables.subscription_billings = [
      bill("p-a0", A, "2025-10-12", { period_index: 1, invoice_id: "INV-1" }),
      bill("p-a1", A, "2026-10-12", { period_index: 1, term_start: "2026-10-12" }),
      bill("p-s1", S, "2026-10-12", { term_start: "2026-10-12" }),
      bill("p-o1", O, "2026-10-12", { tenant_id: "t-other" }),
    ];
    const [fa, fb] = await fillNextParts(fakeDb(), await readTogetherFacts(fakeDb(), T, [A, B]), T);
    expect(fb.sale).toBeUndefined();
    expect(fa.sale).toEqual({
      quoteId: "Q-1", startDate: "2025-10-12", termMonths: 12, firstTermStart: "2025-10-12",
      atNext: { periodIndex: 1, termStart: "2026-10-12", credited: false },
      siblings: [
        { id: S, plan: "Vault", counted: true, billedExternallyUntil: null, laidAny: true, openPeriodStarts: ["2026-10-12"] },
        { id: Y, plan: "Yearly", counted: false, billedExternallyUntil: null, laidAny: false, openPeriodStarts: [] },
      ],
    });
    // bounded reads only: the parts AT the next periods, unbilled parts, one earliest-term row
    const billingIns = st.filters.filter((f) => f.table === "subscription_billings" && f.op === "in" && f.col === "period_start");
    expect(billingIns).toEqual([{ table: "subscription_billings", op: "in", col: "period_start", val: ["2026-10-12"] }]);
  });

  it("a counted sibling with no unbilled part: one existence row decides laidAny", async () => {
    st.tables.subscriptions = [sub(A, { quote_id: "Q-1" }), { ...sub(S, { quote_id: "Q-1" }), plan: "Vault" }];
    st.tables.subscription_billings = [bill("p-s0", S, "2025-10-12", { invoice_id: "INV-3" })];
    let [fa] = await fillNextParts(fakeDb(), await readTogetherFacts(fakeDb(), T, [A]), T);
    expect(fa.sale?.siblings[0]).toMatchObject({ id: S, laidAny: true, openPeriodStarts: [] });
    st.tables.subscription_billings = [];
    [fa] = await fillNextParts(fakeDb(), await readTogetherFacts(fakeDb(), T, [A]), T);
    expect(fa.sale).toMatchObject({ firstTermStart: null, atNext: null, siblings: [{ id: S, laidAny: false }] });
  });
});

describe("R-2831 — findInvoicedTogether (retry after an invoice answer)", () => {
  const NOW = Date.parse("2026-11-15T03:30:00Z");
  const recent = "2026-11-15T03:25:00Z";
  const facts = async (ids = [A, B]) => readTogetherFacts(fakeDb(), T, ids);
  const pool = (o: Record<string, unknown> = {}) => ({ id: "PI-9", tenant_id: T, customer_id: "c-1", status: "expired", subscription_billing_id: "p-a",
    invoice_id: null, cancelled_at: null, superseded_by: null, created_at: recent, notes: "Billed together: Business Standard + Business Starter. Due on …",
    line_items: [{ billing_id: "p-a" }, { billing_id: "p-b" }], ...o });
  const parts = (inv: [string | null, string | null] = ["INV-5", "INV-5"]) => [
    { id: "p-a", tenant_id: T, subscription_id: A, invoice_id: inv[0], period_start: "2026-10-12" },
    { id: "p-b", tenant_id: T, subscription_id: B, invoice_id: inv[1], period_start: "2026-10-12" },
  ];
  const shown = (a = "2026-10-12", b = "2026-10-12") => new Map([[A, a], [B, b]]);

  it("periods the screen showed = the invoiced parts of ONE together request → that invoice, however long ago", async () => {
    st.tables.subscription_billings = parts();
    st.tables.quotes = [pool({ created_at: "2026-11-01T03:00:00Z" })];
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { periods: shown(), nowMs: NOW }))
      .toEqual({ quoteId: "PI-9", invoiceId: "INV-5", subscriptionIds: [A, B] });
  });

  it("periods: another part shown, a part not invoiced, or two invoices → null (the route then refuses the moved period)", async () => {
    st.tables.subscription_billings = parts();
    st.tables.quotes = [pool()];
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { periods: shown("2026-11-12"), nowMs: NOW })).toBeNull();
    st.tables.subscription_billings = parts(["INV-5", null]);
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { periods: shown(), nowMs: NOW })).toBeNull();
    st.tables.subscription_billings = parts(["INV-5", "INV-6"]);
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { periods: shown(), nowMs: NOW })).toBeNull();
  });

  it("no periods (older screen): a recent Bill together request closed as expired, both parts on its invoice → that invoice", async () => {
    st.tables.subscription_billings = parts();
    st.tables.quotes = [pool()];
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { nowMs: NOW })).toEqual({ quoteId: "PI-9", invoiceId: "INV-5", subscriptionIds: [A, B] });
    expect(st.filters).toContainEqual({ table: "quotes", op: "gte", col: "created_at", val: new Date(NOW - INVOICED_RETRY_MINUTES * 60_000).toISOString() });
    st.tables.quotes = [pool({ status: "accepted", invoice_id: "INV-5" })];
    expect((await findInvoicedTogether(fakeDb(), T, await facts(), { nowMs: NOW }))?.invoiceId).toBe("INV-5");
  });

  it("no periods, not a retry: older than the window / not a Bill together request (R-2092 Bill next part) / different set / another invoice / cancelled / open / unknown sub", async () => {
    st.tables.subscription_billings = parts();
    st.tables.quotes = [pool({ created_at: "2026-11-15T03:00:00Z" })];
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { nowMs: NOW })).toBeNull();
    st.tables.quotes = [pool({ notes: "Advance payment for month 2" })];
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { nowMs: NOW })).toBeNull();
    const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
    st.tables.subscriptions.push(sub(C));
    st.tables.quotes = [pool()];
    expect(await findInvoicedTogether(fakeDb(), T, await facts([A, B, C]), { nowMs: NOW })).toBeNull();
    st.tables.subscription_billings = parts(["INV-5", "INV-6"]);
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { nowMs: NOW })).toBeNull();
    st.tables.subscription_billings = parts();
    st.tables.quotes = [pool({ cancelled_at: "2026-11-15T03:26:00Z" })];
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { nowMs: NOW })).toBeNull();
    st.tables.quotes = [pool({ status: "sent" })];
    expect(await findInvoicedTogether(fakeDb(), T, await facts(), { nowMs: NOW })).toBeNull();
    st.tables.quotes = [pool()];
    expect(await findInvoicedTogether(fakeDb(), T, await facts([A, "dddddddd-dddd-4ddd-8ddd-dddddddddddd"]), { nowMs: NOW })).toBeNull();
  });
});

describe("R-2831 — billTogetherReady refuses the login before anything is laid", () => {
  it("not deployed → 503; 42501 → 403; 28000 → 401; 22023 (empty list) → ready", async () => {
    const ask = async (code: string, message: string) => { st.rpcAnswer = () => ({ data: null, error: { code, message } }); return billTogetherReady(fakeDb()); };
    expect(await ask("PGRST202", "Could not find the function")).toMatchObject({ ok: false, status: 503 });
    expect(await ask("42501", "Only an owner, manager, accountant or billing user can bill subscriptions together.")).toEqual({ ok: false, status: 403,
      error: "Only an owner, manager, accountant or billing user can bill subscriptions together." });
    expect(await ask("42501", "permission denied for function bill_parts_together")).toEqual({ ok: false, status: 403,
      error: "Your login may not bill subscriptions together — ask the workspace owner." });
    expect(await ask("28000", "No company on this login — sign in again.")).toMatchObject({ ok: false, status: 401 });
    expect(await ask("22023", "Pick at least two subscriptions to bill together.")).toEqual({ ok: true });
    expect(st.rpcCalls.every((c) => c.name === "bill_parts_together" && JSON.stringify(c.args) === JSON.stringify({ p_billing_ids: [] }))).toBe(true);
  });
});

describe("R-2831 — a freed part on a live request is never repriced", () => {
  const row = () => sub(A) as unknown as TogetherSubRow;
  const laid = { id: "p-1", tenant_id: T, subscription_id: A, period_start: "2026-10-12", invoice_id: null, taxable_amount: 1610 };

  it("part_live_request names a live request → amount kept, no price read", async () => {
    st.tables.subscription_billings = [{ ...laid }];
    st.tables.quotes = [{ id: "PI-old", tenant_id: T, cancelled_part_billing_id: "p-1" }];
    st.price = { from: 1610, to: 2000 };
    st.rpcAnswer = (name) => ({ data: name === "part_live_request" ? "PI-other" : null, error: null });
    expect(await layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).toBe("p-1");
    expect(st.rpcCalls).toEqual([{ name: "part_live_request", args: { p_tenant: T, p_part: "p-1" } }]);
    expect(st.priceCalls).toBe(0);
    expect(st.updates).toHaveLength(0);
    expect(st.tables.subscription_billings[0].taxable_amount).toBe(1610);
  });

  it("no live request → repriced as before (R-2541); the check failing → error, nothing repriced", async () => {
    st.tables.subscription_billings = [{ ...laid }];
    st.tables.quotes = [{ id: "PI-old", tenant_id: T, cancelled_part_billing_id: "p-1" }];
    st.price = { from: 1610, to: 2000 };
    expect(await layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).toBe("p-1");
    expect(st.tables.subscription_billings[0].taxable_amount).toBe(2000);
    st.tables.subscription_billings = [{ ...laid }];
    st.updates = [];
    st.rpcAnswer = () => ({ data: null, error: { code: "XX000", message: "boom" } });
    await expect(layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).rejects.toThrow(/boom/);
    expect(st.updates).toHaveLength(0);
  });

  it("a part never freed does not even ask (no extra call)", async () => {
    st.tables.subscription_billings = [{ ...laid }];
    expect(await layTogetherPart(fakeDb(), T, row(), "2026-10-12", "2026-11-14")).toBe("p-1");
    expect(st.rpcCalls).toHaveLength(0);
  });
});
