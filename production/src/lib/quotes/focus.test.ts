import { describe, it, expect } from "vitest";
import { quoteInFocus, focusValue } from "./focus";
import { quoteListTab } from "./list-tab";

/* R-489 (on R-469): local ANUTECH, 9 Oct — header "Out for review ₹73.3K (2)" while the Sent
   and Viewed tabs both showed 0. Both quotes were status 'sent' with payment_status
   'awaiting', which the tabs file under Awaiting payment. */
describe("Out for review = the Sent + Viewed tabs", () => {
  const sentAwaiting = { status: "sent", payment_status: "awaiting", invoice_id: null, amount: 72641 };
  const sentInvoiced = { status: "sent", payment_status: "invoiced", invoice_id: "INV-1", amount: 4720, payment_amount: 0 };
  const plainSent    = { status: "sent", payment_status: "none", invoice_id: null, amount: 590 };
  const viewed       = { status: "viewed", payment_status: null, invoice_id: null, amount: 1000 };

  it("a sent quote already awaiting payment or invoiced is not out for review", () => {
    expect(quoteListTab(sentAwaiting)).toBe("awaiting");
    expect(quoteInFocus(sentAwaiting, "review")).toBe(false);
    expect(quoteInFocus(sentInvoiced, "review")).toBe(false);
  });
  it("plain sent and viewed quotes are", () => {
    expect(quoteInFocus(plainSent, "review")).toBe(true);
    expect(quoteInFocus(viewed, "review")).toBe(true);
  });
  it("the tile total equals the two tabs' rows", () => {
    const all = [sentAwaiting, sentInvoiced, plainSent, viewed];
    const inTabs = all.filter((q) => ["sent", "viewed"].includes(quoteListTab(q)));
    expect(focusValue(all, "review")).toBe(inTabs.reduce((s, q) => s + q.amount, 0));
  });
});
