/**
 * R-1613 — ONE "amount due now" on a quote. The accept page's Pay-now figure, its UPI QR and
 * the quote PDF's QR must equal what the Razorpay order charges (lib/checkout/quote-order.ts).
 *
 * Reproduced first (18 Oct 2026, before the fix): a ₹708 quote with ₹400 received — Razorpay
 * ordered ₹308, the accepted screen offered nothing and the review button said ₹708; a
 * quarterly ₹28,320 quote's PDF QR asked ₹28,320 while the order took instalment 1 (₹7,080).
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/lib/crypto/tenant-secrets", () => ({ decryptTenantSecrets: (s: unknown) => s }));
const rzp = vi.hoisted(() => ({ create: vi.fn(async (_order: Record<string, unknown>) => ({ id: "order_X" })) }));
vi.mock("razorpay", () => ({ default: class { orders = { create: rzp.create }; } }));

import { startQuotePayment, readQuoteDueNow, type QuoteForOrder } from "@/lib/checkout/quote-order";
import { acceptedPayNow } from "@/app/(public)/quote/[id]/accept/accepted-pay";
import { quoteUpiAmount } from "@/app/(public)/quote/[id]/accept/upi-amount";
import { quotePerPeriodFigures } from "@/lib/quotes/per-period-figures";
import { quoteDueNow, quoteDueNowUpiAmount } from "./quote-due-now";

type Pay = { amount: number; status: string };

/** A fake admin client: the payments ledger + Razorpay test keys (never real ones). */
function admin(payments: Pay[]) {
  return {
    from: (table: string) => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        maybeSingle: async () => ({ data: { razorpay_key_id: "rzp_test_k", razorpay_key_secret: "s", razorpay_mode: "test" }, error: null }),
        then: (ok: (v: unknown) => unknown) => ok({ data: table === "payments" ? payments.filter((p) => p.status === "received") : [], error: null }),
      };
      return chain;
    },
    rpc: vi.fn(),
  } as never;
}

const quote = (over: Partial<QuoteForOrder> & { exchange_rate?: number | null } = {}): QuoteForOrder & { exchange_rate?: number | null } => ({
  id: "Q-1613", status: "accepted", payment_status: "none", expires_date: "2099-01-01",
  amount: 708, currency: "INR", customer_name: "Asha Co", tenant_id: "t-1", invoice_id: null,
  billing_cycle: "yearly", subtotal: 600, discount_pct: 0, tax_rate: 18,
  line_items: [{ qty: 1, rate: 600, commitment: "annual_yearly" }], superseded_by: null, ...over,
});

/** Every figure a customer can be asked for, for one quote + ledger. */
async function figures(q: ReturnType<typeof quote>, payments: Pay[]) {
  rzp.create.mockClear();
  const db = admin(payments);
  const order = await startQuotePayment(db, q, { allowSimulation: false, logTag: "[t]" });
  const due = await readQuoteDueNow(db, q);
  return {
    orderStatus: order.status,
    order: order.status === 200 ? (order.body.amountRupees as number) : null,
    page: acceptedPayNow({ due, payOnline: true, hasUpi: true })?.amount ?? null,
    pageQr: quoteUpiAmount(due),
    pdfQr: quoteDueNowUpiAmount(due),
    due,
  };
}

