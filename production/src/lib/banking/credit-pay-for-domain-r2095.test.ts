/**
 * R-2095 (30 Oct 2026, September reconcile): Zoho bills Workspace per END-domain — one customer can
 * buy for shop.example.in and example.in on one receipt. The new-sale form now asks the end-domain
 * on each subscription line (empty = the customer's domain); it reaches the quote line, and
 * record_payment files the subscription on it (R-829).
 */
import { describe, it, expect } from "vitest";
import { saleLinesPayload, saleLineDomainProblem, type SaleLine } from "./credit-pay-for";

const line = (p: Partial<SaleLine>): SaleLine => ({
  itemId: "i1", name: "Google Workspace Business Starter", qty: 1, rate: 3240, cost: 0, cycle: "annual_yearly", perSeat: true, ...p,
} as SaleLine);

describe("R-2095 end-domain per sale line", () => {
  it("a typed domain is sent, trimmed and lower-cased", () => {
    expect(saleLinesPayload([line({ domain: "  Shop.Example.IN " })])[0]).toMatchObject({ domain: "shop.example.in" });
  });
  it("no domain → no key (the customer's domain, as before)", () => {
    expect(saleLinesPayload([line({})])[0]).not.toHaveProperty("domain");
    expect(saleLinesPayload([line({ domain: "  " })])[0]).not.toHaveProperty("domain");
  });
  it("a one-time line never sends a domain", () => {
    expect(saleLinesPayload([line({ cycle: "one_time", domain: "x.in" })])[0]).not.toHaveProperty("domain");
  });
  it("a malformed domain is flagged before save", () => {
    expect(saleLineDomainProblem("not a domain")).toMatch(/example\.com/);
    expect(saleLineDomainProblem("shop.example.in")).toBeNull();
    expect(saleLineDomainProblem("")).toBeNull();
  });
});
