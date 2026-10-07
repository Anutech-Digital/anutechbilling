import { describe, it, expect } from "vitest";
import { paymentDomainDefault } from "./payment-domain";

describe("the report: the domain did not pre-fill", () => {
  it("uses the domain on the quote", () => {
    /* Q-TEST-2026-27-0009, exactly as it stands in the database: the quote carries
       "xyz.cloudsolutions" and the customer row has nothing. The old expression looked at
       the customer and the lead only, so the field opened empty on a quote that had the
       answer written on it. */
    expect(paymentDomainDefault({
      quoteDomain: "xyz.cloudsolutions",
      customerDomain: null,
      leadDomain: null,
    })).toBe("xyz.cloudsolutions");
  });

  it("prefers the quote over the customer's general domain", () => {
    /* A customer on acme.com buying a second Workspace for acme.in has that on the quote.
       Taking their older customer-level domain would provision the wrong one — and it
       would not even collide, because the subscription index is on
       (tenant, quote, lower(domain)); it would just become a subscription for a domain
       nobody sold. */
    expect(paymentDomainDefault({
      quoteDomain: "acme.in",
      customerDomain: "acme.com",
      leadDomain: "acme-old.com",
    })).toBe("acme.in");
  });

  it("still falls back the way it always did", () => {
    /* The previous behaviour has to survive: this fixes an omission, it does not replace
       the chain. */
    expect(paymentDomainDefault({ customerDomain: "acme.com", leadDomain: "old.com" })).toBe("acme.com");
    expect(paymentDomainDefault({ leadDomain: "old.com" })).toBe("old.com");
  });
});

describe("a value that exists without meaning anything", () => {
  it("skips a blank quote domain instead of letting it win", () => {
    /* A form that saved "" must not out-rank a real domain further down — that is the same
       shape of bug as the one being fixed here. */
    expect(paymentDomainDefault({ quoteDomain: "", customerDomain: "acme.com" })).toBe("acme.com");
    expect(paymentDomainDefault({ quoteDomain: "   ", customerDomain: "acme.com" })).toBe("acme.com");
  });

  it("trims what it returns", () => {
    expect(paymentDomainDefault({ quoteDomain: "  acme.in  " })).toBe("acme.in");
  });

  it("returns undefined when nobody knows", () => {
    /* undefined, not null or "" — it is handed straight to a prop, and an empty string
       would look like a deliberate blank rather than an absent value. */
    expect(paymentDomainDefault({})).toBeUndefined();
    expect(paymentDomainDefault({ quoteDomain: null, customerDomain: null, leadDomain: "  " })).toBeUndefined();
  });
});

describe("R-379 (j): a domain already on a subscription", () => {
  it("customer row has no domain, but their subscription does → prefilled (Q-FBB9-27-0011)", () => {
    expect(paymentDomainDefault({
      quoteDomain: null, customerDomain: null,
      customerSubscriptionDomains: [null, "testsharmatraders.in"],
    })).toBe("testsharmatraders.in");
  });
  it("this quote's own subscription (credit activation) beats the customer's general domain", () => {
    expect(paymentDomainDefault({
      customerDomain: "acme.com", quoteSubscriptionDomains: ["acme.in"],
    })).toBe("acme.in");
  });
  it("the quote's own domain still wins, and the lead stays last", () => {
    expect(paymentDomainDefault({ quoteDomain: "q.in", quoteSubscriptionDomains: ["s.in"] })).toBe("q.in");
    expect(paymentDomainDefault({ leadDomain: "lead.in", customerSubscriptionDomains: ["  "] })).toBe("lead.in");
  });
});
