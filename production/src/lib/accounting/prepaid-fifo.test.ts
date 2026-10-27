import { describe, it, expect } from "vitest";
import { planFifo, openBalancesByVendor, type OpenAdvance } from "./prepaid-fifo";

const adv = (id: string, paid_date: string, total: number, consumed = 0, vendor = "Facebook"): OpenAdvance =>
  ({ id, vendor_name: vendor, paid_date, created_at: `${paid_date}T00:00:00Z`, total_amount: total, consumed_amount: consumed });

/* Same numbers as supabase/tests/prepaid_from_bank.test.sql, so preview and RPC are
   checked against one worked example. */
const THREE = [adv("c", "2026-07-20", 5000), adv("a", "2026-07-01", 5000), adv("b", "2026-07-10", 5000, 0, "facebook ")];

describe("planFifo", () => {
  it("spans top-ups oldest first; slices sum to the invoice and its GST", () => {
    const p = planFifo(THREE, "FACEBOOK", 12300, 1876);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.slices.map((s) => [s.advanceId, s.amount])).toEqual([["a", 5000], ["b", 5000], ["c", 2300]]);
    expect(p.slices.reduce((s, x) => s + x.amount, 0)).toBe(12300);
    expect(p.slices.reduce((s, x) => s + x.gst, 0)).toBe(1876);
    expect(p.leftAfter).toBe(2700);
  });

  it("skips advances already used up, and other vendors", () => {
    const p = planFifo([adv("a", "2026-07-01", 5000, 5000), adv("g", "2026-06-01", 9000, 0, "Google"), adv("b", "2026-07-10", 5000)], "Facebook", 1000, 0);
    expect(p.ok && p.slices.map((s) => s.advanceId)).toEqual(["b"]);
  });

  /* R-1913 (B2): same worked example as prepaid_from_bank.test.sql step 3. */
  it("an invoice bigger than what is left: the whole advance is applied and the rest stays due", () => {
    const p = planFifo(THREE, "Facebook", 15001, 0);
    expect(p).toMatchObject({ ok: true, leftAfter: 0, stillDue: 1 });
    if (!p.ok) return;
    expect(p.slices.reduce((s, x) => s + x.amount, 0)).toBe(15000);
  });

  it("R-1913: Verma — ₹30,000 advance, ₹50,000 bill → ₹20,000 still due; TDS comes off what is owed", () => {
    const verma = [adv("v", "2026-10-01", 30000, 0, "Verma Contractors")];
    expect(planFifo(verma, "Verma Contractors", 50000, 0)).toMatchObject({ ok: true, leftAfter: 0, stillDue: 20000 });
    // ₹31,000 bill with ₹1,000 TDS: ₹30,000 owed → the advance settles it, nothing due
    expect(planFifo(verma, "Verma Contractors", 31000, 0, 1000)).toMatchObject({ ok: true, leftAfter: 0, stillDue: 0 });
  });

  it("no advance left at all: refused", () => {
    const p = planFifo([adv("a", "2026-07-01", 5000, 5000)], "Facebook", 100, 0);
    expect(p).toMatchObject({ ok: false, available: 0 });
  });

  it("refuses GST above the total", () => {
    expect(planFifo(THREE, "Facebook", 100, 101).ok).toBe(false);
  });
});

describe("openBalancesByVendor", () => {
  it("groups by vendor ignoring case/space, biggest balance first", () => {
    expect(openBalancesByVendor([...THREE, adv("g", "2026-06-01", 20000, 0, "Google")])).toEqual([
      { vendor: "Google", balance: 20000, count: 1 },
      { vendor: "Facebook", balance: 15000, count: 3 },
    ]);
  });
});
