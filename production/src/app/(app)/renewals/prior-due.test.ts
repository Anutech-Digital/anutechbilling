import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { priorTermDue, priorTermDueText, renewalSubOfQuote } from "./prior-due";

/* R-1703 — the owner's record shape (local billing audit, T-A2): subscription owes ₹9,629 for
   its current term (its own quote accepted, unpaid); Renewals → Generate quote → renewal quote
   linked both ways (sub.renewal_quote_id + quote.renewal_subscription_id). */
const tA2 = { id: "sub-a2", outstanding_amount: 9629, written_off_at: null, renewal_quote_id: "Q-F588-27-0033", domain: "t-a2.test", customer_name: "T-A2" };
const other = { id: "sub-other", outstanding_amount: 500, written_off_at: null, renewal_quote_id: null, domain: "x.test", customer_name: "T-A2" };

describe("R-1703: 'Previous term ₹X still unpaid'", () => {
  it("says the previous term's unpaid amount", () => {
    expect(priorTermDueText(tA2)).toBe("Previous term ₹9,629 still unpaid");
  });

  it("is silent when nothing is owed or the balance was written off", () => {
    expect(priorTermDueText({ outstanding_amount: 0 })).toBeNull();
    expect(priorTermDueText({ outstanding_amount: null })).toBeNull();
    expect(priorTermDue({ outstanding_amount: 9629, written_off_at: "2026-10-01" })).toBe(0);
  });

  it("finds the renewal quote's subscription by the quote's OWN link, not by customer", () => {
    const quote = { id: "Q-F588-27-0033", is_renewal: true, renewal_subscription_id: "sub-a2" };
    expect(renewalSubOfQuote(quote, [other, tA2])?.id).toBe("sub-a2");
  });

  it("still finds it after payment cleared sub.renewal_quote_id (renewal_subscription_id stays)", () => {
    const paidSub = { ...tA2, renewal_quote_id: null };
    const quote = { id: "Q-F588-27-0033", is_renewal: true, renewal_subscription_id: "sub-a2" };
    expect(renewalSubOfQuote(quote, [other, paidSub])?.id).toBe("sub-a2");
  });

  it("older renewal quotes without renewal_subscription_id use the sub's renewal_quote_id", () => {
    const quote = { id: "Q-F588-27-0033", is_renewal: true, renewal_subscription_id: null };
    expect(renewalSubOfQuote(quote, [other, tA2])?.id).toBe("sub-a2");
  });

  it("a normal (non-renewal) quote shows no warning", () => {
    expect(renewalSubOfQuote({ id: "Q-F588-27-0033", is_renewal: false }, [tA2])).toBeUndefined();
  });

  it("the Renewals rows (phone + desktop) and the quote page render it", () => {
    const renewals = readFileSync("src/app/(app)/renewals/page.tsx", "utf8");
    expect(renewals).toMatch(/import \{ priorTermDueText \} from "\.\/prior-due"/);
    expect(renewals.match(/const priorDue = priorTermDueText\(sub\)/g)?.length).toBe(2);
    expect(renewals.match(/\{priorDue\}/g)?.length).toBe(2);

    const quotePage = readFileSync("src/app/(app)/quotes/[id]/page.tsx", "utf8");
    expect(quotePage).toMatch(/renewalSubOfQuote\(/);
    expect(quotePage).toMatch(/\{priorDueText\}/);
  });
});
