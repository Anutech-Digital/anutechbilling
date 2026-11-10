/**
 * R-2648 — Extend term for a customer abroad: the extension quote started at 18% for everyone
 * (quoteStartTaxRate only), so R-2636 later issued it as an export WITH payment of IGST. With an LUT
 * for the quote's FY it now starts at 0% (export without payment); without one it stays 18% as before.
 */
import { describe, it, expect, vi } from "vitest";
import { createExtensionQuote } from "./create-extension-quote";

type Row = Record<string, unknown>;

function fakeSupabase(opts: { customer: Row | null; luts: Row[] | null }) {
  const inserted: Row[] = [];
  const supabase = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => (table === "tenant_luts"
        ? Promise.resolve(opts.luts === null ? { data: null, error: { message: "boom" } } : { data: opts.luts, error: null })
        : q);
      q.maybeSingle = async () => ({
        data: table === "subscriptions" ? { renewal_quote_id: null } : table === "customers" ? opts.customer : null,
        error: null,
      });
      q.insert = async (row: Row) => { inserted.push(row); return { error: null }; };
      q.update = () => q;
      if (table === "subscription_seat_reductions") q.then = (res: (v: unknown) => unknown) => res({ data: [], error: null });
      return q;
    },
    rpc: vi.fn(async () => ({ data: "Q-T1-0002", error: null })),
  };
  return { supabase: supabase as never, inserted };
}

/* Any LUT row that covers "today" (IST) — FY rows for this year and the next, so the test never
   depends on the day it runs. */
function lutRowsCoveringToday(): Row[] {
  const y = new Date().getUTCFullYear();
  return [y - 1, y].map((s) => ({ fy_start: `${s}-04-01`, arn: `AD07${s}0001`, valid_from: `${s}-04-01`, valid_upto: `${s + 1}-03-31` }));
}

const base = {
  subscriptionId: "S1", tenantId: "T1", customerId: "C1", customerName: "Peak Performance LLC",
  plan: "Google Workspace Business Starter", seats: 10, mrr: 3000,
  renewalDate: "2027-12-01", startDate: "2026-12-01", termMonths: 12, graceDays: 7, years: 1,
};

describe("R-2648 createExtensionQuote for a customer abroad", () => {
  it("export with LUT: US customer + LUT for today's FY → quote at 0%, amount = subtotal", async () => {
    const f = fakeSupabase({ customer: { country: "United States", gst_treatment: "overseas" }, luts: lutRowsCoveringToday() });
    const r = await createExtensionQuote({ ...base, supabase: f.supabase });
    expect(r.ok).toBe(true);
    expect(f.inserted).toHaveLength(1);
    expect(f.inserted[0].tax_rate).toBe(0);
    expect(f.inserted[0].amount).toBe(f.inserted[0].subtotal);
  });

  it("no LUT keeps 18: US customer, no LUT on file → 18% as before (export with payment of IGST)", async () => {
    const f = fakeSupabase({ customer: { country: "United States", gst_treatment: "overseas" }, luts: [] });
    const r = await createExtensionQuote({ ...base, supabase: f.supabase });
    expect(r.ok).toBe(true);
    expect(f.inserted[0].tax_rate).toBe(18);
    expect(f.inserted[0].amount).toBe(Math.round((f.inserted[0].subtotal as number) * 1.18));
  });

  it("LUT read fails → 18% (never zero-rate on an unknown)", async () => {
    const f = fakeSupabase({ customer: { country: "UAE", gst_treatment: "overseas" }, luts: null });
    await createExtensionQuote({ ...base, supabase: f.supabase });
    expect(f.inserted[0].tax_rate).toBe(18);
  });

  it("Indian customer → 18% unchanged even with an LUT", async () => {
    const f = fakeSupabase({ customer: { country: "India", gst_treatment: "registered_regular" }, luts: lutRowsCoveringToday() });
    await createExtensionQuote({ ...base, supabase: f.supabase });
    expect(f.inserted[0].tax_rate).toBe(18);
  });
});
