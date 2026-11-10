/**
 * R-2519c (re-review v14 small follow-ups): a part request is never deleted (only cancelled), and a
 * part billed ahead that the customer's money already covers says so instead of "nothing billed".
 */
import { describe, it, expect } from "vitest";
import { quoteDeleteBlockReason } from "@/lib/quotes/deletable";
import { paidAheadReason, applyBillOutcome } from "./part-requests";

describe("R-2519c — Delete quote is never offered on a proforma for a subscription part", () => {
  it("open or cancelled part request → blocked with the Cancel way; an ordinary quote → deletable", () => {
    expect(quoteDeleteBlockReason({ payment_status: "awaiting", subscription_billing_id: "b-1" })).toMatch(/never deleted.*Cancel proforma/);
    expect(quoteDeleteBlockReason({ payment_status: "none", subscription_billing_id: null, cancelled_part_billing_id: "b-1" })).toMatch(/never deleted/);
    expect(quoteDeleteBlockReason({ payment_status: "awaiting" })).toBeNull();
  });
});

describe("R-2519c — paid ahead", () => {
  it("the billing answer keeps its reason, and the message names the date", () => {
    const tally = { raised: [], alreadyRaised: 0, wouldRaise: 0, requests: [], requestsOpen: [], wouldRequest: 0 } as Parameters<typeof applyBillOutcome>[0];
    applyBillOutcome(tally, 1, { action: "waiting", reason: "paid_ahead", subscription_ids: [], bill_on: "2026-11-12" }, false);
    expect(paidAheadReason(tally.waiting, (d) => `[${d}]`)).toBe(
      "Already paid — the customer's money covers this period, so no proforma was made. Its tax invoice is raised on its date ([2026-11-12]).");
    expect(paidAheadReason([{ reason: "siblings_not_laid" }], (d) => d)).toBeNull();
    expect(paidAheadReason(undefined, (d) => d)).toBeNull();
  });
});
