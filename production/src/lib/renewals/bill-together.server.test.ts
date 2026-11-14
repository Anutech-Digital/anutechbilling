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
  unbilledPartPrice: async () => st.price,
  syncSubscriptionInstalments: async (args: Record<string, unknown>) => {
    st.syncCalls.push(args);
    for (const r of st.layInserts) st.tables.subscription_billings.push(r);
    return { skip: null };
  },
}));

import { readTogetherFacts, fillNextParts, layTogetherPart, TogetherRefusal, type TogetherSubRow } from "./bill-together.server";

/** A tiny PostgREST-like fake: eq / in / is / not filters on in-memory rows; update records its values. */
function fakeDb(): SupabaseClient {
  return {
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
    const facts = await fillNextParts(fakeDb(), await readTogetherFacts(fakeDb(), T, [A, B]));
    expect(facts[0].next).toMatchObject({ periodStart: "2026-10-12", periodEnd: "2026-11-11", taxable: 1610, taxRate: 18 });
    expect(facts[1].next).toBeNull();
  });

  it("a failed read is a plain phrase, never the database's text (§24)", async () => {
    st.previewFails = true;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const [f] = await fillNextParts(fakeDb(), await readTogetherFacts(fakeDb(), T, [A]));
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
