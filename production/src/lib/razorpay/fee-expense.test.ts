/**
 * R-045 slice 2 — net received, the fee expense row, its GST head, and "booked once".
 */
import { describe, it, expect } from "vitest";
import { feeExpenseId, feeGstHeads, gatewayFeeExpense, istDay, paymentFeeView, type FeeExpensePayment } from "./fee-expense";
import { bookGatewayFeeExpense } from "./fee-expense.server";

/* A checksum-valid Karnataka (29) GSTIN — stateCodeFromGstin rejects made-up ones. */
const KA_GSTIN = "29AAGCR4375J1ZU";
const TENANT = "11111111-1111-4111-8111-111111111111";
const PAY = "aaaaaaaa-0000-4000-8000-000000000001";

const payment = (over: Partial<FeeExpensePayment> = {}): FeeExpensePayment => ({
  id: PAY, tenant_id: TENANT, quote_id: "Q-AITEST-0001", reference: "pay_AITEST1",
  received_at: "2026-10-06T20:00:00Z", // 7 Oct 01:30 IST
  amount: 1180, gateway_fee: 28, gateway_fee_gst: 4,
  ...over,
});

describe("net received", () => {
  it("net = amount − fee, whole rupees, and fee + net is the amount", () => {
    expect(paymentFeeView({ amount: 1180, gateway_fee: 28, gateway_fee_gst: 4 })).toEqual({ fee: 28, gst: 4, net: 1152 });
    const v = paymentFeeView({ amount: 99_999, gateway_fee: 2_360, gateway_fee_gst: 360 })!;
    expect(v.fee + v.net).toBe(99_999);
  });

  it("unknown fee (manual payment / before R-045) shows nothing — never a guessed zero", () => {
    expect(paymentFeeView({ amount: 1180 })).toBeNull();
    expect(paymentFeeView({ amount: 1180, gateway_fee: null })).toBeNull();
  });

  it("a real zero fee is shown; a fee above the amount is bad data and hidden", () => {
    expect(paymentFeeView({ amount: 500, gateway_fee: 0, gateway_fee_gst: 0 })).toEqual({ fee: 0, gst: 0, net: 500 });
    expect(paymentFeeView({ amount: 10, gateway_fee: 11 })).toBeNull();
  });

  it("GST larger than the fee is ignored, not subtracted", () => {
    expect(paymentFeeView({ amount: 1180, gateway_fee: 28, gateway_fee_gst: 40 })).toEqual({ fee: 28, gst: 0, net: 1152 });
  });
});

describe("the fee expense row", () => {
  it("amount = fee incl. GST, gst_paid = GST on fee (P&L takes eligible GST back out) — Bank Charges, paid, Razorpay", () => {
    const row = gatewayFeeExpense(payment(), null, "07")!;
    expect(row).toMatchObject({
      id: feeExpenseId(PAY), tenant_id: TENANT, category: "Bank Charges", vendor_name: "Razorpay",
      amount: 28, gst_paid: 4, bill_type: "gst", paid: true, payment_method: "razorpay",
    });
    expect(row.amount - row.gst_paid).toBe(24); // the cost ex-GST
  });

  it("dated on the IST day of the payment, not the UTC day", () => {
    expect(istDay("2026-10-06T20:00:00Z")).toBe("2026-10-07");
    const row = gatewayFeeExpense(payment(), null, null)!;
    expect(row.expense_date).toBe("2026-10-07");
    expect(row.paid_date).toBe("2026-10-07");
  });

  it("the id is derived from the payment — the same payment always maps to the same expense", () => {
    expect(feeExpenseId(PAY)).toBe(`EXP-RZPFEE-${PAY}`);
    expect(gatewayFeeExpense(payment(), null, null)!.id).toBe(gatewayFeeExpense(payment(), null, null)!.id);
  });

  it("nothing to book: no fee, zero fee, unreadable date", () => {
    expect(gatewayFeeExpense(payment({ gateway_fee: null, gateway_fee_gst: null }), null, null)).toBeNull();
    expect(gatewayFeeExpense(payment({ gateway_fee: 0, gateway_fee_gst: 0 }), null, null)).toBeNull();
    expect(gatewayFeeExpense(payment({ received_at: "not a date" }), null, null)).toBeNull();
  });

  it("links the tenant's Razorpay vendor so the GST can count as input credit", () => {
    const row = gatewayFeeExpense(payment(), { id: "v-1", gstin: KA_GSTIN }, "07")!;
    expect(row.vendor_id).toBe("v-1");
  });
});

