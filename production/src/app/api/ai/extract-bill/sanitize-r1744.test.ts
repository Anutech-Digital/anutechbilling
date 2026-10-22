// R-1744 (Pardeep, 22 Oct 2026): "agar koi gst pdf bill de to sab kuch AI hi fill kare".
// The extractor also returns each line's category, a short name of the main item, and
// whether the bill itself says it was paid (and how) — all backward compatible: old fields
// are unchanged and a model that leaves the new ones out gives nulls.
import { describe, it, expect } from "vitest";
import { sanitizeExtractedBill } from "./sanitize";
import { BILL_PROMPT } from "@/lib/ai/read-bill";

describe("R-1744 — Google Cloud India GST invoice (owner example 1)", () => {
  const out = sanitizeExtractedBill({
    vendor_name: "Google Cloud India Pvt Ltd",
    vendor_gstin: "29AAGCG1234F1Z5",
    bill_no: "GCI-2026-1001",
    bill_date: "2026-10-05",
    currency: "INR",
    subtotal: 1000, cgst: 0, sgst: 0, igst: 180, total: 1180,
    line_items: [{ description: "Workspace Business Starter", qty: 1, unit_price: 1000, amount: 1000, category: "software" }],
    expense_category: "Software",
    item_short: "  Workspace ",
    paid_status: "PAID",
    payment_mode: "Card",
  });

  it("keeps each line's category, matched to the app's own list", () => {
    expect(out.line_items[0].category).toBe("Software");
  });
  it("returns the short main-item name", () => {
    expect(out.item_short).toBe("Workspace");
  });
  it("reads a clearly paid bill and its method", () => {
    expect(out.paid_status).toBe("paid");
    expect(out.payment_mode).toBe("card");
  });
});

describe("R-1744 — new fields stay safe", () => {
  it("an unknown or Salaries line category is dropped (never a new account)", () => {
    const out = sanitizeExtractedBill({ line_items: [
      { description: "Pay", amount: 10, category: "Salaries" },
      { description: "Thing", amount: 5, category: "Spaceships" },
    ] });
    expect(out.line_items[0].category).toBeUndefined();
    expect(out.line_items[1].category).toBeUndefined();
  });
  it("a bill that does not say paid gives no payment mode", () => {
    const out = sanitizeExtractedBill({ paid_status: "due", payment_mode: "upi" });
    expect(out.paid_status).toBe("unpaid");
    expect(out.payment_mode).toBeNull();
    const none = sanitizeExtractedBill({});
    expect(none.paid_status).toBeNull();
    expect(none.payment_mode).toBeNull();
    expect(none.item_short).toBeNull();
  });
  it("maps UPI / net banking words to the form's methods", () => {
    expect(sanitizeExtractedBill({ paid_status: "paid", payment_mode: "UPI" }).payment_mode).toBe("upi");
    expect(sanitizeExtractedBill({ paid_status: "paid", payment_mode: "Net Banking" }).payment_mode).toBe("bank_transfer");
    expect(sanitizeExtractedBill({ paid_status: "paid", payment_mode: "crypto" }).payment_mode).toBeNull();
  });
  it("the prompt asks for the new fields", () => {
    expect(BILL_PROMPT).toMatch(/"item_short"/);
    expect(BILL_PROMPT).toMatch(/"paid_status"/);
    expect(BILL_PROMPT).toMatch(/"payment_mode"/);
    expect(BILL_PROMPT).toMatch(/"category": string\|null/);
  });
});
