/**
 * R-1121 — the quote page and the customer page read only their own rows, not whole tables.
 * doneWhen: /quotes/[id] has no unfiltered subscriptions request.
 */
import { describe, expect, it } from "vitest";
import { quoteSubscriptionsOr } from "./subscriptions";
import { customerPaymentsOr } from "./payments";

const CUST = "11111111-2222-3333-4444-555555555555";
const SUB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

describe("quoteSubscriptionsOr (R-1121)", () => {
  it("the quote's own, the renewal's and the customer's subscriptions — one filter, never empty", () => {
    expect(quoteSubscriptionsOr({ id: "Q-2026-27-0042", customer_id: CUST, renewal_subscription_id: SUB })).toBe(
      `quote_id.eq."Q-2026-27-0042",renewal_quote_id.eq."Q-2026-27-0042",id.eq.${SUB},customer_id.eq.${CUST}`,
    );
  });

  it("a prospect quote (no customer) still filters by the quote", () => {
    expect(quoteSubscriptionsOr({ id: "Q-1" })).toBe('quote_id.eq."Q-1",renewal_quote_id.eq."Q-1"');
  });

  it("a value that is not a uuid cannot widen the filter", () => {
    const or = quoteSubscriptionsOr({ id: 'Q-1"),id.neq.(x', customer_id: "x,customer_id.neq.y", renewal_subscription_id: "nope" });
    expect(or).not.toContain("customer_id");
    expect(or).not.toContain("id.eq.nope");
    expect(or.match(/"/g)?.length).toBe(4);   // the quote id stays inside its quotes
  });
});

describe("customerPaymentsOr (R-1121)", () => {
  it("the customer's payments and their quotes' payments", () => {
    expect(customerPaymentsOr(CUST, ["Q-1", "Q-2", "Q-1"])).toBe(`customer_id.eq.${CUST},quote_id.in.("Q-1","Q-2")`);
  });

  it("no quotes → only the customer's own", () => {
    expect(customerPaymentsOr(CUST, [])).toBe(`customer_id.eq.${CUST}`);
  });
});
