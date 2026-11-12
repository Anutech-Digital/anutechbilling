/**
 * R-2715 — one duplicate-customer rule for the Onboard dialog and /customers/new.
 * Pratik's case (12 Nov audit, report 6): "Forza Medi India Private Limited" must find
 * "FORZA MEDI ( INDIA) Pvt. Ltd".
 */
import { describe, it, expect } from "vitest";
import { businessDomain, companyKey, findCustomerMatches, gstinKey, matchReasonText } from "./duplicate-match";

const list = [
  { id: "forza", name: "FORZA MEDI ( INDIA) Pvt. Ltd", domain: "forzamedi.com", gstin: "07AABCF1234K1Z5", contact_email: "accounts@forzamedi.com" },
  { id: "acme", name: "Acme Traders LLP", domain: "acme.in", gstin: null, contact_email: "ravi@gmail.com" },
  { id: "sharma", name: "Sharma Cloud Solutions Private Limited", domain: null, gstin: "27AAACS9999A1Z1", contact_email: null },
  { id: "acme2", name: "Acme Exports", domain: null, gstin: null, contact_email: null },
];
const ids = (typed: Parameters<typeof findCustomerMatches>[1], limit?: number) =>
  findCustomerMatches(list, typed, limit).map((m) => `${m.customer.id}:${m.reason}`);

describe("companyKey — legal form, punctuation and spacing do not count", () => {
  it("Pvt Ltd / Private Limited / Pvt. Ltd. / LLP / Limited are the same company", () => {
    const k = companyKey("Forza Medi");
    for (const n of ["Forza Medi Pvt Ltd", "Forza Medi Private Limited", "FORZA MEDI PVT. LTD.", "Forza Medi LLP",
      "Forza  Medi Limited", "Forza-Medi Pvt.Ltd.", "FORZA MEDI ( INDIA) Pvt. Ltd", "Forza Medi India Private Limited"]) {
      expect(companyKey(n), n).toBe(k);
    }
  });
  it("& and 'and' are the same; a different company stays different", () => {
    expect(companyKey("R & D Labs Pvt Ltd")).toBe(companyKey("R and D Labs Private Limited"));
    expect(companyKey("Forza Pharma Pvt Ltd")).not.toBe(companyKey("Forza Medi Pvt Ltd"));
  });
  it("(P) Ltd / P. Ltd is Private Limited", () => {
    expect(companyKey("Forza Medi (P) Ltd")).toBe(companyKey("Forza Medi Private Limited"));
    expect(companyKey("Forza Medi P. Ltd.")).toBe("forzamedi");
  });
  it("India in the middle of a name is kept", () => {
    expect(companyKey("India Steel Ltd")).toBe("indiasteel");
  });
});

describe("findCustomerMatches", () => {
  it("Pratik's case: the full legal name finds the short-form customer", () => {
    expect(ids({ name: "Forza Medi India Private Limited" })).toEqual(["forza:name"]);
  });
  it("same GSTIN wins over everything, whatever the case/spaces", () => {
    expect(ids({ name: "Totally Different", gstin: " 07aabcf1234k1z5 " })).toEqual(["forza:gstin"]);
  });
  it("a business email domain matches the customer's website or contact email", () => {
    expect(ids({ name: "", email: "neha@forzamedi.com" })).toEqual(["forza:email-domain"]);
  });
  it("gmail / yahoo / outlook never match on domain", () => {
    expect(ids({ email: "someone@gmail.com" })).toEqual([]);
    expect(ids({ email: "x@yahoo.co.in" })).toEqual([]);
    expect(ids({ email: "x@outlook.com" })).toEqual([]);
  });
  it("a half-typed suffix or 'India' keeps the hint while typing", () => {
    for (const t of ["Forza Medi P", "Forza Medi Pv", "Forza Medi In"]) {
      expect(ids({ name: t }), t).toEqual(["forza:typing"]);
    }
  });
  it("zoho.com (a sign-up free-mail domain) never matches", () => {
    expect(ids({ email: "x@zoho.com" })).toEqual([]);
  });
  it("only a legal suffix typed matches nobody", () => {
    expect(ids({ name: "Pvt Ltd" })).toEqual([]);
    expect(ids({ name: "Private Limited" })).toEqual([]);
  });
  it("typing keeps working: every word, joined words, and the domain", () => {
    expect(ids({ name: "acme" })).toEqual(["acme:typing", "acme2:typing"]);
    expect(ids({ name: "sharmacloud" })).toEqual(["sharma:typing"]);
    expect(ids({ name: "acme.in" })).toEqual(["acme:typing"]);
    expect(ids({ name: "a" })).toEqual([]);
  });
  it("an exact company comes before a typing hit, and the list is capped", () => {
    expect(ids({ name: "Acme Exports Pvt Ltd" })[0]).toBe("acme2:name");
    expect(ids({ name: "ac" }, 1)).toHaveLength(1);
  });
  it("one customer is listed once, under its strongest reason", () => {
    expect(ids({ name: "Forza Medi", gstin: "07AABCF1234K1Z5", email: "a@forzamedi.com" })).toEqual(["forza:gstin"]);
  });
});

describe("helpers", () => {
  it("gstinKey needs 15 characters", () => {
    expect(gstinKey("07AABCF1234K1Z")).toBe("");
    expect(gstinKey("07aabcf1234k1z5")).toBe("07AABCF1234K1Z5");
  });
  it("businessDomain reads emails and websites", () => {
    expect(businessDomain("https://www.Acme.in/about")).toBe("acme.in");
    expect(businessDomain("A@Acme.in")).toBe("acme.in");
    expect(businessDomain("a@googlemail.com")).toBe("");
    expect(businessDomain("nodomain")).toBe("");
  });
  it("reason text", () => {
    expect(matchReasonText("gstin")).toBe("same GSTIN");
    expect(matchReasonText("typing")).toBeNull();
  });
});
