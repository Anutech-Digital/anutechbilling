/**
 * R-2608 — Extend term while a seat cut is scheduled for this renewal: the extension quote would bill
 * every current seat (it does not read the cut), so it is refused with the cut named. A cut from
 * another term, a cancelled / applied row, or none → the quote is made as before.
 */
import { describe, it, expect, vi } from "vitest";
import { createExtensionQuote } from "./create-extension-quote";

type Row = Record<string, unknown>;

function fakeSupabase(cuts: Row[] | null) {
  const inserted: Row[] = [];
  const supabase = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = () => q;
      q.maybeSingle = async () => ({ data: table === "subscriptions" ? { renewal_quote_id: null } : null, error: null });
      q.insert = async (row: Row) => { inserted.push(row); return { error: null }; };
      q.update = () => q;
      if (table === "subscription_seat_reductions") {
        q.then = (res: (v: unknown) => unknown) =>
          res(cuts === null ? { data: null, error: { message: "boom" } } : { data: cuts, error: null });
      }
      return q;
    },
    rpc: vi.fn(async () => ({ data: "Q-T1-0001", error: null })),
  };
  return { supabase: supabase as never, inserted };
}

const base = {
  subscriptionId: "S1", tenantId: "T1", customerId: "C1", customerName: "HOK AG",
  plan: "Google Workspace Business Starter", seats: 10, mrr: 3000,
  renewalDate: "2026-12-01", startDate: "2025-12-01", termMonths: 12, graceDays: 7,
};
const cut = (o: Row = {}): Row => ({
  id: "cut-1", timing: "end_of_term", status: "scheduled", seats_before: 10, seats_after: 7,
  effective_date: "2026-12-01", ...o,
});

describe("R-2608 createExtensionQuote with a scheduled seat cut", () => {
  it("a cut scheduled for this renewal → refused, cut named, no quote made", async () => {
    const f = fakeSupabase([cut()]);
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r).toMatchObject({ ok: false, code: "seat_cut_scheduled" });
    expect(r.ok ? "" : r.message).toBe(
      "A seat cut to 7 seats is scheduled for 1 Dec 2026 — Extend term would bill all 10 seats. " +
      "Remove the cut in Manage seats first, or let the renewal happen with the cut.",
    );
    expect(f.inserted).toHaveLength(0);
  });

  it("the cuts could not be read → refused (never bill seats that may be cut)", async () => {
    const f = fakeSupabase(null);
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r).toMatchObject({ ok: false, code: "seat_cut_scheduled" });
    expect(f.inserted).toHaveLength(0);
  });

  it("a row for another term or a 'now' cut → quote made as before", async () => {
    const f = fakeSupabase([cut({ effective_date: "2025-12-01" }), cut({ id: "c2", timing: "now" })]);
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r.ok).toBe(true);
    expect(f.inserted).toHaveLength(1);
  });

  it("no cut → quote made as before", async () => {
    const f = fakeSupabase([]);
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, years: 1 });
    expect(r.ok).toBe(true);
  });
});