describe("GST head — from Razorpay's GSTIN state vs ours, never a guess", () => {
  it("Razorpay (Karnataka) billing a Delhi tenant → all IGST", () => {
    expect(feeGstHeads(4, KA_GSTIN, "07")).toEqual({ igst: 4, cgst: 0, sgst: 0 });
    const row = gatewayFeeExpense(payment(), { id: "v-1", gstin: KA_GSTIN }, "07")!;
    expect([row.igst, row.cgst, row.sgst]).toEqual([4, 0, 0]);
  });

  it("Karnataka tenant → CGST + SGST, whole rupees, summing to the GST", () => {
    const h = feeGstHeads(5, KA_GSTIN, "29")!;
    expect(h.igst).toBe(0);
    expect(h.cgst + h.sgst).toBe(5);
    expect(Number.isInteger(h.cgst) && Number.isInteger(h.sgst)).toBe(true);
  });

  it("either side unknown → heads left empty (report flags them), not invented", () => {
    expect(feeGstHeads(4, null, "07")).toBeNull();
    expect(feeGstHeads(4, KA_GSTIN, null)).toBeNull();
    expect(feeGstHeads(4, "29XXXXX0000X1Z0", "07")).toBeNull(); // bad checksum
    const row = gatewayFeeExpense(payment(), null, "07")!;
    expect([row.igst, row.cgst, row.sgst]).toEqual([null, null, null]);
  });
});

/* ── booking: a small fake of the Supabase calls bookGatewayFeeExpense makes ─────────── */

type Row = Record<string, unknown>;
function fakeDb(tables: Record<string, Row[]>) {
  const writes: Row[] = [];
  function query(table: string) {
    const filters: ((r: Row) => boolean)[] = [];
    let lim = Infinity;
    let upsertRow: Row | null = null;
    const rows = () => (tables[table] ?? []).filter((r) => filters.every((f) => f(r))).slice(0, lim);
    const q: Record<string, unknown> = {
      select: () => q,
      eq: (c: string, v: unknown) => { filters.push((r) => r[c] === v); return q; },
      ilike: (c: string, pat: string) => {
        const needle = pat.replace(/%/g, "").toLowerCase();
        filters.push((r) => String(r[c] ?? "").toLowerCase().includes(needle));
        return q;
      },
      order: () => q,
      limit: (n: number) => { lim = n; return q; },
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      /* insert … on conflict (id) do nothing: the PRIMARY KEY is the idempotency key. */
      upsert: (row: Row, opts: { onConflict: string; ignoreDuplicates: boolean }) => {
        expect(opts).toEqual({ onConflict: "id", ignoreDuplicates: true });
        upsertRow = row;
        return q;
      },
      then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => {
        if (upsertRow) {
          const t = (tables[table] ??= []);
          if (t.some((r) => r.id === upsertRow!.id)) return Promise.resolve({ data: [], error: null }).then(ok, bad);
          t.push({ ...upsertRow });
          writes.push(upsertRow);
          return Promise.resolve({ data: [{ id: upsertRow.id }], error: null }).then(ok, bad);
        }
        return Promise.resolve({ data: rows(), error: null }).then(ok, bad);
      },
    };
    return q;
  }
  return { db: { from: (t: string) => query(t) } as never, writes, tables };
}

describe("booking — once per payment, inside the tenant", () => {
  const seed = () => fakeDb({
    payments: [{ ...payment() }, { ...payment({ id: "other-tenant-pay", tenant_id: "22222222-2222-4222-8222-222222222222" }) }],
    vendors: [{ id: "v-rzp", tenant_id: TENANT, name: "Razorpay Software Pvt Ltd", gstin: KA_GSTIN, created_at: "2026-01-01" }],
    tenants: [{ id: TENANT, state_code: "07", gstin: null }],
    expenses: [],
  });

  it("books the fee with the vendor and the IGST head, then a second call writes nothing", async () => {
    const f = seed();
    expect(await bookGatewayFeeExpense(f.db, TENANT, PAY)).toBe("booked");
    expect(await bookGatewayFeeExpense(f.db, TENANT, PAY)).toBe("already");
    expect(f.tables.expenses).toHaveLength(1);
    expect(f.tables.expenses[0]).toMatchObject({ id: feeExpenseId(PAY), amount: 28, gst_paid: 4, igst: 4, vendor_id: "v-rzp" });
  });

  it("two deliveries racing (webhook retry + backfill) still write one row", async () => {
    const f = seed();
    const results = await Promise.all([bookGatewayFeeExpense(f.db, TENANT, PAY), bookGatewayFeeExpense(f.db, TENANT, PAY)]);
    expect(results.sort()).toEqual(["already", "booked"]);
    expect(f.tables.expenses).toHaveLength(1);
  });

  it("another tenant's payment id is not found — nothing booked", async () => {
    const f = seed();
    expect(await bookGatewayFeeExpense(f.db, TENANT, "other-tenant-pay")).toBe("not_found");
    expect(f.writes).toHaveLength(0);
  });

  it("a payment without a fee is skipped", async () => {
    const f = seed();
    (f.tables.payments[0] as Row).gateway_fee = null;
    expect(await bookGatewayFeeExpense(f.db, TENANT, PAY)).toBe("no_fee");
    expect(f.writes).toHaveLength(0);
  });

  it("tenant state taken from its GSTIN when state_code is empty", async () => {
    const f = seed();
    f.tables.tenants[0] = { id: TENANT, state_code: null, gstin: KA_GSTIN };
    expect(await bookGatewayFeeExpense(f.db, TENANT, PAY)).toBe("booked");
    const e = f.tables.expenses[0];
    expect(e.igst).toBe(0);
    expect((e.cgst as number) + (e.sgst as number)).toBe(4);
  });
});
