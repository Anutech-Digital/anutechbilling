/**
 * R-2541 (chk-local, localhost 6 Nov 2026 — p0 money): a part freed by a cancelled proforma was billed
 * by the no-seats path (billing job → billFreedParts, or Bill next part with no seats/rate) at the
 * part's STORED amount — PI-F588-27-0004 asked 1 × ₹5,100 although the subscription is now
 * 18 × ₹300 = ₹5,400. A part with no tax invoice and no open proforma is now billed at the
 * subscription's CURRENT seats × rate — the same figure the term run re-syncs its unbilled parts to
 * and the Bill next part preview shows (one rule: unbilledPartPrice).
 */
import { describe, it, expect } from "vitest";
import { billFreedParts, unbilledPartPrice } from "./sync-instalments.server";
import { billNextPreview } from "@/lib/renewals/bill-next.server";
import { partAmounts } from "./proforma";

type Row = Record<string, unknown>;

/** A tiny in-memory PostgREST: select / eq / is / in / order / limit / maybeSingle / update, plus the two RPCs. */
function fakeDb(tables: Record<string, Row[]>, opts: { failBill?: boolean } = {}) {
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
      gte: (k: string, v: string) => { filters.push((r) => String(r[k]) >= v); return b; },
      lt: (k: string, v: string) => { filters.push((r) => String(r[k]) < v); return b; },
      order: () => b,
      limit: (n: number) => { limit = n; return b; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      single: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej),
    };
    return b;
  }
  /* What bill_subscription_instalment bills: the part's stored taxable as it stands at the call (+18% GST). */
  function bill(id: unknown, dry: boolean) {
    const row = tables.subscription_billings.find((r) => r.id === id)!;
    const taxable = row.taxable_amount as number;
    const sub = tables.subscriptions.find((s) => s.id === row.subscription_id)!;
    const seats = sub.seats as number;
    const perSeat = taxable % seats === 0;
    log.push(`bill ${String(id)} ${perSeat ? `${seats} x ${taxable / seats}` : `1 x ${taxable}`}${dry ? " dry" : ""}`);
    const gross = taxable + Math.round(taxable * 18 / 100);
    return dry ? { action: "request", gross, dry_run: true } : { action: "request", quote_id: "PI-F588-27-0006", gross };
  }
  const db = {
    from: (t: string) => query(t),
    rpc: async (fn: string, args: Row) => {
      if (fn === "freed_parts_due") {
        return { data: tables.subscription_billings.filter((r) => r.freed).map((r) => ({ billing_id: r.id, subscription_id: r.subscription_id, tenant_id: r.tenant_id, period_start: r.period_start })), error: null };
      }
      if (fn === "bill_subscription_instalment") return { data: bill(args.p_billing_id, !!args.p_dry_run), error: null };
      if (fn === "reprice_and_bill_part") {
        /* R-2543: the database's one transaction — reprice, bill; a failed bill rolls the reprice back. */
        const row = tables.subscription_billings.find((r) => r.id === args.p_billing_id)!;
        log.push(`reprice+bill ${String(args.p_billing_id)} ${String(args.p_from)}->${String(args.p_to)}`);
        if (opts.failBill) return { data: null, error: { message: "No proforma number could be issued" } };
        row.taxable_amount = args.p_to;
        return { data: { ...bill(args.p_billing_id, false), reprice: "applied" }, error: null };
      }
      throw new Error(`unexpected rpc ${fn}`);
    },
  };
  return { db: db as never, log, updates };
}

/** SCN Bit Labs: monthly, 12-month term; seats moved 17 → 18 (₹300 a seat) after the Oct part was laid at ₹5,100. */
function bitLabs(over: { seats?: number; mrr?: number; octTaxable?: number; openRequestOnOct?: boolean; invoiced?: boolean;
  cycle?: string; addSeatsOn?: string; renewal?: string; part?: Row } = {}) {
  return {
    subscriptions: [{
      id: "s1", tenant_id: "t1", quote_id: null, customer_id: null, status: "active",
      seats: over.seats ?? 18, mrr: over.mrr ?? 5400, billing_cycle: over.cycle ?? "monthly", term_months: 12, term_amount: null,
      start_date: "2026-01-12", renewal_date: over.renewal ?? "2027-01-11", billed_externally_until: null, external_source: null, external_ref: null,
    }],
    subscription_billings: [{
      id: "oct", tenant_id: "t1", subscription_id: "s1", term_start: "2026-01-12", period_index: 10,
      period_start: "2026-10-12", period_end: "2026-11-12", taxable_amount: over.octTaxable ?? 5100, tax_rate: 18,
      invoice_id: over.invoiced ? "INV-1" : null, freed: true, ...over.part,
    }],
    quotes: [
      ...(over.openRequestOnOct
        ? [{ id: "PI-F588-27-0005", subscription_billing_id: "oct", status: "sent", amount: 6372, cancelled_part_billing_id: null }]
        : [{ id: "Q-SCN-PF-1", subscription_billing_id: null, cancelled_part_billing_id: "oct", status: "cancelled", amount: 6018 }]),
      ...(over.addSeatsOn
        ? [{ id: "Q-ADD-1", subscription_billing_id: null, cancelled_part_billing_id: null, status: "sent", amount: 354,
             is_add_seats: true, add_seats_subscription_id: "s1", created_date: over.addSeatsOn }]
        : []),
    ],
    customers: [],
  };
}

