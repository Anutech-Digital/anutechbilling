import { describe, it, expect } from "vitest";
import { buildExpenseNote, shortVendorName, mainItemName, billMonth, lineCategoryFromBill, paidFromBill, rcmSuggested } from "./bill-autofill";
import { PAYMENT_METHODS } from "@/lib/queries/expenses";

describe("R-1744 bill autofill helpers", () => {
  it("owner example 1: note = vendor — main item — month", () => {
    expect(buildExpenseNote({ vendorName: "Google Cloud India Pvt Ltd", itemShort: "Workspace", items: [], billDate: "2026-10-05" }))
      .toBe("Google Cloud India — Workspace — Oct 2026");
  });
  it("without the AI's short name, the biggest line is used without its period", () => {
    expect(mainItemName(null, [
      { description: "Google Workspace ( 1 September - 30 September , 2026 )", amount: "900" },
      { description: "Support", amount: "100" },
    ])).toBe("Google Workspace");
    expect(mainItemName(undefined, [])).toBe("");
  });
  it("leaves out parts it does not know", () => {
    expect(buildExpenseNote({ vendorName: "Amazon Web Services, Inc.", items: [], billDate: null })).toBe("Amazon Web Services");
    expect(billMonth("05/10/2026")).toBe("");
  });
  it("company endings are dropped, the name never empties", () => {
    expect(shortVendorName("Anthropic, PBC")).toBe("Anthropic");
    expect(shortVendorName("Ltd")).toBe("Ltd");
  });
  it("line category falls back to the bill's category", () => {
    expect(lineCategoryFromBill("Hosting", "Software")).toBe("Hosting");
    expect(lineCategoryFromBill(null, "Software")).toBe("Software");
    expect(lineCategoryFromBill(undefined, undefined)).toBe("");
  });
  it("paid only when the bill says paid", () => {
    expect(paidFromBill("paid", "upi", PAYMENT_METHODS)).toEqual({ method: "upi" });
    expect(paidFromBill("paid", null, PAYMENT_METHODS)).toEqual({ method: null });
    expect(paidFromBill("unpaid", "upi", PAYMENT_METHODS)).toBeNull();
    expect(paidFromBill(null, null, PAYMENT_METHODS)).toBeNull();
  });
  it("owner example 2: RCM is suggested for a foreign bill with no GST only", () => {
    expect(rcmSuggested("USD", 0)).toBe(true);
    expect(rcmSuggested("USD", 36)).toBe(false);   // OIDAR vendor already charged GST
    expect(rcmSuggested("INR", 0)).toBe(false);
  });
});
