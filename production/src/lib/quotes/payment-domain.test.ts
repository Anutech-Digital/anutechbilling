import { describe, it, expect } from "vitest";
import { paymentDomainDefault, pickDomainStampTarget, domainConflictsOf, domainConflictMessage } from "./payment-domain";

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

describe("R-389 (F8): the domain lands on ONE subscription of the quote", () => {
  /* Q-FBB9-27-0013: Workspace + Standard Support, both created on the first payment. */
  const kapoor = [
    { id: "sup", vendor: "support", domain: null },
    { id: "gw", vendor: "google", domain: null },
  ];

  it("picks the Workspace licence, not the support plan", () => {
    expect(pickDomainStampTarget(kapoor, "testkapoorexports.in")).toBe("gw");
  });

  it("never targets more than one row (the unique index refused the old all-rows update)", () => {
    const id = pickDomainStampTarget(kapoor, "testkapoorexports.in");
    expect(typeof id).toBe("string");
  });

  it("does nothing when a subscription of this quote already has the domain (second payment)", () => {
    const after = [{ id: "sup", vendor: "support", domain: null }, { id: "gw", vendor: "google", domain: "TestKapoorExports.in" }];
    expect(pickDomainStampTarget(after, "testkapoorexports.in")).toBeNull();
  });

  it("single subscription quote (Q-FBB9-27-0010) still gets it", () => {
    expect(pickDomainStampTarget([{ id: "a", vendor: "google", domain: null }], "x.in")).toBe("a");
  });

  it("falls back to the first blank row when none is a licence", () => {
    expect(pickDomainStampTarget([{ id: "h", vendor: "hosting" }, { id: "o", vendor: "other" }], "x.in")).toBe("h");
  });

  it("blank domain or no subscriptions → nothing", () => {
    expect(pickDomainStampTarget(kapoor, "  ")).toBeNull();
    expect(pickDomainStampTarget([], "x.in")).toBeNull();
    expect(pickDomainStampTarget([{ id: "a", vendor: "google", domain: "other.in" }], "x.in")).toBeNull();
  });
});

describe("R-829: a line's domain that could not be saved is never silent", () => {
  it("says nothing when record_payment kept every line's domain", () => {
    expect(domainConflictMessage({ domain_conflicts: [] })).toBeNull();
    expect(domainConflictMessage({ payment_id: "p" })).toBeNull(); // older function / replay
    expect(domainConflictMessage(null)).toBeNull();
  });

  it("names the line, plan and domain the same plan already had", () => {
    const r = { domain_conflicts: [{ line: 2, plan: "Google Workspace Business Starter", domain: "dup.in" }] };
    expect(domainConflictsOf(r)).toEqual([{ line: 2, plan: "Google Workspace Business Starter", domain: "dup.in" }]);
    const m = domainConflictMessage(r)!;
    expect(m.title).toBe("One subscription was created without its domain");
    expect(m.description).toContain("line 2 (Google Workspace Business Starter) — dup.in");
    expect(m.description).toContain("Subscriptions");
  });

  it("counts several, and ignores junk entries", () => {
    const m = domainConflictMessage({
      domain_conflicts: [{ line: 2, plan: "A", domain: "x.in" }, { line: 3, plan: "A", domain: "x.in" }, { line: 4 }, "bad"],
    })!;
    expect(m.title).toBe("2 subscriptions were created without their domain");
  });
});
