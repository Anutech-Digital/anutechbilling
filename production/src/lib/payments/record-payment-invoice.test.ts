import { describe, it, expect } from "vitest";
import {
  buyerStateKnown,
  isSplitBilled,
  invoiceNowOffer,
  shouldIssueAfterPayment,
  withIssuedInvoice,
} from "./record-payment-invoice";

// A valid Delhi GSTIN (same sample gstin-state.test uses).
const DELHI_GSTIN = "07ABDCA0298H1ZP";

describe("buyerStateKnown", () => {
  it("state code on record", () => expect(buyerStateKnown({ state_code: "07" })).toBe(true));
  it("blank state, no GSTIN → unknown", () => expect(buyerStateKnown({ state_code: " ", gstin: null })).toBe(false));
  it("no buyer → unknown", () => expect(buyerStateKnown(null)).toBe(false));
  it("export customer needs no state", () => expect(buyerStateKnown({ country: "Singapore" })).toBe(true));
  it("India spelled any way still needs a state", () => expect(buyerStateKnown({ country: "IND" })).toBe(false));
  it("junk GSTIN does not count", () => expect(buyerStateKnown({ gstin: "07ABC" })).toBe(false));
});

describe("isSplitBilled", () => {
  it.each([
    [null, false], [undefined, false], ["yearly", false],
    ["monthly", true], ["quarterly", true], ["half_yearly", true],
  ])("%s → %s", (c, want) => expect(isSplitBilled(c)).toBe(want));
});

describe("invoiceNowOffer", () => {
  const base = { invoiceId: null, billingCycle: "yearly", buyer: { state_code: "07" }, completesQuote: true };

  it("full payment, state known → offered and ticked", () => {
    expect(invoiceNowOffer(base)).toEqual({ offer: true, defaultOn: true, hint: null });
  });
  it("no billing cycle on the quote counts as one invoice", () => {
    expect(invoiceNowOffer({ ...base, billingCycle: null }).defaultOn).toBe(true);
  });
  it("already invoiced → not offered", () => {
    expect(invoiceNowOffer({ ...base, invoiceId: "INV-1" }).offer).toBe(false);
  });
  it("split billed (quarterly) → not offered: generate_invoice refuses it", () => {
    expect(invoiceNowOffer({ ...base, billingCycle: "quarterly" }).offer).toBe(false);
    expect(invoiceNowOffer({ ...base, billingCycle: "monthly" }).offer).toBe(false);
  });
  it("part payment → not offered (it would not issue anyway)", () => {
    expect(invoiceNowOffer({ ...base, completesQuote: false })).toEqual({ offer: false, defaultOn: false, hint: null });
  });
  it("no state on record → unticked with the reason", () => {
    const o = invoiceNowOffer({ ...base, buyer: { state_code: null, gstin: null } });
    expect(o).toMatchObject({ offer: true, defaultOn: false });
    expect(o.hint).toMatch(/no state or GSTIN/);
  });
  it("state derivable from a valid GSTIN → ticked", () => {
    expect(buyerStateKnown({ gstin: DELHI_GSTIN })).toBe(true);
    expect(invoiceNowOffer({ ...base, buyer: { state_code: null, gstin: DELHI_GSTIN } }).defaultOn).toBe(true);
  });
});

describe("shouldIssueAfterPayment", () => {
  const ok = { ticked: true, offered: true, isFullyPaid: true, hasExistingInvoice: false, isReplay: false };
  it("ticked + fully paid → issue", () => expect(shouldIssueAfterPayment(ok)).toBe(true));
  it("unticked → no", () => expect(shouldIssueAfterPayment({ ...ok, ticked: false })).toBe(false));
  it("not offered (split / invoiced) → no even if ticked", () => expect(shouldIssueAfterPayment({ ...ok, offered: false })).toBe(false));
  it("payment did not complete the quote → no", () => expect(shouldIssueAfterPayment({ ...ok, isFullyPaid: false })).toBe(false));
  it("invoice already there → no", () => expect(shouldIssueAfterPayment({ ...ok, hasExistingInvoice: true })).toBe(false));
  it("idempotent replay → no", () => expect(shouldIssueAfterPayment({ ...ok, isReplay: true })).toBe(false));
});

describe("withIssuedInvoice", () => {
  it("headline names the invoice, button opens it, send-receipt kept", () => {
    const t = withIssuedInvoice({
      tone: "success", lines: ["TDS logged"],
      title: "Paid in full · GST invoice can be generated now",
      primary: { kind: "generate-invoice", label: "Generate invoice" },
      secondary: { kind: "send-receipt", label: "Send receipt" },
    }, "INV-27-0007");
    expect(t.title).toBe("Paid in full · GST invoice INV-27-0007 issued");
    expect(t.primary).toEqual({ kind: "view-invoice", label: "View invoice", href: "/invoices/INV-27-0007?pdf=1" });
    expect(t.secondary?.kind).toBe("send-receipt");
    expect(t.lines).toEqual(["TDS logged"]);
  });
  it("no receipt button → no secondary", () => {
    const t = withIssuedInvoice({ tone: "success", lines: [], title: "x", primary: { kind: "generate-invoice", label: "g" }, secondary: null }, "I");
    expect(t.secondary).toBeNull();
  });
});
