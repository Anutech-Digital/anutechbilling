import { describe, it, expect } from "vitest";
import { ownerPayCaution, employeeOwnerCaution, drawingsFromExpense } from "./owner-salary-guard";

const partners = [{ name: "Ravi Kumar", joined_on: null, left_on: null }, { name: "Sita Devi", joined_on: null, left_on: "2026-01-31" }];

describe("R-1846 ownerPayCaution — owner's 'salary' in the expense form", () => {
  it("proprietor + Director's Remuneration → caution (owner)", () => {
    const c = ownerPayCaution({ businessType: "proprietor", category: "Director's Remuneration", payee: "", text: "" });
    expect(c?.who).toBe("owner");
    expect(c?.body).toMatch(/not an expense/i);
  });

  it("proprietor + 'owner salary' written in the note → caution, whatever the category", () => {
    expect(ownerPayCaution({ businessType: "proprietor", category: "Office Supplies", text: "owner salary for October" })).not.toBeNull();
    expect(ownerPayCaution({ businessType: "proprietor", category: "", text: "apni salary" })).not.toBeNull();
    expect(ownerPayCaution({ businessType: "proprietor", category: "", payee: "Self", text: "my salary" })).not.toBeNull();
  });

  it("proprietor + an ordinary expense → no caution", () => {
    expect(ownerPayCaution({ businessType: "proprietor", category: "Office Rent", payee: "Sharma Properties", text: "October rent" })).toBeNull();
    // "Salaries" text about staff is Payroll's business, not drawings
    expect(ownerPayCaution({ businessType: "proprietor", category: "", text: "staff salary advance" })).toBeNull();
  });

  it("Pvt Ltd and an empty type (= Pvt Ltd) → never a caution (director pay is a real expense)", () => {
    expect(ownerPayCaution({ businessType: "pvt_ltd", category: "Director's Remuneration", text: "owner salary" })).toBeNull();
    expect(ownerPayCaution({ businessType: null, category: "Director's Remuneration", text: "owner salary" })).toBeNull();
  });

  it("partnership: paid to a partner in the register → caution naming the partner and the deed", () => {
    const c = ownerPayCaution({ businessType: "partnership", category: "Professional Services", payee: "  ravi kumar ", text: "", partners, onDate: "2026-10-01" });
    expect(c?.who).toBe("partner");
    expect(c?.partnerName).toBe("Ravi Kumar");
    expect(c?.body).toMatch(/deed/i);
    expect(c?.body).toMatch(/40\(b\)/);
  });

  it("partnership: a partner who has left is not matched; ordinary vendor → no caution", () => {
    expect(ownerPayCaution({ businessType: "partnership", category: "Travel", payee: "Sita Devi", partners, onDate: "2026-10-01" })).toBeNull();
    expect(ownerPayCaution({ businessType: "llp", category: "Travel", payee: "Ola", partners, onDate: "2026-10-01" })).toBeNull();
  });

  it("partnership + Director's Remuneration with no partner match → caution, partner unknown", () => {
    const c = ownerPayCaution({ businessType: "partnership", category: "Director's Remuneration", payee: "", partners, onDate: "2026-10-01" });
    expect(c?.who).toBe("partner");
    expect(c?.partnerName).toBeNull();
  });
});

describe("R-1846 employeeOwnerCaution — adding the owner as an employee in Payroll", () => {
  it("proprietor + designation Owner / Proprietor / Founder → caution", () => {
    expect(employeeOwnerCaution({ businessType: "proprietor", name: "Pardeep", designation: "Proprietor" })).not.toBeNull();
    expect(employeeOwnerCaution({ businessType: "proprietor", name: "Pardeep", designation: "Owner" })).not.toBeNull();
    expect(employeeOwnerCaution({ businessType: "proprietor", name: "Pardeep", designation: "Founder & CEO" })).not.toBeNull();
  });
  it("partnership: a register partner's name, or designation Partner → caution", () => {
    expect(employeeOwnerCaution({ businessType: "partnership", name: "Ravi Kumar", designation: "", partners, onDate: "2026-10-01" })?.partnerName).toBe("Ravi Kumar");
    expect(employeeOwnerCaution({ businessType: "llp", name: "X", designation: "Managing Partner", partners, onDate: "2026-10-01" })).not.toBeNull();
  });
  it("ordinary staff and Pvt Ltd directors → no caution", () => {
    expect(employeeOwnerCaution({ businessType: "proprietor", name: "Amit", designation: "Sales Executive" })).toBeNull();
    expect(employeeOwnerCaution({ businessType: "pvt_ltd", name: "Pardeep", designation: "Director" })).toBeNull();
    expect(employeeOwnerCaution({ businessType: null, name: "Pardeep", designation: "Owner" })).toBeNull();
    // "Channel partner manager" is staff, not a partner of the firm
    expect(employeeOwnerCaution({ businessType: "partnership", name: "Amit", designation: "Channel Partner Manager", partners, onDate: "2026-10-01" })).toBeNull();
  });
});

describe("R-1846 drawingsFromExpense — the one-click drawings entry from the form", () => {
  it("cash → the petty cash account; bank → the picked bank account", () => {
    expect(drawingsFromExpense({ amount: 25000, method: "cash", bankAccountId: "b1", pettyCashAccountId: "c1" })).toEqual({ ok: true, amount: 25000, accountId: "c1" });
    expect(drawingsFromExpense({ amount: 25000, method: "upi", bankAccountId: "b1", pettyCashAccountId: "c1" })).toEqual({ ok: true, amount: 25000, accountId: "b1" });
  });
  it("no amount / paise / no account / employee advance → a plain message, nothing recorded", () => {
    expect(drawingsFromExpense({ amount: 0, method: "upi", bankAccountId: "b1", pettyCashAccountId: "" }).ok).toBe(false);
    expect(drawingsFromExpense({ amount: 100.5, method: "upi", bankAccountId: "b1", pettyCashAccountId: "" }).ok).toBe(false);
    const noBank = drawingsFromExpense({ amount: 500, method: "bank_transfer", bankAccountId: "", pettyCashAccountId: "c1" });
    expect(noBank.ok).toBe(false);
    if (!noBank.ok) expect(noBank.error).toMatch(/account/i);
    expect(drawingsFromExpense({ amount: 500, method: "cash", bankAccountId: "b1", pettyCashAccountId: "" }).ok).toBe(false);
    expect(drawingsFromExpense({ amount: 500, method: "employee_advance", bankAccountId: "b1", pettyCashAccountId: "c1" }).ok).toBe(false);
  });
});
