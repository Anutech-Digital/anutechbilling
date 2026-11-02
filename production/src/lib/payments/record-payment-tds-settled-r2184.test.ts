/**
 * R-2184 (Zoho audit 31 Oct, ux.md task 3 / #10): Record payment with "Customer deducted TDS"
 * at the full amount (₹3,186 due = ₹3,132 bank + ₹54 TDS at 2%) said "₹54 of the quote's
 * ₹3,186 will still be outstanding" while the TDS box said the ₹54 is a TDS receivable — a
 * contradiction on a money screen. And after Confirm the sheet stayed open long enough to flip
 * to "Record additional payment", so the save looked failed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { recordPaymentConsequences, type PaymentToRecord } from "./record-consequences";
import { paymentToast, type PaymentToastInput } from "./record-payment-toast";

const pay: PaymentToRecord = {
  quoteId: "Q-F588-27-0068", customerName: "ABDCA", amount: 3132, quoteAmount: 3186, priorReceived: 0,
  createsCustomer: false, createsSubscription: true, planLabel: "Google Workspace Business Starter",
  tds: 54,
};
const texts = (p: PaymentToRecord) => recordPaymentConsequences({ payment: p, receiptSeries: null }).map((c) => c.text).join(" | ");

describe("R-2184 'What this does' counts the TDS", () => {
  it("bank + TDS = due → settled in full, never 'outstanding'", () => {
    const t = texts(pay);
    expect(t).toContain("Settled in full (₹3,132 bank + ₹54 TDS receivable).");
    expect(t).not.toMatch(/outstanding/);
  });
  it("bank + TDS short of the due → the real gap only", () => {
    const t = texts({ ...pay, amount: 1500, tds: 30 });
    expect(t).toContain("₹1,656 of the quote's ₹3,186 will still be outstanding");
  });
  it("no TDS → as before", () => {
    expect(texts({ ...pay, tds: undefined, amount: 3186 })).not.toMatch(/outstanding|Settled in full/);
  });
});

const base: PaymentToastInput = {
  outstanding: 1632, isFullyPaid: false, convertedNow: false, subscriptionCreated: false, invoicePaid: false,
  hasExistingInvoice: false, isRenewalQuote: false, renewalRolledForward: false, overpaidCredit: 0,
  tdsRecorded: true, tdsAttempted: true, tdsAmount: 30, paymentId: "p1", receiptVoucherNo: "RV-F588-27-0058",
  customerName: "ABDCA", invoiceId: null, subscriptionNote: null, receiptUploadFailed: false,
};

describe("R-2184 the result toast names the receipt and offers Record another", () => {
  it("names the RV", () => {
    expect(paymentToast(base).receipt).toBe("Receipt voucher RV-F588-27-0058");
  });
  it("part-paid → 'Record another' beside Send receipt", () => {
    const t = paymentToast(base);
    expect(t.primary?.kind).toBe("send-receipt");
    expect(t.another).toEqual({ kind: "record-another", label: "Record another" });
  });
  it("paid in full → no Record another", () => {
    expect(paymentToast({ ...base, isFullyPaid: true, outstanding: 0 }).another).toBeNull();
  });
});

describe("R-2184 the sheet closes once, at the save — before the slow after-save steps", () => {
  const src = readFileSync(join(__dirname, "../../components/features/quotes/record-payment-dialog.tsx"), "utf8");
  const onSuccess = src.slice(src.indexOf("R-407: the payment IS saved"), src.indexOf("onError: (err) =>"));
  it("onOpenChange(false) is called exactly once, before raise-instalments / the invoice step", () => {
    expect(onSuccess.match(/onOpenChange\(false\)/g)?.length).toBe(1);
    expect(onSuccess.indexOf("onOpenChange(false)")).toBeLessThan(onSuccess.indexOf("/raise-instalments`, { method: \"POST\" }"));
  });
  it("the dialog passes the TDS to 'What this does' and shows the RV in the toast", () => {
    expect(src).toMatch(/recordPaymentConsequences\(\{[\s\S]{0,400}tds: tdsDeducted \? tdsAmount : 0/);
    expect(src).toMatch(/t\.receipt/);
    expect(src).toMatch(/kind === "record-another"/);
  });
});
