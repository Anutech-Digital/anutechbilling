import { describe, expect, it } from "vitest";
import { quoteMissing, quoteMissingMessage, type QuoteForm } from "./quote-missing";

const full: QuoteForm = { lineCount: 1, company: "Acme Pvt Ltd", name: "Ravi Kumar", phone: "98765 43210", email: "ravi@acme.in", gstin: "" };
const keys = (f: Partial<QuoteForm>) => quoteMissing({ ...full, ...f }).map((m) => m.key);

describe("R-1461 quote page: name exactly what is missing", () => {
  it("a complete form has nothing missing and no message", () => {
    expect(quoteMissing(full)).toEqual([]);
    expect(quoteMissingMessage([])).toBe("");
  });

  it("items chosen, no contact → only the contact fields, in on-screen order, no 'line'", () => {
    const m = quoteMissing({ ...full, company: "", name: "", phone: "", email: "" });
    expect(m.map((x) => x.key)).toEqual(["company", "name", "phone", "email"]);
    const msg = quoteMissingMessage(m);
    expect(msg).not.toMatch(/line/i);
    expect(msg).toBe("Still needed: company, your name, 10-digit mobile and email.");
  });

  it("no items, contact complete → only the lines message", () => {
    expect(keys({ lineCount: 0 })).toEqual(["lines"]);
    expect(quoteMissingMessage(quoteMissing({ ...full, lineCount: 0 }))).toBe("Still needed: at least one line.");
  });

  it("several combinations name only the broken parts", () => {
    expect(keys({ email: "ravi.acme.in" })).toEqual(["email"]);
    expect(keys({ phone: "12345" })).toEqual(["phone"]);
    expect(keys({ name: " R " })).toEqual(["name"]);
    expect(keys({ gstin: "07ABC" })).toEqual(["gstin"]);
    expect(keys({ gstin: "07AABCU9603R1ZX" })).toEqual([]);
    expect(keys({ lineCount: 0, phone: "", gstin: "07ABC" })).toEqual(["lines", "phone", "gstin"]);
    expect(quoteMissingMessage(quoteMissing({ ...full, phone: "1", email: "x" }))).toBe("Still needed: 10-digit mobile and email.");
  });

  it("the phone rule matches the field's own rule (+91 / 0 allowed)", () => {
    expect(keys({ phone: "+91 98765 43210" })).toEqual([]);
    expect(keys({ phone: "098765 43210" })).toEqual([]);
  });
});
