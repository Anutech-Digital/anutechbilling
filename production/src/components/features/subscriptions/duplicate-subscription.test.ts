/**
 * R-1443 — the same customer + domain + item must not become two subscriptions (Pardeep,
 * staging 14 Oct: "verify first or warn before the duplicate entry"), and typing a company
 * that already exists should offer it (Pratik, 14 Oct).
 */
import { describe, it, expect } from "vitest";
import { duplicateSubscriptionText, findDuplicateSubscription, matchCustomers, type ExistingSub } from "./duplicate-subscription";

const subs: ExistingSub[] = [
  { id: "s1", customer_id: "c1", domain: "Acme.in", plan: "Google Workspace Business Starter", item_id: "gw-start", status: "active" },
  { id: "s2", customer_id: "c1", domain: "acme.in", plan: "Old plan", item_id: "gw-plus", status: "cancelled" },
  { id: "s3", customer_id: "c2", domain: "acme.in", plan: "Google Workspace Business Starter", item_id: "gw-start", status: "active" },
  { id: "s4", customer_id: "c1", domain: "acme.in", plan: "Custom backup", item_id: null, status: "paused" },
];

describe("R-1443 findDuplicateSubscription", () => {
  it("same customer + domain (any case, with https://) + catalogue item -> the live row", () => {
    expect(findDuplicateSubscription(subs, { customerId: "c1", domain: "https://ACME.in/", itemId: "gw-start", plan: "x" })?.id).toBe("s1");
  });
  it("a different item for the same customer and domain is allowed", () => {
    expect(findDuplicateSubscription(subs, { customerId: "c1", domain: "acme.in", itemId: "m365-basic", plan: "M365 Basic" })).toBeNull();
  });
  it("a different domain is allowed", () => {
    expect(findDuplicateSubscription(subs, { customerId: "c1", domain: "acme.com", itemId: "gw-start", plan: "x" })).toBeNull();
  });
  it("a cancelled or expired row does not block", () => {
    expect(findDuplicateSubscription(subs, { customerId: "c1", domain: "acme.in", itemId: "gw-plus", plan: "Old plan" })).toBeNull();
  });
  it("a custom plan (no item) matches by plan name; a suspended row still counts", () => {
    expect(findDuplicateSubscription(subs, { customerId: "c1", domain: "acme.in", itemId: null, plan: " custom BACKUP " })?.id).toBe("s4");
  });
  it("a row the paid path filed as 'Plan (5 seats)' with no item link still matches the plan", () => {
    const paid: ExistingSub[] = [{ id: "p1", customer_id: "c9", domain: "z.in", plan: "Google Workspace Business Starter (5 seats)", item_id: null, status: "active" }];
    expect(findDuplicateSubscription(paid, { customerId: "c9", domain: "z.in", itemId: "gw-start", plan: "Google Workspace Business Starter" })?.id).toBe("p1");
  });
  it("no customer yet (a new one) -> nothing to duplicate", () => {
    expect(findDuplicateSubscription(subs, { customerId: "", domain: "acme.in", itemId: "gw-start", plan: "x" })).toBeNull();
  });
});

describe("R-1443 matchCustomers (typeahead under Company Name)", () => {
  const list = [
    { id: "c1", name: "Acme Traders", domain: "acme.in" },
    { id: "c2", name: "Sharma Cloud Solutions", domain: "sharmacloud.com" },
    { id: "c3", name: "Acme Exports", domain: null },
  ];
  it("needs 2+ letters", () => {
    expect(matchCustomers(list, "a")).toEqual([]);
  });
  it("matches every typed word in the name, case-insensitive", () => {
    expect(matchCustomers(list, "acme tra").map((c) => c.id)).toEqual(["c1"]);
    expect(matchCustomers(list, "ACME").map((c) => c.id)).toEqual(["c1", "c3"]);
  });
  it("matches the domain too", () => {
    expect(matchCustomers(list, "sharmacloud").map((c) => c.id)).toEqual(["c2"]);
  });
  it("an exact name comes first", () => {
    expect(matchCustomers(list, "acme exports").map((c) => c.id)[0]).toBe("c3");
  });
  it("caps the list", () => {
    expect(matchCustomers(list, "ac", 1)).toHaveLength(1);
  });
});

/* R-2179 (August reconcile): an Opening subscription for a product + domain the customer already had
   gave no warning — the old row was filed with no domain of its own (empty = the customer's domain).
   The warning now also names its seats and renewal date and the way on (Manage seats / Correct details). */
describe("R-2179 duplicate warning — the customer's own domain, and what the row is", () => {
  const noDomain: ExistingSub[] = [
    { id: "d1", customer_id: "c5", domain: null, plan: "Google Workspace Business Starter", item_id: "gw-start", status: "active", seats: 12, renewal_date: "2027-03-31" },
  ];
  it("a live row with no domain is on the customer's domain", () => {
    expect(findDuplicateSubscription(noDomain, { customerId: "c5", domain: "orbit5.in", itemId: "gw-start", plan: "x", customerDomain: "Orbit5.in" })?.id).toBe("d1");
  });
  it("…but not on another domain", () => {
    expect(findDuplicateSubscription(noDomain, { customerId: "c5", domain: "shop.orbit5.in", itemId: "gw-start", plan: "x", customerDomain: "orbit5.in" })).toBeNull();
  });
  it("an empty wanted domain means the customer's domain too", () => {
    expect(findDuplicateSubscription(noDomain, { customerId: "c5", domain: "", itemId: "gw-start", plan: "x", customerDomain: "orbit5.in" })?.id).toBe("d1");
  });
  it("the text names product, domain, seats, renewal and the way on", () => {
    expect(duplicateSubscriptionText(noDomain[0], { plan: "x", domain: "orbit5.in" })).toBe(
      "This customer already has Google Workspace Business Starter on orbit5.in (12 seats, renews 31 Mar 2027) — use Manage seats or Correct details instead.",
    );
    expect(duplicateSubscriptionText({ ...noDomain[0], seats: null, renewal_date: null, plan: null }, { plan: "Plan B", domain: "a.in" })).toBe(
      "This customer already has Plan B on a.in — use Manage seats or Correct details instead.",
    );
  });
});
