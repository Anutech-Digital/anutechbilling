/**
 * R-2758 (R-2739a): the Renewals row's stage input — built only after the documents load, only the
 * current renewal's document / invoice, paise-rounded amounts. Pure.
 */
import { describe, expect, it } from "vitest";
import { renewalStage } from "@/lib/renewals/stage";
import { invoiceOwed, payHref, renewalInvoice, renewalPartPaid, stageInputFor, type StageRowFacts } from "./stage-input";
import type { LastDocs, LastInvoice } from "./last-docs";

const TODAY = "2026-11-14";

const inv = (o: Partial<LastInvoice> & { id: string }): LastInvoice => ({
  date: "2026-11-01", status: "sent", amount: 1180, paidAmount: 0, currency: "INR", dueDate: "2026-11-20",
  netPayable: 1180, adjustedAdvances: null, writtenOffAt: null, fxRate: null, sourceQuoteId: null,
  part: null, period: null, notes: null, ...o,
});

const docs = (o: Partial<LastDocs> = {}): LastDocs => ({ quote: null, invoice: null, invoices: [], sent: null, ...o });

const yearly = { id: "s1", status: "active", renewal_date: "2026-12-01", term_months: 12, billing_cycle: "yearly", start_date: "2025-12-01", auto_renew: true, renewal_quote_id: null as string | null };
const monthly = { ...yearly, id: "s2", billing_cycle: "monthly", renewal_date: "2026-11-30", start_date: "2025-12-01" };

const facts = (o: Partial<StageRowFacts>): StageRowFacts => ({ sub: yearly, todayIst: TODAY, docs: docs(), docsLoading: false, renewalPaid: false, ...o });

describe("R-2758 stageInputFor", () => {
  it("no stage while the documents read is loading — the chip never flips after load", () => {
    expect(stageInputFor(facts({ docsLoading: true }))).toBeNull();
  });

  it("a sent renewal quote → Renewal quote sent with its period, Follow up", () => {
    const sub = { ...yearly, renewal_quote_id: "Q-1" };
    const d = docs({
      sent: { quoteId: "Q-1", kind: "renewal", expiresDate: null, status: "sent" },
      quote: { id: "Q-1", date: "2026-11-10", status: "sent", payment_status: "none", expires_date: null, invoice_id: null, part: null, period: "1 Dec 2026 – 30 Nov 2027" },
    });
    const s = renewalStage(stageInputFor(facts({ sub, docs: d }))!);
    expect(s.key).toBe("sent");
    expect(s.label).toBe("Renewal quote sent · 1 Dec 2026 – 30 Nov 2027");
    expect(s.quoteId).toBe("Q-1");
  });

  it("a linked renewal draft (read from the open renewal quotes) stays Due — Send renewal reopens it", () => {
    const sub = { ...yearly, renewal_quote_id: "Q-2" };
    const s = renewalStage(stageInputFor(facts({ sub, linkedStatus: "draft" }))!);
    expect(s.key).toBe("due");
    expect(s.quoteId).toBe("Q-2");
  });

  it("an older term's unpaid invoice is NOT the row's stage (only the current renewal's)", () => {
    const old = inv({ id: "INV-OLD", sourceQuoteId: "Q-OLD" });
    const s = renewalStage(stageInputFor(facts({ docs: docs({ invoice: old, invoices: [old] }) }))!);
    expect(s.key).toBe("due");
    expect(s.invoiceId).toBeNull();
  });

  it("the renewal quote's invoice with money due → Invoiced · ₹x due", () => {
    const sub = { ...yearly, renewal_quote_id: "Q-3" };
    const i = inv({ id: "INV-3", sourceQuoteId: "Q-3", amount: 1180, paidAmount: 180, netPayable: 1180 });
    const s = renewalStage(stageInputFor(facts({ sub, docs: docs({ invoice: i, invoices: [i] }) }))!);
    expect(s.key).toBe("invoiced");
    expect(s.label).toBe("Invoiced · ₹1,000 due");
    expect(s.invoiceId).toBe("INV-3");
  });

  it("a part invoice of the next term (billed in parts) is the renewal's", () => {
    const i = inv({ id: "INV-P", part: { start: "2026-12-01", endExclusive: "2027-01-01" }, period: "Dec 2026" });
    const r = renewalInvoice(monthly, docs({ invoice: i, invoices: [i] }));
    expect(r?.invoice.id).toBe("INV-P");
  });

  it("a part invoice of the current term is not (it is the previous-term money)", () => {
    const i = inv({ id: "INV-P0", part: { start: "2026-10-01", endExclusive: "2026-11-01" } });
    expect(renewalInvoice(monthly, docs({ invoice: i, invoices: [i] }))).toBeNull();
  });
});

