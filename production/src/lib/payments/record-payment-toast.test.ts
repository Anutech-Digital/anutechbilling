import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { paymentToast, cashReference, subscriptionNoteFor, type PaymentToastInput, type SubscriptionNoteInput } from "./record-payment-toast";

const base: PaymentToastInput = {
  outstanding: 0,
  isFullyPaid: false,
  convertedNow: false,
  subscriptionCreated: false,
  invoicePaid: false,
  hasExistingInvoice: false,
  isRenewalQuote: false,
  renewalRolledForward: false,
  overpaidCredit: 0,
  tdsRecorded: false,
  tdsAttempted: false,
  tdsAmount: 0,
  paymentId: "pay-1",
  receiptVoucherNo: "RV-2026-27-0001",
  customerName: "Acme",
  invoiceId: null,
  subscriptionNote: null,
  receiptUploadFailed: false,
};
const t = (o: Partial<PaymentToastInput>) => paymentToast({ ...base, ...o });

describe("paymentToast (R-248)", () => {
  it("full payment, no invoice yet → Generate invoice + Send receipt on ONE toast", () => {
    const r = t({ isFullyPaid: true });
    expect(r.title).toMatch(/Paid in full/);
    expect(r.primary).toEqual({ kind: "generate-invoice", label: "Generate invoice" });
    expect(r.secondary).toEqual({ kind: "send-receipt", label: "Send receipt" });
    expect(r.tone).toBe("success");
  });

  it("partial payment → Send receipt, outstanding in rupee() format", () => {
    const r = t({ outstanding: 123456 });
    expect(r.title).toBe("Payment recorded · ₹1,23,456 still pending");
    expect(r.primary?.kind).toBe("send-receipt");
    expect(r.secondary).toBeNull();
  });

  it("a fraction never prints as ₹246.9", () => {
    expect(t({ outstanding: 246.9 }).title).toContain("₹247");
  });

  it("post-invoice payment has no receipt voucher → View invoice, never Send receipt", () => {
    const r = t({ invoicePaid: true, hasExistingInvoice: true, isFullyPaid: true, invoiceId: "INV-1", receiptVoucherNo: null });
    expect(r.primary?.kind).toBe("view-invoice");
    // R-323: the button opens THAT invoice's own page, dialog open — not the list.
    expect(r.primary?.href).toBe("/invoices/INV-1?pdf=1");
    expect(r.secondary).toBeNull();
  });

  it("no voucher and no invoice → no button rather than a dead one", () => {
    expect(t({ receiptVoucherNo: null }).primary).toBeNull();
  });

  it("folds TDS, excess credit and subscription notes into lines of the same toast", () => {
    const r = t({
      isFullyPaid: true, tdsRecorded: true, tdsAmount: 1000, overpaidCredit: 500,
      subscriptionNote: { kind: "one-off", item: "Domain" },
    });
    expect(r.lines).toHaveLength(3);
    expect(r.lines.join(" ")).toContain("₹1,000");
    expect(r.lines.join(" ")).toContain("₹500");
    expect(r.tone).toBe("success");
  });

  it("a failure (TDS row / missing subscription / receipt file) turns the toast into a warning", () => {
    expect(t({ tdsAttempted: true, tdsAmount: 10 }).tone).toBe("warning");
    expect(t({ subscriptionNote: { kind: "missing", item: "GW" } }).tone).toBe("warning");
    expect(t({ receiptUploadFailed: true }).tone).toBe("warning");
  });

  it("renewal rolled forward keeps the reminder note as a line, not a second toast", () => {
    const r = t({ renewalRolledForward: true, isRenewalQuote: true, isFullyPaid: true });
    expect(r.title).toMatch(/rolled forward/);
    expect(r.lines[0]).toMatch(/Reminders restart/);
  });
});

describe("cashReference", () => {
  it("is readable and unique per second (a bare 'Cash' would replay the 2nd instalment)", () => {
    const a = cashReference("2026-10-07", new Date("2026-10-07T04:30:15Z"));
    const b = cashReference("2026-10-07", new Date("2026-10-07T04:30:16Z"));
    expect(a).toBe("Cash 2026-10-07 10:00:15");
    expect(a).not.toBe(b);
  });
});

describe("record-payment-dialog source", () => {
  const src = fs.readFileSync(
    path.resolve(__dirname, "../../components/features/quotes/record-payment-dialog.tsx"),
    "utf8",
  );
  it("formats every ₹ with rupee(), never toLocaleString", () => {
    expect(src.match(/toLocaleString/g) ?? []).toHaveLength(0);
  });
  it("no longer staggers toasts with setTimeout", () => {
    expect(src).not.toMatch(/setTimeout\(\s*\(\)\s*=>\s*toast/);
    expect(src).not.toMatch(/setTimeout\(\(\) => \{\s*(if|toast)/);
  });
});

/* R-379 (k): credit-activated quote → part payment must not warn "No subscription was created". */

describe("subscriptionNoteFor (R-379 k)", () => {
  const annual = [{ name: "Google Workspace Business Starter", qty: 5, rate: 1650, commitment: "annual_yearly" }];
  const baseNote: SubscriptionNoteInput = {
    isFirstPayment: true, subscriptionCreated: false, isRenewalQuote: false,
    isAddSeats: false, creditActivatedAt: null, existingSubs: 0, lines: annual,
  };
  const n = (o: Partial<SubscriptionNoteInput>) => subscriptionNoteFor({ ...baseNote, ...o });

  it("plan paid, nothing created, nothing exists → missing (the real fault still warns)", () => {
    expect(n({})).toEqual({ kind: "missing", item: "Google Workspace Business Starter" });
    expect(t({ subscriptionNote: n({}) }).tone).toBe("warning");
  });
  it("quote already has a subscription (created at credit activation) → no note, success toast", () => {
    const note = n({ existingSubs: 1 });
    expect(note).toBeNull();
    const r = t({ subscriptionNote: note, outstanding: 5000 });
    expect(r.tone).toBe("success");
    expect(r.lines.join(" ")).not.toMatch(/No subscription was created/);
  });
  it("credit-activated quote → no note even if the subscription read came back empty", () => {
    expect(n({ creditActivatedAt: "2026-10-07T06:00:00Z" })).toBeNull();
  });
  it("add-seats, renewal, later payment, or created now → no note", () => {
    expect(n({ isAddSeats: true })).toBeNull();
    expect(n({ isRenewalQuote: true })).toBeNull();
    expect(n({ isFirstPayment: false })).toBeNull();
    expect(n({ subscriptionCreated: true })).toBeNull();
  });
  it("one-off line → one-off note (not a warning)", () => {
    expect(n({ lines: [{ name: "Domain Registration", qty: 1, rate: 900, commitment: null }] }))
      .toEqual({ kind: "one-off", item: "Domain Registration" });
  });
});