describe("R-2541 — a freed part is billed at the subscription's CURRENT seats × rate", () => {
  it("billing job: seats 17 → 18 since the Oct part was laid → Oct is billed 18 × ₹300 + GST (as the UI), repriced BEFORE the bill", async () => {
    const t = bitLabs();
    const { db, log } = fakeDb(t);
    const r = await billFreedParts(db, { todayISO: "2026-11-06", dryRun: false, allowed: () => true });
    expect(r.errors).toEqual([]);
    expect(log).toEqual(["reprice+bill oct 5100->5400", "bill oct 18 x 300"]);
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
    expect(await unbilledPartPrice(db, "oct")).toBeNull();
    expect(updates).toEqual([]);
  });

  it("+1 seat added mid-Oct with its pro-rata quote → Oct is NOT repriced (that seat was already charged for Oct)", async () => {
    const t = bitLabs({ addSeatsOn: "2026-10-20" });
    const { db, updates } = fakeDb(t);
    expect(await unbilledPartPrice(db, "oct")).toBeNull();
    expect(updates).toEqual([]);
  });

  it("a seat add in a LATER period does not block the Oct reprice", async () => {
    const t = bitLabs({ addSeatsOn: "2026-11-15" });
    const { db } = fakeDb(t);
    expect(await unbilledPartPrice(db, "oct")).toEqual({ from: 5100, to: 5400 });
  });

  it("the part's own term decides: a cycle that changed since (now quarterly) never gives Oct another period's amount", async () => {
    const t = bitLabs({ cycle: "quarterly", mrr: 5400 });
    const { db, updates } = fakeDb(t);
    expect(await unbilledPartPrice(db, "oct")).toEqual({ from: 5100, to: 5100, kept: "period_changed" });
    expect(updates).toEqual([]);
  });

  it("an invoiced part is a GST document's source — never repriced", async () => {
    const t = bitLabs({ invoiced: true });
    const { db, updates } = fakeDb(t);
    expect(await unbilledPartPrice(db, "oct")).toBeNull();
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

/**
 * R-2543 (rv-train3, 6 Nov 2026 — train blocker for R-2541):
 * 1. the period matched on number + start only — after monthly → quarterly, freed monthly #1
 *    (12 Jan–12 Feb) matched quarterly #1 (12 Jan–12 Apr) and was billed three months for one;
 * 2. coordinator decision: a freed part of an EARLIER term keeps its stored amount (last year's
 *    period is never billed at this year's price);
 * 3. the reprice was written before the bill and stayed when the bill failed — now one database
 *    transaction (reprice_and_bill_part), no separate UPDATE from the app.
 */
describe("R-2543 — freed-part reprice: same period, current term, one transaction", () => {
  const janMonthly = { id: "oct", period_index: 1, period_start: "2026-01-12", period_end: "2026-02-12", taxable_amount: 5100 };

  it("cycle changed monthly → quarterly: freed monthly #1 (12 Jan–12 Feb) is NOT given quarterly #1's 3-month amount", async () => {
    const t = bitLabs({ cycle: "quarterly", mrr: 5400, part: janMonthly });
    const { db, log, updates } = fakeDb(t);
    expect(await unbilledPartPrice(db, "oct")).toEqual({ from: 5100, to: 5100, kept: "period_changed" });
    const r = await billFreedParts(db, { todayISO: "2026-11-06", dryRun: false, allowed: () => true });
    expect(updates).toEqual([]);
    expect(log).toEqual(["bill oct 1 x 5100"]);            // its own stored month, not 3 × ₹5,400
    expect(r.parts[0].repriced).toEqual({ from: 5100, to: 5100, kept: "period_changed" });
  });

  it("same cycle, same period: monthly #1 is still repriced (the match is not too strict)", async () => {
    const t = bitLabs({ part: janMonthly });
    const { db } = fakeDb(t);
    expect(await unbilledPartPrice(db, "oct")).toEqual({ from: 5100, to: 5400 });
  });

  it("a freed part of an EARLIER term keeps its stored amount — last year's period at last year's price", async () => {
    /* Renewed: the current term is 12 Jan 2027 – 11 Jan 2028; the freed Oct 2026 part is last term's. */
    const t = bitLabs({ renewal: "2028-01-11" });
    const { db, log, updates } = fakeDb(t);
    const r = await billFreedParts(db, { todayISO: "2027-02-06", dryRun: false, allowed: () => true });
    expect(updates).toEqual([]);
    expect(log).toEqual(["bill oct 1 x 5100"]);
    expect(t.subscription_billings[0].taxable_amount).toBe(5100);
    expect(r.parts[0].repriced).toEqual({ from: 5100, to: 5100, kept: "earlier_term" });
  });

  it("an R-451 legacy term key (one day later) still counts as the current term", async () => {
    const t = bitLabs({ part: { term_start: "2026-01-13" } });
    const { db } = fakeDb(t);
    expect((await unbilledPartPrice(db, "oct"))?.kept).not.toBe("earlier_term");
  });

  it("the bill fails → the error is reported and the stored amount is untouched (reprice + bill are ONE call)", async () => {
    const t = bitLabs();
    const { db, log, updates } = fakeDb(t, { failBill: true });
    const r = await billFreedParts(db, { todayISO: "2026-11-06", dryRun: false, allowed: () => true });
    expect(r.parts).toEqual([]);
    expect(r.errors[0].message).toContain("No proforma number");
    expect(log).toEqual(["reprice+bill oct 5100->5400"]);  // no separate UPDATE from the app
    expect(updates).toEqual([]);
    expect(t.subscription_billings[0].taxable_amount).toBe(5100);
  });
});