describe("R-2758 invoiceOwed — paise, never float dust", () => {
  it("₹0.004 left is paid (no 'Invoiced · ₹0 due' + Record payment)", () => {
    expect(invoiceOwed(inv({ id: "a", amount: 1000, netPayable: 1000, paidAmount: 999.996 }))).toBe(0);
  });
  it("rounds to paise", () => {
    expect(invoiceOwed(inv({ id: "b", amount: 1000.555, netPayable: 1000.555, paidAmount: 0 }))).toBeCloseTo(1000.56, 2);
  });
  it("void / cancelled / paid owe nothing", () => {
    expect(invoiceOwed(inv({ id: "c", status: "void" }))).toBe(0);
    expect(invoiceOwed(inv({ id: "d", status: "cancelled" }))).toBe(0);
    expect(invoiceOwed(inv({ id: "e", status: "paid", paidAmount: 1180 }))).toBe(0);
  });
});

describe("R-2758 payHref", () => {
  it("the open quote's own Record payment dialog", () => {
    expect(payHref({ quoteId: "Q-1", invoiceId: null }, undefined)).toBe("/quotes/Q-1?pay=1");
  });
  it("an invoice → its source quote's dialog, else the invoice page", () => {
    const i = inv({ id: "INV-9", sourceQuoteId: "Q-9" });
    expect(payHref({ quoteId: null, invoiceId: "INV-9" }, docs({ invoices: [i] }))).toBe("/quotes/Q-9?pay=1");
    expect(payHref({ quoteId: null, invoiceId: "INV-8" }, docs())).toBe("/invoices/INV-8");
  });
});

describe("R-2758 code-review fixes", () => {
  it("billed in parts: the next term's part invoice PAID = the renewal is paid (not 'Part not billed' again)", () => {
    const i = inv({ id: "INV-PP", status: "paid", paidAmount: 1180, part: { start: "2026-12-01", endExclusive: "2027-01-01" } });
    expect(renewalPartPaid(monthly, docs({ invoice: i, invoices: [i] }))).toBe(true);
    const s = renewalStage(stageInputFor(facts({ sub: monthly, docs: docs({ invoice: i, invoices: [i] }) }))!);
    expect(s.key).toBe("renewed");
  });
  it("a billing role (no /quotes) records on the invoice page", () => {
    const i = inv({ id: "INV-9", sourceQuoteId: "Q-9" });
    expect(payHref({ quoteId: null, invoiceId: "INV-9" }, docs({ invoices: [i] }), false)).toBe("/invoices/INV-9");
  });
  it("overdue days count from the invoice's own due date, not the part start", () => {
    const i = inv({ id: "INV-D", dueDate: "2026-12-15", part: { start: "2026-12-01", endExclusive: "2027-01-01" } });
    const input = stageInputFor(facts({ sub: monthly, todayIst: "2026-12-05", docs: docs({ invoice: i, invoices: [i] }) }))!;
    expect(input.invoice?.dueDate).toBe("2026-12-15");
    expect(renewalStage(input).label).toBe("Invoiced · ₹1,180 due");
  });
});
