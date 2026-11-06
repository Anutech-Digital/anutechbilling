/**
 * R-2541 (chk-local, localhost 6 Nov 2026 — p0 money): a part freed by a cancelled proforma was billed
 * by the no-seats path (billing job → billFreedParts, or Bill next part with no seats/rate) at the
 * part's STORED amount — PI-F588-27-0004 asked 1 × ₹5,100 although the subscription is now
 * 18 × ₹300 = ₹5,400. A part with no tax invoice and no open proforma is now billed at the
 * subscription's CURRENT seats × rate — the same figure the term run re-syncs its unbilled parts to
 * and the Bill next part preview shows (one rule: repriceUnbilledPart).
 */
import { describe, it, expect } from "vitest";
import { billFreedParts, repriceUnbilledPart } from "./sync-instalments.server";
import { billNextPreview } from "@/lib/renewals/bill-next.server";
import { partAmounts } from "./proforma";

type Row = Record<string, unknown>;

/** A tiny in-memory PostgREST: select / eq / is / in / order / limit / maybeSingle / update, plus the two RPCs. */
function fakeDb(tables: Record<string, Row[]>) {
  const log: string[] = [];
  const updates: { table: string; id: unknown; patch: Row }[] = [];
  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let patch: Row | null = null;
    let limit: number | null = null;
    const rows = () => {
      const out = (tables[table] ?? []).filter((r) => filters.every((f) => f(r)));
      return limit == null ? out : out.slice(0, limit);
    };
    const run = () => {
      if (patch) {
        for (const r of rows()) { Object.assign(r, patch); updates.push({ table, id: r.id, patch }); log.push(`update ${table} ${String(r.id)}`); }
        return { data: null, error: null };
      }
      return { data: rows(), error: null };
    };
    const b = {
      select: () => b,
      update: (p: Row) => { patch = p; return b; },
      eq: (k: string, v: unknown) => { filters.push((r) => r[k] === v); return b; },
      is: (k: string, v: unknown) => { filters.push((r) => (r[k] ?? null) === v); return b; },
      in: (k: string, v: unknown[]) => { filters.push((r) => v.includes(r[k])); return b; },
      order: () => b,
      limit: (n: number) => { limit = n; return b; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  const db = {
    from: (t: string) => query(t),
    rpc: async (fn: string, args: Row) => {
      if (fn === "freed_parts_due") {
        return { data: tables.subscription_billings.filter((r) => r.freed).map((r) => ({ billing_id: r.id, subscription_id: r.subscription_id, tenant_id: r.tenant_id, period_start: r.period_start })), error: null };
      }
      if (fn === "bill_subscription_instalment") {
        /* What the RPC bills: the part's stored taxable as it stands at the call (+18% GST). */
        const row = tables.subscription_billings.find((r) => r.id === args.p_billing_id)!;
        const taxable = row.taxable_amount as number;
        const sub = tables.subscriptions.find((s) => s.id === row.subscription_id)!;
        const seats = sub.seats as number;
        const perSeat = taxable % seats === 0;
        log.push(`bill ${String(args.p_billing_id)} ${perSeat ? `${seats} x ${taxable / seats}` : `1 x ${taxable}`}${args.p_dry_run ? " dry" : ""}`);
        const gross = taxable + Math.round(taxable * 18 / 100);
        return { data: args.p_dry_run ? { action: "request", gross, dry_run: true } : { action: "request", quote_id: "PI-F588-27-0006", gross }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { db: db as never, log, updates };
}

/** SCN Bit Labs: monthly, 12-month term; seats moved 17 → 18 (₹300 a seat) after the Oct part was laid at ₹5,100. */
function bitLabs(over: { seats?: number; mrr?: number; octTaxable?: number; openRequestOnOct?: boolean; invoiced?: boolean } = {}) {
  return {
    subscriptions: [{
      id: "s1", tenant_id: "t1", quote_id: null, customer_id: null, status: "active",
      seats: over.seats ?? 18, mrr: over.mrr ?? 5400, billing_cycle: "monthly", term_months: 12, term_amount: null,
      start_date: "2026-01-12", renewal_date: "2027-01-11", billed_externally_until: null, external_source: null, external_ref: null,
    }],
    subscription_billings: [{
      id: "oct", tenant_id: "t1", subscription_id: "s1", term_start: "2026-01-12", period_index: 10,
      period_start: "2026-10-12", period_end: "2026-11-12", taxable_amount: over.octTaxable ?? 5100, tax_rate: 18,
      invoice_id: over.invoiced ? "INV-1" : null, freed: true,
    }],
    quotes: over.openRequestOnOct
      ? [{ id: "PI-F588-27-0005", subscription_billing_id: "oct", status: "sent", amount: 6372, cancelled_part_billing_id: null }]
      : [{ id: "Q-SCN-PF-1", subscription_billing_id: null, cancelled_part_billing_id: "oct", status: "cancelled", amount: 6018 }],
    customers: [],
  };
}

describe("R-2541 — a freed part is billed at the subscription's CURRENT seats × rate", () => {
  it("billing job: seats 17 → 18 since the Oct part was laid → Oct is billed 18 × ₹300 + GST (as the UI), repriced BEFORE the bill", async () => {
    const t = bitLabs();
    const { db, log } = fakeDb(t);
    const r = await billFreedParts(db, { todayISO: "2026-11-06", dryRun: false, allowed: () => true });
    expect(r.errors).toEqual([]);
    expect(log).toEqual(["update subscription_billings oct", "bill oct 18 x 300"]);
    expect(t.subscription_billings[0].taxable_amount).toBe(5400);
    const ui = partAmounts({ seats: 18, seatRate: 300, taxRate: 18 });
    expect(r.parts[0].result.requests[0].gross).toBe(ui.gross); // ₹6,372 — the same as Bill next part's 18 × ₹300
    expect(r.parts[0].repriced).toEqual({ from: 5100, to: 5400 });
  });

  it("dry run: the same answer, nothing written", async () => {
    const t = bitLabs();
    const { db, log, updates } = fakeDb(t);
    const r = await billFreedParts(db, { todayISO: "2026-11-06", dryRun: true, allowed: () => true });
    expect(updates).toEqual([]);
    expect(t.subscription_billings[0].taxable_amount).toBe(5100);
    expect(log).toEqual(["bill oct 1 x 5100 dry"]);
    expect(r.parts[0].repriced).toEqual({ from: 5100, to: 5400 });
    expect(r.parts[0].result.wouldRequest).toBe(1);
  });

  it("no seat change: nothing rewritten (17 × ₹300 stays ₹5,100)", async () => {
    const t = bitLabs({ seats: 17, mrr: 5100 });
    const { db, log } = fakeDb(t);
    const r = await billFreedParts(db, { todayISO: "2026-11-06", dryRun: false, allowed: () => true });
    expect(log).toEqual(["bill oct 17 x 300"]);
    expect(r.parts[0].repriced).toBeNull();
  });

  it("UI path unchanged: a part whose proforma is open keeps the proforma's amount (set_part_request_terms owns it)", async () => {
    const t = bitLabs({ openRequestOnOct: true });
    const { db, updates } = fakeDb(t);
    expect(await repriceUnbilledPart(db, "oct", false)).toBeNull();
    expect(updates).toEqual([]);
  });

  it("an invoiced part is a GST document's source — never repriced", async () => {
    const t = bitLabs({ invoiced: true });
    const { db, updates } = fakeDb(t);
    expect(await repriceUnbilledPart(db, "oct", false)).toBeNull();
    expect(updates).toEqual([]);
  });

  it("Bill next part preview: the freed Oct shows 18 × ₹300 = ₹5,400 + GST ₹972 (the same rule), and writes nothing", async () => {
    const t = bitLabs();
    const { db, updates } = fakeDb(t);
    const p = await billNextPreview(db, t.subscriptions[0] as never, 1);
    expect(updates).toEqual([]);
    expect(p.firstStart).toBe("2026-10-12");
    expect([p.seats, p.seatRate, p.partTaxable]).toEqual([18, 300, 5400]);
    expect(p.amounts).toEqual({ taxable: 5400, tax: 972, gross: 6372 });
  });
});
