import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { orderPaymentView, paymentByLead, type QuotePaymentRow } from "./order-payment";

const q = (lead_id: string | null, payment_status: string | null, invoice_id: string | null = null, created_at = "2026-10-07T05:00:00Z"): QuotePaymentRow =>
  ({ lead_id, payment_status, invoice_id, created_at });

describe("R-351 paymentByLead — paid only when a payment is recorded on the quote", () => {
  it("reads quotes.payment_status, not the lead stage", () => {
    const m = paymentByLead([
      q("L-paid", "received"),
      q("L-inv", "invoiced", "INV-1"),
      q("L-part", "partial"),
      q("L-wait", "awaiting"),
      q("L-none", null),
      q(null, "received"),
    ]);
    expect(m.get("L-paid")).toEqual({ state: "paid", invoiceId: null });
    expect(m.get("L-inv")).toEqual({ state: "paid", invoiceId: "INV-1" });
    expect(m.get("L-part")?.state).toBe("partial");
    expect(m.get("L-wait")?.state).toBe("none");
    expect(m.get("L-none")?.state).toBe("none");
    expect(m.size).toBe(5);
  });

  it("a lead with an unpaid re-quote and a paid quote is paid; partial beats none", () => {
    const m = paymentByLead([q("L-1", "awaiting"), q("L-1", "received"), q("L-2", "none"), q("L-2", "partial")]);
    expect(m.get("L-1")?.state).toBe("paid");
    expect(m.get("L-2")?.state).toBe("partial");
  });
});

describe("R-351 orderPaymentView — badge and steps can never disagree", () => {
  const cases = [
    undefined,
    { state: "none" as const, invoiceId: null },
    { state: "partial" as const, invoiceId: null },
    { state: "paid" as const, invoiceId: null },
    { state: "paid" as const, invoiceId: "INV-9" },
    { state: "none" as const, invoiceId: "INV-8" },
  ];
  it.each(cases)("Paid badge ⇔ Payment step done (%o)", (p) => {
    const v = orderPaymentView(p);
    expect(v.paid).toBe(v.steps.payment === "done");
    if (v.paid) expect(v.steps.invoice).not.toBe("pending");
  });

  it("ORD-MUR2KM5J shape: paid, invoice refused → Payment done, GST Invoice needs attention", () => {
    const v = orderPaymentView({ state: "paid", invoiceId: null });
    expect(v.steps).toEqual({ payment: "done", invoice: "failed" });
    expect(v.invoiceText).toMatch(/Not issued/);
  });

  it("no quote / no recorded payment is never paid", () => {
    expect(orderPaymentView(undefined).paid).toBe(false);
    expect(orderPaymentView({ state: "partial", invoiceId: null }).paid).toBe(false);
  });
});

describe("R-351 page wiring", () => {
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "page.tsx"), "utf8");
  it("paid never comes from the lead stage", () => {
    expect(src).not.toMatch(/paid:\s*l\.stage\s*===\s*"won"/);
    expect(src).not.toMatch(/stage\s*===\s*"won"\)\s*return\s*"active"/);
  });
  it("the Payment and GST Invoice steps come from the same view as the badge", () => {
    expect(src).not.toMatch(/payment:\s*"pending",\s*invoice:\s*"pending"/);
    expect(src).toMatch(/orderPaymentView\(/);
    expect(src).toMatch(/payment:\s*pay\.steps\.payment/);
  });
});
