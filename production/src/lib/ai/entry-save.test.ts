import { describe, it, expect } from "vitest";
import { advanceFormHref, leadInsert, customerInsert, expenseInsert, vendorBillInsert, taskInsert, missingFor, warningsFor } from "./entry-save";
import type { EntryProposal } from "./data-entry";

const TODAY = "2026-10-02";
const US = { stateCode: "07", gstin: null };

describe("AI Entry → the insert the normal form would make", () => {
  it("a lead is marked as coming from AI entry and owned by whoever saved it", () => {
    const l = leadInsert({ company: "Sharma Traders", contact_name: "Ramesh", contact_email: null, contact_phone: "+919876543210", plan: null, seats: 15, domain: null, notes: null, follow_up_date: "2026-10-03" }, { userId: "u1" }, 1);
    expect(l).toMatchObject({ id: "L-1", source: "ai-entry", stage: "new", owner_id: "u1", created_by: "u1", seats: 15, follow_up_date: "2026-10-03" });
  });
  it("a customer's state comes from its GSTIN", () => {
    expect(customerInsert({ name: "Acme", contact_name: "A", contact_email: null, contact_phone: null, gstin: "27AAPFU0939F1ZV", domain: null, address: null }))
      .toMatchObject({ state_code: "27", state: "Maharashtra" });
  });
  it("R-174: without a GSTIN, a state named in the input becomes the place of supply — never a guess", () => {
    const base = { name: "Acme", contact_name: "A", contact_email: null, contact_phone: null, gstin: null, domain: null, address: null };
    expect(customerInsert({ ...base, state: "Punjab" })).toMatchObject({ state_code: "03", state: "Punjab" });
    expect(customerInsert({ ...base, state: "Dilli" })).not.toHaveProperty("state_code");
  });
  it("an expense with a payment mode is booked as paid that day", () => {
    expect(expenseInsert({ vendor_name: "Uber", amount: 349.6, expense_date: "2026-10-01", category: "Travel", description: null, paid_by: "upi" }))
      .toMatchObject({ amount: 350, paid: true, paid_date: "2026-10-01", payment_method: "upi" });
    expect(expenseInsert({ vendor_name: null, amount: 100, expense_date: "2026-10-01", category: "Other", description: null, paid_by: null }).paid).toBe(false);
  });
  it("a bill without a subtotal derives it from total less tax", () => {
    expect(vendorBillInsert({ vendor_name: "X", vendor_gstin: null, bill_no: "1", bill_date: "2026-09-30", subtotal: null, cgst: 900, sgst: 900, igst: null, total: 11_800, buyer_gstin: null, paid_by: null }).subtotal).toBe(10_000);
  });
  it("a follow-up is due at 10:00 IST", () => {
    expect(taskInsert({ title: "Call Sharma ji", due_date: "2026-10-03", company: null }).due_at).toBe("2026-10-03T10:00:00+05:30");
  });
  it("says what is missing instead of failing on save", () => {
    expect(missingFor({ kind: "customer", confidence: 1, why: "", fields: { name: "Acme", contact_name: null, contact_email: null, contact_phone: null, gstin: null, domain: null, address: null } })).toMatch(/contact person/);
    // R-174: a customer with neither a GSTIN nor a GST state name cannot be invoiced.
    expect(missingFor({ kind: "customer", confidence: 1, why: "", fields: { name: "Acme", contact_name: "A", contact_email: null, contact_phone: null, gstin: null, domain: null, address: null } })).toMatch(/state/);
    expect(missingFor({ kind: "customer", confidence: 1, why: "", fields: { name: "Acme", contact_name: "A", contact_email: null, contact_phone: null, gstin: null, domain: null, address: null, state: "Kerala" } })).toBeNull();
    expect(missingFor({ kind: "expense", confidence: 1, why: "", fields: { vendor_name: null, amount: null, expense_date: TODAY, category: "Other", description: null, paid_by: null } })).toMatch(/amount/);
  });
  it("law checks follow the proposal kind, and use the year-to-date paid", () => {
    const exp: EntryProposal = { kind: "expense", confidence: 1, why: "", fields: { vendor_name: "CA Sharma", amount: 20_000, expense_date: TODAY, category: "Professional Services", description: null, paid_by: "bank" } };
    expect(warningsFor(exp, US, TODAY)).toEqual([]);
    expect(warningsFor(exp, US, TODAY, { vendorYtd: 40_000 }).map((w) => w.code)).toEqual(["tds-194J"]);
    const cust: EntryProposal = { kind: "customer", confidence: 1, why: "", gstinTyped: "27AAAAA0000A1Z0", fields: { name: "A", contact_name: "B", contact_email: null, contact_phone: null, gstin: null, domain: null, address: null } };
    expect(warningsFor(cust, US, TODAY).map((w) => w.code)).toEqual(["gstin-invalid"]);
  });
  it("an employee advance opens the Give advance form, filled", () => {
    expect(advanceFormHref({ employee_name: "Prashant", amount: 5000, date: "2026-10-02", method: null, purpose: "Office expenses" }))
      .toBe("/accounting/advances?give=1&name=Prashant&amount=5000&date=2026-10-02&purpose=Office+expenses");
  });
});
