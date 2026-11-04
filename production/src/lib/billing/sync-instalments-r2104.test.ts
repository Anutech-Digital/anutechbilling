/**
 * R-2104 — a quote with ONE subscription billed in parts: the part is laid with the amount the
 * Record payment sheet asks. Q-R2101-CHK-B (3 seats × ₹1,002 a year, quarterly, local E2E Test
 * Co): the sheet asked ₹886 (₹3,006 ÷ 4 = ₹751 + GST), the part was laid from the MRR — ₹251 × 3 =
 * ₹753 → ₹889 — so a payment of exactly ₹886 raised no tax invoice.
 */
import { describe, it, expect } from "vitest";
import { instalmentGross, plannedInstalments, quotePeriodTaxables } from "./instalments";
import { splitExpectation } from "@/lib/payments/split-expected";
import { syncSubscriptionInstalments } from "./sync-instalments.server";

type Row = Record<string, unknown>;

/** A tiny PostgREST stand-in: rows filter on eq/in/is; inserts are kept. */
function fakeDb(tables: Record<string, Row[]>) {
  const from = (table: string) => {
    let rows = [...(tables[table] ?? [])];
    let inserted = false;
    const b: Record<string, unknown> = {
      select: () => b,
      eq: (c: string, v: unknown) => { rows = rows.filter((r) => r[c] === v); return b; },
      in: (c: string, v: unknown[]) => { rows = rows.filter((r) => v.includes(r[c])); return b; },
      is: (c: string, v: unknown) => { rows = rows.filter((r) => (r[c] ?? null) === v); return b; },
      neq: () => b, not: () => b, limit: () => b, order: () => b, update: () => b,
      insert: (xs: Row[]) => {
        inserted = true;
        for (const x of xs) (tables[table] ??= []).push({ id: `${String(x.subscription_id)}-${String(x.period_index)}`, invoice_id: null, ...x });
        return b;
      },
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      then: (res: (x: { data: Row[] | null; error: null }) => unknown) =>
        Promise.resolve({ data: inserted ? null : rows, error: null }).then(res),
    };
    return b;
  };
  const rpc = () => Promise.resolve({ data: null, error: null });
  return { from, rpc } as never;
}

const TODAY = "2026-10-29";
const quote = (seats: number, rate: number) => ({
  id: "Q-1", tenant_id: "t1", subtotal: seats * rate, discount_pct: 0, tax_rate: 18,
  amount: Math.round(seats * rate * 1.18), billing_cycle: "quarterly",
  line_items: [{ name: "Business Starter", qty: seats, rate, commitment: "annual_yearly" }],
  payment_amount: 0, invoice_id: null,
});
const sub = (id: string, mrr: number) => ({
  id, tenant_id: "t1", quote_id: "Q-1", mrr, billing_cycle: "quarterly" as const, term_months: 12,
  start_date: TODAY, renewal_date: "2027-10-29", status: "active",
  external_source: null, external_ref: null, billed_externally_until: null,
});
const sheetAsks = (q: ReturnType<typeof quote>) =>
  splitExpectation({ quote: q, termStart: TODAY, todayISO: TODAY, alreadyReceived: 0 })!.expected;
const laid = (q: ReturnType<typeof quote>, mrr: number, splitSubsOfQuote = 1) =>
  quotePeriodTaxables(plannedInstalments(sub("s1", mrr)), { mrr, cycle: "quarterly", quote: q, splitSubsOfQuote })
    .map((p) => p.taxableAmount);

describe("quotePeriodTaxables (R-2104)", () => {
  it("3 seats × ₹1,002 quarterly: parts ₹751/751/751/753 — Q1 gross = what the sheet asks (₹886)", () => {
    const q = quote(3, 1002);
    const parts = laid(q, 251);
    expect(parts).toEqual([751, 751, 751, 753]);
    expect(parts.reduce((s, x) => s + x, 0)).toBe(3006);
    expect(instalmentGross(parts[0], 18)).toBe(886);
    expect(sheetAsks(q)).toBe(886);
  });

  it("1 seat × ₹1,002: ₹250/250/250/252 (MRR ₹84 × 3 = ₹252 each before) — Q1 = sheet", () => {
    const q = quote(1, 1002);
    const parts = laid(q, 84);
    expect(parts).toEqual([250, 250, 250, 252]);
    expect(instalmentGross(parts[0], 18)).toBe(sheetAsks(q));
  });

  it("exact division (3 × ₹1,200): ₹900 each, same as before", () => {
    const q = quote(3, 1200);
    expect(laid(q, 300)).toEqual([900, 900, 900, 900]);
    expect(instalmentGross(900, 18)).toBe(sheetAsks(q));
  });

  it("a seat change since the sale (MRR 4 × ₹83.5) keeps the subscription's own figures", () => {
    expect(laid(quote(3, 1002), 334)).toEqual([1002, 1002, 1002, 1002]);
  });

  it("a quote with several subscriptions is left to billing_part_group (R-2092)", () => {
    expect(laid(quote(3, 1002), 251, 2)).toEqual([753, 753, 753, 753]);
  });
});

describe("syncSubscriptionInstalments lays the sheet's amount (R-2104)", () => {
  it("Q-R2101-CHK-B shape: the Q1 part laid is ₹751 taxable → ₹886, the figure the sheet asked", async () => {
    const q = quote(3, 1002);
    const tables: Record<string, Row[]> = {
      quotes: [q], subscriptions: [sub("s1", 251)], invoices: [], subscription_billings: [],
    };
    await syncSubscriptionInstalments({
      supabase: fakeDb(tables), sub: sub("s1", 251),
      quote: { amount: q.amount, payment_amount: 886, invoiced: false }, todayISO: TODAY, layOnly: true,
    });
    const parts = tables.subscription_billings
      .sort((a, b) => Number(a.period_index) - Number(b.period_index))
      .map((r) => r.taxable_amount);
    expect(parts).toEqual([751, 751, 751, 753]);
    expect(instalmentGross(parts[0] as number, 18)).toBe(sheetAsks(q));
  });
});