describe("parity — accept page === Razorpay order === PDF QR", () => {
  it("part-paid INR (₹708, ₹400 received) → ₹308 everywhere", async () => {
    const f = await figures(quote({ payment_status: "partial" }), [{ amount: 400, status: "received" }]);
    expect(f.order).toBe(308);
    expect(f.page).toBe(308);
    expect(f.pageQr).toBe(308);
    expect(f.pdfQr).toBe(308);
    expect(rzp.create.mock.calls[0][0]).toMatchObject({ amount: 30800 });
  });

  it("a refunded payment is not money in hand — the full ₹708 is due", async () => {
    const f = await figures(quote(), [{ amount: 400, status: "refunded" }]);
    expect([f.order, f.page, f.pageQr, f.pdfQr]).toEqual([708, 708, 708, 708]);
  });

  it("unpaid INR → the whole ₹708 everywhere", async () => {
    const f = await figures(quote(), []);
    expect([f.order, f.page, f.pageQr, f.pdfQr]).toEqual([708, 708, 708, 708]);
  });

  it("split-billed INR (quarterly ₹28,320) → instalment 1 (₹7,080) everywhere, PDF QR included", async () => {
    const q = quote({ billing_cycle: "quarterly", subtotal: 24000, amount: 28320, line_items: [{ qty: 10, rate: 2400, commitment: "annual_yearly" }] });
    const f = await figures(q, []);
    expect([f.order, f.page, f.pageQr, f.pdfQr]).toEqual([7080, 7080, 7080, 7080]);
    expect(f.due).toMatchObject({ state: "due", instalment: { count: 4, cycle: "quarterly" } });
  });

  it("split-billed INR after instalment 1 → nothing on the quote (order 409, no button, no QR)", async () => {
    const q = quote({ billing_cycle: "quarterly", subtotal: 24000, amount: 28320, payment_status: "partial", line_items: [{ qty: 10, rate: 2400, commitment: "annual_yearly" }] });
    const f = await figures(q, [{ amount: 7080, status: "received" }]);
    expect(f.orderStatus).toBe(409);
    expect([f.page, f.pageQr, f.pdfQr]).toEqual([null, 0, 0]);
    expect(f.due.state).toBe("instalment-paid");
  });

  it("USD billed monthly → the instalment in DOLLARS (= the PDF's per-invoice figure); no Razorpay, no UPI", async () => {
    // 10 seats × ₹8,300 at ₹83/$ = $1,000 + 18% = $1,180/yr → $98.33/month on the PDF.
    const q = quote({
      currency: "USD", exchange_rate: 83, billing_cycle: "monthly", subtotal: 83000, amount: 97940,
      line_items: [{ qty: 10, rate: 8300, commitment: "annual_yearly" }],
    });
    const f = await figures(q, []);
    const pdf = quotePerPeriodFigures({
      cycle: "monthly", lineCommitment: "annual_yearly", subtotal: 1000, discount: 0, taxable: 1000, tax: 180, total: 1180,
      taxRate: 18, foreign: true,
    });
    expect(f.due).toMatchObject({ state: "due", inr: false, currency: "USD", amount: pdf.gross });
    expect(pdf.gross).toBe(98.33);
    expect(f.orderStatus).toBe(400);           // Razorpay settles ₹ only
    expect([f.page, f.pageQr, f.pdfQr]).toEqual([null, 0, 0]);
  });

  it("paid in full → 'paid': order 409, no Pay now, no QR on page or PDF", async () => {
    for (const [status, pays] of [["received", [{ amount: 708, status: "received" }]], ["partial", [{ amount: 408, status: "received" }, { amount: 300, status: "received" }]]] as const) {
      const f = await figures(quote({ payment_status: status }), [...pays]);
      expect(f.orderStatus).toBe(409);
      expect(f.due.state).toBe("paid");
      expect([f.page, f.pageQr, f.pdfQr]).toEqual([null, 0, 0]);
    }
  });
});

describe("quoteDueNow — edges", () => {
  it("an invoiced quote asks for nothing — the invoice owns the ask", () => {
    expect(quoteDueNow(quote({ invoice_id: "INV-1" }), 0).state).toBe("invoiced");
    expect(quoteDueNow(quote({ payment_status: "invoiced" }), 0).state).toBe("invoiced");
  });
  it("flex (monthly commitment) → the stored per-month amount, no split", () => {
    const d = quoteDueNow(quote({ billing_cycle: "monthly", amount: 2360, subtotal: 2000, line_items: [{ qty: 1, rate: 2000, commitment: "monthly" }] }), 0);
    expect(d).toMatchObject({ state: "due", amount: 2360, instalment: null });
  });
  it("legacy quote without billing_cycle reads the line commitment (same as the page always did)", () => {
    const d = quoteDueNow(quote({ billing_cycle: null, subtotal: 24000, amount: 28320, line_items: [{ qty: 10, rate: 2400, commitment: "annual_quarterly" }] }), 0);
    expect(d).toMatchObject({ state: "due", amount: 7080 });
  });
  it("part-paid USD (yearly) → the remainder in dollars", () => {
    const d = quoteDueNow(quote({ currency: "USD", exchange_rate: 83, subtotal: 83000, amount: 97940, line_items: [{ qty: 10, rate: 8300, commitment: "annual_yearly" }] }), 41500);
    expect(d).toMatchObject({ state: "due", inr: false, quoteTotal: 1180, alreadyPaid: 500, amount: 680 });
  });
  it("a ledger read failure asks for nothing (no QR), it never guesses", async () => {
    const broken = { from: () => { const c: Record<string, unknown> = { select: () => c, eq: () => c, then: (ok: (v: unknown) => unknown) => ok({ data: null, error: { message: "down" } }) }; return c; } } as never;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await readQuoteDueNow(broken, quote())).toEqual({ state: "nothing" });
    spy.mockRestore();
  });
});
