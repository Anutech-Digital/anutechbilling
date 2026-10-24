import { describe, it, expect } from "vitest";
import {
  dupCheckKeys, duplicateWarning, hasDupKeys, normEmail, normGstin, pickDuplicate, type LeadDuplicate,
} from "./duplicate-check";

const dup = (over: Partial<LeadDuplicate> = {}): LeadDuplicate => ({
  id: "L-1", company: "Acme Pvt Ltd", contact_name: "Ravi", stage: "quote", is_junk: false,
  owner_id: "u1", owner_name: "Pardeep", matched_on: ["email"], created_at: "2026-09-01T00:00:00Z", ...over,
});

describe("R-072 — which keys the form asks about", () => {
  it("sends email and GSTIN too, not only phone and company (the old check was phone + company)", () => {
    const k = dupCheckKeys({ email: " ravi@acme.in ", gstin: "07ABCDE1234F1Z5", phone: "", company: "" });
    expect(k).toEqual({ email: "ravi@acme.in", gstin: "07ABCDE1234F1Z5", phone: "", company: "" });
    expect(hasDupKeys(k)).toBe(true);
  });

  it("a half-typed key is not sent — nothing to ask", () => {
    const k = dupCheckKeys({ email: "ravi@", gstin: "07ABC", phone: "98111", company: "Co" });
    expect(k.gstin).toBe("");
    expect(k.phone).toBe("");
    expect(k.company).toBe("");
    // "ravi@" has an @ after the first character — the server decides; the TS only gates.
    expect(k.email).toBe("ravi@");
    expect(hasDupKeys(dupCheckKeys({}))).toBe(false);
  });

  it("company noise words alone are not a key", () => {
    expect(dupCheckKeys({ company: "Pvt Ltd" }).company).toBe("");
    expect(dupCheckKeys({ company: "Acme Pvt Ltd" }).company).toBe("Acme Pvt Ltd");
  });

  it("normEmail / normGstin", () => {
    expect(normEmail("A@B.in")).toBe("a@b.in");
    expect(normGstin("07abcde1234f1z5")).toBe("07ABCDE1234F1Z5");
    expect(normGstin("07ABCDE1234F1Z")).toBe("");
  });
});

describe("R-1821: a masked role gets matched_on 'possible' from the gateway", () => {
  it("the warning says 'possible duplicate' without naming the matched contact", () => {
    const w = duplicateWarning({
      id: "L-1", company: "Acme", contact_name: null, stage: "new", is_junk: false,
      owner_id: null, owner_name: null, matched_on: ["possible"], created_at: "2026-10-24T00:00:00Z",
    });
    expect(w.matched).toMatch(/^Possible duplicate/);
    expect(w.matched).not.toMatch(/phone|email/i);
  });
});

describe("the warning", () => {
  it('says "Ye pehle se hai: <company> (stage, owner)" and what matched', () => {
    const w = duplicateWarning(dup({ matched_on: ["gstin", "email"] }));
    expect(w.title).toBe("Already exists: Acme Pvt Ltd (Quote Sent, Pardeep)");
    expect(w.matched).toBe("Same GSTIN + email");
  });

  it("an unowned lead says so; a junk one says so", () => {
    expect(duplicateWarning(dup({ owner_id: null, owner_name: null })).title).toContain("(Quote Sent, unassigned)");
    expect(duplicateWarning(dup({ is_junk: true })).title).toContain("(Quote Sent, junk, Pardeep)");
  });

  it("falls back to the contact name when the company is blank", () => {
    expect(duplicateWarning(dup({ company: "" })).title).toBe("Already exists: Ravi (Quote Sent, Pardeep)");
  });

  it("names the strongest match; an existing customer's closed leads are history", () => {
    const rows = [dup({ id: "won", stage: "won" }), dup({ id: "open", stage: "demo" })];
    expect(pickDuplicate(rows, false)?.id).toBe("won");
    expect(pickDuplicate(rows, true)?.id).toBe("open");
    expect(pickDuplicate([dup({ stage: "lost" })], true)).toBeNull();
    expect(pickDuplicate(undefined, false)).toBeNull();
  });
});
