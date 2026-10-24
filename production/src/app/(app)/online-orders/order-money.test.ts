/**
 * R-1120 — the Online Orders drawer shows only stored money facts (quote / invoice / payment),
 * never "lead value × 18%", never a hard-coded "Annual", never a blank Razorpay row.
 */
import { describe, it, expect } from "vitest";
import { orderMoney, pickOrderQuote, type OrderQuoteRow, type OrderInvoiceRow, type OrderPaymentRow } from "./order-money";

const quote = (over: Partial<OrderQuoteRow> = {}): OrderQuoteRow => ({
  id: "q1",
  lead_id: "L-1",
  created_at: "2026-10-20T10:00:00Z",
  amount: 1062,
  subtotal: 1000,
  tax_rate: 18,
  discount_pct: 10,
  billing_cycle: "quarterly",
  payment_status: null,
  invoice_id: null,
  ...over,
});

describe("orderMoney (R-1120)", () => {
  it("Rs1,000 plan, 10% coupon, quarterly: total = quote total, GST from the quote, cycle label right", () => {
    const m = orderMoney(quote(), undefined, []);
    expect(m.total).toEqual({ value: 1062 });
    expect(m.taxable).toEqual({ value: 900 });
    expect(m.gst).toEqual({ value: 162 });
    expect(m.gstLabel).toBe("GST (18%)");
    expect(m.billing).toEqual({ value: "Quarterly" });
    expect(m.discountPct).toBe(10);
  });

  it("never invents 18% when there is no quote — every money fact is unknown with a reason", () => {
    const m = orderMoney(undefined, undefined, []);
    expect(m.total.value).toBeNull();
    expect(m.gst.value).toBeNull();
    expect(m.billing.value).toBeNull();
    expect(m.razorpayId.value).toBeNull();
    for (const f of [m.total, m.gst, m.billing, m.taxable, m.razorpayId, m.gstSplit]) {
      expect("why" in f && f.why.length > 0).toBe(true);
    }
  });

  it("a quote whose amount does not match its own subtotal + GST shows no GST figure", () => {
    const m = orderMoney(quote({ amount: 900 }), undefined, []);
    expect(m.total).toEqual({ value: 900 });
    expect(m.gst.value).toBeNull();
  });

  it("once invoiced, the invoice's own taxable value, GST and split are shown", () => {
    const inv: OrderInvoiceRow = { id: "i1", amount: 1062, taxable_value: 900, tax_amount: 162, tax_rate: 18, inter_state: true };
    const m = orderMoney(quote({ invoice_id: "i1" }), inv, []);
    expect(m.gst).toEqual({ value: 162 });
    expect(m.gstSplit).toEqual({ value: "IGST (other state)" });
    expect(orderMoney(quote({ invoice_id: "i1" }), { ...inv, inter_state: false }, []).gstSplit).toEqual({ value: "CGST + SGST (same state)" });
  });

  it("Razorpay id = the reference of a Razorpay/UPI payment on the quote; none → reason", () => {
    const pays: OrderPaymentRow[] = [
      { quote_id: "q1", method: "bank_transfer", reference: "UTR123", status: "received", received_at: "2026-10-20T10:00:00Z" },
      { quote_id: "q1", method: "razorpay", reference: "pay_ABC", status: "received", received_at: "2026-10-21T10:00:00Z" },
    ];
    expect(orderMoney(quote(), undefined, pays).razorpayId).toEqual({ value: "pay_ABC" });
    const none = orderMoney(quote(), undefined, [pays[0]]).razorpayId;
    expect(none.value).toBeNull();
  });

  it("billing labels for every stored cycle", () => {
    expect(orderMoney(quote({ billing_cycle: "yearly" }), undefined, []).billing).toEqual({ value: "Annual" });
    expect(orderMoney(quote({ billing_cycle: "half_yearly" }), undefined, []).billing).toEqual({ value: "Half-yearly" });
    expect(orderMoney(quote({ billing_cycle: "monthly" }), undefined, []).billing).toEqual({ value: "Monthly" });
  });
});

describe("page source (R-1120)", () => {
  it("the page computes no GST, cycle or Razorpay id of its own", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");
    expect(src).not.toMatch(/\*\s*0\.18/);
    expect(src).not.toMatch(/billing:\s*"annual"/);
    expect(src).not.toMatch(/razorpayId:\s*null/);
    expect(src).not.toMatch(/GST \(18%\)/);
  });
});

describe("pickOrderQuote", () => {
  it("prefers the invoiced quote, then the paid one, then the newest", () => {
    const a = quote({ id: "a", created_at: "2026-10-01T00:00:00Z" });
    const b = quote({ id: "b", created_at: "2026-10-02T00:00:00Z", payment_status: "received" });
    const c = quote({ id: "c", created_at: "2026-10-03T00:00:00Z" });
    expect(pickOrderQuote([a, b, c])?.id).toBe("b");
    expect(pickOrderQuote([a, c])?.id).toBe("c");
    expect(pickOrderQuote([a, b, c, quote({ id: "d", created_at: "2026-09-01T00:00:00Z", invoice_id: "i9" })])?.id).toBe("d");
    expect(pickOrderQuote([])).toBeUndefined();
  });
});
