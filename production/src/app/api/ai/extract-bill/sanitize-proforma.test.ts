/**
 * R-1510 — a reseller's Proforma (Description | Total layout, amounts printed as
 * "562,110.28 INR") lost its product names / amounts on the way to the form.
 *
 * All data here is SYNTHETIC (made-up vendor, made-up numbers in the same SHAPE
 * as the real bill) — the real PDF carries a bank account and never enters the repo.
 */
import { describe, it, expect } from "vitest";
import { sanitizeExtractedBill, parseBillAmount, fillLineQty } from "./sanitize";
import { BILL_PROMPT } from "@/lib/ai/read-bill";

describe("parseBillAmount — amounts as the model sometimes returns them", () => {
  it("reads western-grouped strings with a currency word", () => {
    expect(parseBillAmount("412,345.67 INR")).toBe(412345.67);
    expect(parseBillAmount("1,234.00 INR")).toBe(1234);
  });
  it("reads Indian grouping, ₹ / Rs prefixes and plain numbers", () => {
    expect(parseBillAmount("₹4,12,345.67")).toBe(412345.67);
    expect(parseBillAmount("Rs. 2,500")).toBe(2500);
    expect(parseBillAmount(99.5)).toBe(99.5);
    expect(parseBillAmount("USD 61.41")).toBe(61.41);
  });
  it("keeps the sign of a credit, incl. accounting brackets", () => {
    expect(parseBillAmount("-61.41")).toBe(-61.41);
    expect(parseBillAmount("(61.41)")).toBe(-61.41);
  });
  it("refuses what is not one amount", () => {
    expect(parseBillAmount("")).toBeNull();
    expect(parseBillAmount(null)).toBeNull();
    expect(parseBillAmount("N/A")).toBeNull();
    expect(parseBillAmount("1 - 30")).toBeNull();
    expect(parseBillAmount("12.34.56")).toBeNull();
  });
});

describe("sanitizeExtractedBill — reseller Proforma (synthetic)", () => {
  // The shape a model returns for a 2-column "Description | Total" table:
  // string amounts with grouping + currency, and the row text under `name`.
  const raw = {
    vendor_name: "Acme Cloud Resellers Pvt Ltd",
    vendor_gstin: "09aaaaa0000a1z5",
    bill_no: "7788",
    bill_date: "2026-09-01",
    currency: "INR",
    subtotal: "415,155.67 INR",
    igst: "74,728.02 INR",
    total: "489,883.69 INR",
    document_type: "Proforma Invoice",
    line_items: [
      { name: "Google Workspace ( 1 September - 30 September , 2026 )", amount: "412,345.67 INR" },
      { item: "Service Charges", amount: "2,810.00 INR" },
    ],
  } as unknown as Parameters<typeof sanitizeExtractedBill>[0];
  const out = sanitizeExtractedBill(raw);

  it("keeps every line's product name exactly as printed (date range included)", () => {
    expect(out.line_items.map((l) => l.description)).toEqual([
      "Google Workspace ( 1 September - 30 September , 2026 )",
      "Service Charges",
    ]);
  });
  it("reads the comma-grouped line + header amounts instead of dropping them", () => {
    expect(out.line_items.map((l) => l.amount)).toEqual([412345.67, 2810]);
    expect(out.subtotal).toBe(415155.67);
    expect(out.igst).toBe(74728.02);
    expect(out.total).toBe(489883.69);
  });
  it("guesses COGS-Workspace from a Workspace line when the model gave no category", () => {
    expect(out.category_guess).toBe("COGS-Workspace");
  });
  it("flags the document as a Proforma (no GST input credit on it)", () => {
    expect(out.document_type).toBe("proforma");
  });
});

describe("sanitizeExtractedBill — R-1510 guards", () => {
  it("does not override a category the model did give", () => {
    const out = sanitizeExtractedBill({ category_guess: "COGS-M365", line_items: [{ description: "Google Workspace", amount: 1 }] });
    expect(out.category_guess).toBe("COGS-M365");
  });
  it("a tax invoice stays a tax invoice; unknown stays null", () => {
    expect(sanitizeExtractedBill({ document_type: "TAX INVOICE" }).document_type).toBe("tax_invoice");
    expect(sanitizeExtractedBill({}).document_type).toBeNull();
  });
});

describe("sanitizeExtractedBill — a missing qty / rate is null, not 0", () => {
  it("does not turn a null unit_price into 0 (Number(null) === 0)", () => {
    const out = sanitizeExtractedBill({ line_items: [{ description: "Service Charges", qty: null, unit_price: null, amount: 2810 }] });
    expect(out.line_items[0].unit_price).toBeNull();
    expect(out.line_items[0].qty).toBeNull();
  });
});

describe("fillLineQty — a line with no quantity is 1 × amount (form strings)", () => {
  it("AI line with only an amount → qty 1, unit price = amount, amount unchanged", () => {
    expect(fillLineQty({ qty: "", unit_price: "", amount: "412345.67" }))
      .toEqual({ qty: "1", unit_price: "412345.67", amount: "412345.67" });
  });
  it("a 0 unit price / 0 qty counts as missing", () => {
    expect(fillLineQty({ qty: "0", unit_price: "0", amount: "2810" }))
      .toEqual({ qty: "1", unit_price: "2810", amount: "2810" });
  });
  it("keeps a credit's sign", () => {
    expect(fillLineQty({ qty: "", unit_price: "", amount: "-61.41" }))
      .toEqual({ qty: "1", unit_price: "-61.41", amount: "-61.41" });
  });
  it("never touches a line that already has a qty, a different rate, or no amount", () => {
    const a = { qty: "3", unit_price: "", amount: "300" };
    const b = { qty: "", unit_price: "100", amount: "300" };
    const c = { qty: "", unit_price: "", amount: "" };
    expect(fillLineQty(a)).toEqual(a);
    expect(fillLineQty(b)).toEqual(b);
    expect(fillLineQty(c)).toEqual(c);
  });
});

describe("BILL_PROMPT — Proforma / 2-column layouts", () => {
  it("tells the model the bill can be a Proforma and asks for its type", () => {
    expect(BILL_PROMPT).toMatch(/proforma/i);
    expect(BILL_PROMPT).toMatch(/"document_type"/);
  });
  it("asks for the FULL row text as description and plain JSON numbers", () => {
    expect(BILL_PROMPT).toMatch(/date range/i);
    expect(BILL_PROMPT).toMatch(/562,110\.28 INR.*562110\.28/);
  });
});
