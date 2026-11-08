/**
 * R-2613 — Extend term reads the cuts (none), then a seat cut is saved before the quote is linked:
 * the database refuses the link (trigger subscriptions_r2613_quote_link_guard, rule N5). The
 * extension quote just inserted must not stay behind unlinked — paid, it would not renew this
 * subscription — so it is deleted and the refusal is returned as seat_cut_scheduled (409).
 */
import { describe, it, expect, vi } from "vitest";
import { createExtensionQuote } from "./create-extension-quote";

type Row = Record<string, unknown>;

function fakeSupabase(linkError: string | null) {
  const inserted: Row[] = [];
  const deleted: string[] = [];
  const supabase = {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      let mode = "";
      const filters: Record<string, unknown> = {};
      q.select = () => q;
      q.eq = (k: string, v: unknown) => { filters[k] = v; return q; };
      q.maybeSingle = async () => ({ data: table === "subscriptions" ? { renewal_quote_id: null } : null, error: null });
      q.insert = async (row: Row) => { inserted.push(row); return { error: null }; };
      q.update = () => { mode = "update"; return q; };
      q.delete = () => { mode = "delete"; return q; };
      q.then = (res: (v: unknown) => unknown) => {
        if (table === "subscription_seat_reductions") return res({ data: [], error: null });
        if (table === "subscriptions" && mode === "update") {
          return res({ error: linkError ? { message: linkError } : null });
        }
        if (table === "quotes" && mode === "delete") deleted.push(String(filters.id));
        return res({ error: null });
      };
      return q;
    },
    rpc: vi.fn(async () => ({ data: "Q-T1-0001", error: null })),
  };
  return { supabase: supabase as never, inserted, deleted };
}

const base = {
  subscriptionId: "S1", tenantId: "T1", customerId: "C1", customerName: "HOK AG",
  plan: "Google Workspace Business Starter", seats: 10, mrr: 3000,
  renewalDate: "2026-12-01", startDate: "2025-12-01", termMonths: 12, graceDays: 7,
};

describe("R-2613 createExtensionQuote when the link is refused", () => {
  it("a cut saved after the check → link refused, the quote is deleted, 409 code", async () => {
    const f = fakeSupabase(
      "A seat cut to 7 seats is scheduled for 01 Dec 2026 — quote Q-T1-0001 is for 10 seats, so it was not linked to the subscription. Remove the cut in Manage seats first, or let the renewal happen with the cut.",
    );
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r).toMatchObject({ ok: false, code: "seat_cut_scheduled" });
    expect(r.ok ? "" : r.message).toContain("(quote Q-T1-0001 was removed)");
    expect(f.inserted).toHaveLength(1);
    expect(f.deleted).toEqual(["Q-T1-0001"]);
  });

  it("any other link failure → the quote is deleted too, insert_failed", async () => {
    const f = fakeSupabase("connection reset");
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r).toMatchObject({ ok: false, code: "insert_failed" });
    expect(f.deleted).toEqual(["Q-T1-0001"]);
  });

  it("link accepted → quote made, nothing deleted", async () => {
    const f = fakeSupabase(null);
    const r = await createExtensionQuote({ ...base, supabase: f.supabase, months: 3 });
    expect(r.ok).toBe(true);
    expect(f.deleted).toEqual([]);
  });
});
