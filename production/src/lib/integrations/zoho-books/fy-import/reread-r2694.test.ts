/**
 * R-2694 — "Read again" re-reads ONLY the customer payments whose stored facts cannot be imported as a
 * foreign receipt yet (coordinator: no SCAN_FACTS_VERSION bump for all ~2,300 rows — Zoho calls):
 *   - facts with no `currency` (read before R-2693) → re-read;
 *   - a foreign payment with no per-invoice foreign amounts (`foreignLines`, read before R-2694) → re-read;
 *   - an INR payment that has `currency`, or a foreign one with `foreignLines` → kept (no Zoho call).
 * Other kinds are never touched by this rule. The Supabase client is a recording fake; names made up.
 */
import { describe, it, expect } from "vitest";
import { supabaseScanStore, type FyImportDb } from "./store";
import { classifyListed, receiptFactsIncomplete, type KnownRow } from "./scan";

describe("R-2694 receiptFactsIncomplete", () => {
  it("no currency (before R-2693) → incomplete; INR with currency → complete", () => {
    expect(receiptFactsIncomplete({ currency: null, foreignLines: null })).toBe(true);
    expect(receiptFactsIncomplete({ currency: "INR", foreignLines: null })).toBe(false);
  });
  it("foreign without per-invoice foreign amounts (before R-2694) → incomplete; with them → complete", () => {
    expect(receiptFactsIncomplete({ currency: "USD", foreignLines: null })).toBe(true);
    expect(receiptFactsIncomplete({ currency: "USD", foreignLines: "[{\"zohoInvoiceId\":\"z1\",\"foreign\":100}]" })).toBe(false);
  });
});

describe("R-2694 classifyListed — an incomplete detail is read again, nothing else changes", () => {
  const prev = (over: Partial<KnownRow> = {}): KnownRow =>
    ({ status: "paid", fy: "2025-26", modified: "T1", detailedAt: "2026-11-01T00:00:00Z", hasDetail: true, accountId: "ZA", factsVersion: 0, ...over });
  const row = { zohoId: "p1", number: "p1", date: "2025-06-01", status: "paid", modified: "T1", accountId: "ZA" };
  it("unchanged + complete → kept; unchanged + incomplete → fresh", () => {
    expect(classifyListed(prev(), row, "2025-26")).toBe("kept");
    expect(classifyListed(prev({ factsIncomplete: true }), row, "2025-26")).toBe("fresh");
  });
});

function fakeDb(selectRows: Record<string, unknown>[]) {
  const calls: Array<{ op: string; arg?: unknown; filters: Array<[string, string, unknown]> }> = [];
  const db: FyImportDb = {
    from() {
      const c = { op: "", arg: undefined as unknown, filters: [] as Array<[string, string, unknown]> };
      calls.push(c);
      const q: Record<string, unknown> = {};
      const chain = (name: string) => (...a: unknown[]) => { c.filters.push([name, String(a[0]), a[1]]); return q; };
      for (const f of ["eq", "in", "lt", "is", "not", "order", "limit", "or"]) q[f] = chain(f);
      q.select = (...a: unknown[]) => { if (!c.op) c.op = "select"; c.filters.push(["select", String(a[0]), undefined]); return q; };
      for (const op of ["upsert", "update", "delete"]) q[op] = (arg?: unknown) => { c.op = op; c.arg = arg; return q; };
      q.then = (res: (v: unknown) => unknown) => res({ data: c.op === "select" ? selectRows : [], error: null });
      return q;
    },
  };
  return { db, calls };
}

describe("R-2694 supabaseScanStore.addListed — targeted re-read of receipts", () => {
  const known = (id: string, cur: string | null, lines: string | null) =>
    ({ zoho_id: id, zoho_status: "paid", fy: "2025-26", zoho_modified: "T1", detailed_at: "2026-11-01T00:00:00Z", deposit_account_id: "ZA", facts_version: 0, fx_cur: cur, fx_lines: lines });
  const row = (id: string) => ({ zohoId: id, number: id, date: "2025-06-01", status: "paid", modified: "T1", accountId: "ZA" });

  it("customer payments: only the old INR (no currency) and the USD without foreignLines are re-read", async () => {
    const { db, calls } = fakeDb([
      known("inr-old", null, null), known("inr-new", "INR", null),
      known("usd-part1", "USD", null), known("usd-new", "USD", "[{\"foreign\":1}]"),
    ]);
    await supabaseScanStore(db, "t1", "customerpayments").addListed("2025-26", ["inr-old", "inr-new", "usd-part1", "usd-new"].map(row));
    const sel = calls[0].filters.find(([k]) => k === "select")![1];
    expect(sel).toContain("fx_cur:payload->>currency");
    expect(sel).toContain("fx_lines:payload->>foreignLines");
    const ups = calls.filter((c) => c.op === "upsert");
    const fresh = ups.map((u) => u.arg as Array<Record<string, unknown>>).find((g) => g.some((r) => r.payload === null)) ?? [];
    expect(fresh.map((r) => r.zoho_id).sort()).toEqual(["inr-old", "usd-part1"]);
  });

  it("another kind (invoices) does not read payload fields and keeps an unchanged row", async () => {
    const { db, calls } = fakeDb([{ ...known("i1", null, null), fx_cur: undefined, fx_lines: undefined }]);
    await supabaseScanStore(db, "t1", "invoices").addListed("2025-26", [row("i1")]);
    const sel = calls[0].filters.find(([k]) => k === "select")![1];
    expect(sel).not.toContain("payload");
    const fresh = calls.filter((c) => c.op === "upsert").flatMap((u) => u.arg as Array<Record<string, unknown>>).filter((r) => r.payload === null);
    expect(fresh).toHaveLength(0);
  });
});
