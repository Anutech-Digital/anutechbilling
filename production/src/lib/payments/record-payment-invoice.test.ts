import { describe, it, expect } from "vitest";
import {
  buyerStateKnown,
  isSplitBilled,
  invoiceNowOffer,
  paymentBuyerPlace,
  quoteStateCode,
  quoteStateToFill,
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

/* R-447 (9 Oct 2026): the quote's own Place of supply decides, not only the lead's state. */
describe("paymentBuyerPlace (R-447)", () => {
  it("lead with no state + quote Place of supply Delhi → state known, invoice box ticked", () => {
    const buyer = paymentBuyerPlace({ customer: null, quote: { prospect_state_code: "07" }, lead: { state_code: null, gstin: null } });
    expect(buyer).toEqual({ state_code: "07", country: null });
    expect(invoiceNowOffer({ invoiceId: null, billingCycle: "yearly", buyer, completesQuote: true }))
      .toEqual({ offer: true, defaultOn: true, hint: null });
  });
  it("a customer that already has a state wins — that is what generate_invoice uses", () => {
    expect(paymentBuyerPlace({ customer: { state_code: "06" }, quote: { prospect_state_code: "07" } }))
      .toEqual({ state_code: "06" });
  });
  it("a customer with no state takes the quote's state (it is copied before issuing)", () => {
    expect(paymentBuyerPlace({ customer: { state_code: null, country: "India" }, quote: { prospect_state_code: "7" } }))
      .toEqual({ state_code: "07", country: "India" });
  });
  it("no state on the quote → the lead's state, as record_payment copies it", () => {
    expect(paymentBuyerPlace({ quote: { prospect_state_code: null }, lead: { state_code: "29" } })).toEqual({ state_code: "29" });
  });
  it("nobody knows the state → still unknown, box unticked with the hint", () => {
    const buyer = paymentBuyerPlace({ quote: { prospect_state_code: "" }, lead: { state_code: null } });
    expect(buyerStateKnown(buyer)).toBe(false);
  });
  it("a typed-prospect export quote stays export", () => {
    expect(buyerStateKnown(paymentBuyerPlace({ quote: { prospect_state_code: null, prospect_country: "Singapore" } }))).toBe(true);
  });
});

describe("quoteStateCode / quoteStateToFill (R-447)", () => {
  it.each([["07", "07"], ["7", "07"], [" 29 ", "29"], ["", null], [null, null], ["DL", null], ["00", null], ["123", null]])(
    "%s → %s", (raw, want) => expect(quoteStateCode({ prospect_state_code: raw as string | null })).toBe(want),
  );
  it("fills only a blank customer state from a valid quote state", () => {
    expect(quoteStateToFill({ state_code: null }, { prospect_state_code: "07" })).toBe("07");
    expect(quoteStateToFill({ state_code: " " }, { prospect_state_code: "07" })).toBe("07");
  });
  it("never overwrites a recorded state, nor one the GSTIN proves", () => {
    expect(quoteStateToFill({ state_code: "06" }, { prospect_state_code: "07" })).toBeNull();
    expect(quoteStateToFill({ state_code: null, gstin: DELHI_GSTIN }, { prospect_state_code: "29" })).toBeNull();
  });
  it("never guesses: no customer or no quote state → nothing", () => {
    expect(quoteStateToFill(null, { prospect_state_code: "07" })).toBeNull();
    expect(quoteStateToFill({ state_code: null }, { prospect_state_code: null })).toBeNull();
  });
});
