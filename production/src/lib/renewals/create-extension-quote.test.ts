/**
 * R-805 — createExtensionQuote writes the extension quote for years (unchanged) or months.
 * Pins what record_payment reads: is_renewal, is_extension, extension_months, subtotal and
 * amount (total incl. GST), and that subtotal + GST = total for a month quote.
 */
import { describe, it, expect, vi } from "vitest";
import { createExtensionQuote } from "./create-extension-quote";
import { grossAmount } from "@/lib/quotes/amounts";

type Row = Record<string, unknown>;

function fakeSupabase(openQuote: string | null = null) {
  const inserted: Row[] = [];
  const updated: Row[] = [];
  const supabase = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: table === "subscriptions" ? { renewal_quote_id: openQuote } : null, error: null });
      q.insert = async (row: Row) => { inserted.push(row); return { error: null }; };
      q.update = (row: Row) => { updated.push(row); return q; };
      return q;
    },
    rpc: vi.fn(async () => ({ data: "Q-T1-0001", error: null })),
  };
  return { supabase: supabase as never, inserted, updated };
}

const base = {
  subscriptionId: "S1", tenantId: "T1", customerId: "C1", customerName: "HOK AG",
  plan: "Google Workspace Business Starter", seats: 5, mrr: 1380,
  renewalDate: "2026-10-09", startDate: "2025-10-10", termMonths: 12, graceDays: 7,
};

describe("createExtensionQuote", () => {
  it("3 months: extension_months 3, price = annual per seat × seats × 3/12 + GST", async () => {
    const f = fakeSupabase();
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r).toEqual({ ok: true, quoteId: "Q-T1-0001", amount: 4885, years: null, months: 3 });
    const q = f.inserted[0];
    expect(q.is_renewal).toBe(true);
    expect(q.is_extension).toBe(true);
    expect(q.extension_months).toBe(3);
    expect(q.subtotal).toBe(4140);
    expect(q.amount).toBe(4885);
    expect(q.tax_rate).toBe(18);
    expect((q.line_items as Row[])[0]).toMatchObject({ name: "Google Workspace Business Starter · 3-month extension", qty: 5, rate: 828 });
    expect(q.notes).toContain("advances by 3 months (to 9 Jan 2027)");
    expect(f.updated[0]).toEqual({ renewal_quote_id: "Q-T1-0001" });
  });

  it("1 year: exactly as before — round(mrr × 12) and grossAmount, extension_months 12", async () => {
    const f = fakeSupabase();
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, years: 1 });
    expect(r).toEqual({ ok: true, quoteId: "Q-T1-0001", amount: grossAmount(16560, 18), years: 1, months: 12 });
    const q = f.inserted[0];
    expect(q.extension_months).toBe(12);
    expect(q.subtotal).toBe(16560);
    expect(q.amount).toBe(19541);
    expect((q.line_items as Row[])[0]).toMatchObject({ name: "Google Workspace Business Starter · 1-year extension", rate: 3312 });
  });

  it("2 years: extension_months 24", async () => {
    const f = fakeSupabase();
    await createExtensionQuote({ ...base, supabase: f.supabase, years: 2 });
    expect(f.inserted[0].extension_months).toBe(24);
    expect(f.inserted[0].subtotal).toBe(33120);
  });

  it.each([0, 12, 1.5])("months %s is refused before anything is written", async (m) => {
    const f = fakeSupabase();
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: m });
    expect(r.ok).toBe(false);
    expect(f.inserted).toEqual([]);
  });

  it("no length at all is refused", async () => {
    const f = fakeSupabase();
    const r = await createExtensionQuote({ ...base, supabase: f.supabase });
    expect(r).toMatchObject({ ok: false, code: "invalid_years" });
  });

  it("an open renewal/extension quote blocks a second one", async () => {
    const f = fakeSupabase("Q-OPEN");
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r).toMatchObject({ ok: false, code: "already_open" });
    expect(f.inserted).toEqual([]);
  });
});
