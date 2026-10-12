import { describe, it, expect } from "vitest";
import { sanitizeEntries, cleanDate, dataEntryPrompt, proposalKeys, MAX_PROPOSALS } from "./data-entry";
import { isValidGstin } from "@/lib/utils";

const TODAY = "2026-10-02";
const GOOD_GSTIN = "27AAPFU0939F1ZV";

describe("AI data entry — the model's JSON is untrusted", () => {
  it("keeps a clean lead and normalises its phone and email", () => {
    const [p] = sanitizeEntries({ entries: [{ kind: "lead", confidence: 0.9, why: "asked for 15 seats",
      fields: { company: "Sharma Traders", contact_name: "Ramesh Sharma", contact_phone: "98765 43210", contact_email: "RAMESH@Sharma.IN", seats: "15", follow_up_date: "2026-10-03" } }] }, TODAY);
    expect(p.kind).toBe("lead");
    expect(p.fields).toMatchObject({ contact_phone: "+919876543210", contact_email: "ramesh@sharma.in", seats: 15, follow_up_date: "2026-10-03" });
  });

  it("turns a misread into null, never a plausible wrong value", () => {
    const [p] = sanitizeEntries({ entries: [{ kind: "customer", fields: { name: "Acme", contact_name: "A", gstin: "27AAAAA0000A1Z0", contact_email: "not-an-email", contact_phone: "123" } }] }, TODAY);
    expect(p.fields).toMatchObject({ gstin: null, contact_email: null, contact_phone: null });
    expect(p.gstinTyped).toBe("27AAAAA0000A1Z0");
  });

  it("keeps a GSTIN that passes the checksum", () => {
    expect(isValidGstin(GOOD_GSTIN)).toBe(true);
    const [p] = sanitizeEntries({ entries: [{ kind: "vendor_bill", fields: { vendor_name: "Google", vendor_gstin: GOOD_GSTIN, total: "11800", bill_date: "2026-09-30" } }] }, TODAY);
    expect(p.fields).toMatchObject({ vendor_gstin: GOOD_GSTIN, total: 11800, bill_date: "2026-09-30" });
  });

  it("drops amounts that cannot be real and entries with nothing usable", () => {
    const out = sanitizeEntries({ entries: [
      { kind: "expense", fields: { amount: -50 } },
      { kind: "expense", fields: { amount: 5e9 } },
      { kind: "lead", fields: {} },
      { kind: "dance", fields: { amount: 1 } },
      { kind: "expense", fields: { amount: "1,250", category: "travel", vendor_name: "Uber" } },
    ] }, TODAY);
    expect(out).toHaveLength(1);
    expect(out[0].fields).toMatchObject({ amount: 1250, category: "Travel", expense_date: TODAY });
  });

  it("an unknown expense category becomes Other", () => {
    const [p] = sanitizeEntries({ entries: [{ kind: "expense", fields: { amount: 100, category: "Snacks for team" } }] }, TODAY);
    expect((p.fields as { category: string }).category).toBe("Other");
  });

  it("dates must be real and near today", () => {
    expect(cleanDate("2026-02-30", TODAY)).toBeNull();
    expect(cleanDate("1999-01-01", TODAY)).toBeNull();
    expect(cleanDate("03/10/2026", TODAY)).toBeNull();
    expect(cleanDate("2026-10-03", TODAY)).toBe("2026-10-03");
  });

  it("caps the number of proposals and survives garbage", () => {
    const many = Array.from({ length: 25 }, (_, i) => ({ kind: "task", fields: { title: `Call ${i}` } }));
    expect(sanitizeEntries({ entries: many }, TODAY)).toHaveLength(MAX_PROPOSALS);
    expect(sanitizeEntries(null, TODAY)).toEqual([]);
    expect(sanitizeEntries({ entries: "x" }, TODAY)).toEqual([]);
  });

  it("a payment is kept as a proposal with a known method only", () => {
    const [p] = sanitizeEntries({ entries: [{ kind: "payment", fields: { payer: "Thetaco Dentals", amount: 31053, method: "UPI", reference: "UTR123" } }] }, TODAY);
    expect(p.fields).toMatchObject({ amount: 31053, method: "upi" });
    const [q] = sanitizeEntries({ entries: [{ kind: "payment", fields: { amount: 10, method: "bitcoin" } }] }, TODAY);
    expect((q.fields as { method: string | null }).method).toBeNull();
  });

  it("the prompt tells the model today's date and the real expense categories", () => {
    const p = dataEntryPrompt(TODAY);
    expect(p).toContain("Today is 2026-10-02");
    expect(p).toContain("Office Supplies");
  });

  it("duplicate keys come from the fields a lookup can use", () => {
    const [p] = sanitizeEntries({ entries: [{ kind: "lead", fields: { company: "Sharma Traders", contact_phone: "9876543210" } }] }, TODAY);
    expect(proposalKeys(p)).toEqual({ phones: ["+919876543210"], emails: [], gstins: [], names: ["Sharma Traders"] });
  });
  it("money given to our own staff for expenses is an employee advance", () => {
    const [p] = sanitizeEntries({ entries: [{ kind: "employee_advance", fields: { employee_name: "Prashant", amount: "5000", method: "NEFT", purpose: "kharche" } }] }, TODAY);
    expect(p.kind).toBe("employee_advance");
    expect(p.fields).toMatchObject({ employee_name: "Prashant", amount: 5000, date: TODAY, method: "bank_transfer" });
    expect(dataEntryPrompt(TODAY)).toContain("employee_advance");
  });
});
