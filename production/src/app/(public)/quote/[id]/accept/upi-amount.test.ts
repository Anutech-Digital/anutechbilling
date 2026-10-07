/**
 * R-234 — the UPI QR on the public accept page must ask for the SAME money as the
 * Pay button. On a split-billed quote the button charges instalment 1
 * (quoteInstalments().firstGross); the QR used to carry the whole term.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { quoteInstalments } from "@/lib/billing/instalments";
import { quoteUpiAmount } from "./upi-amount";

const base = {
  subtotal: 24000, discount_pct: 0, tax_rate: 18, amount: 28320,
  currency: "INR", payment_status: "none", payment_amount: null,
};

describe("quoteUpiAmount", () => {
  it("quarterly quote: QR amount = Pay button amount (first instalment), not the term", () => {
    const q = { ...base, billing_cycle: "quarterly" as const };
    const button = quoteInstalments({
      cycle: "quarterly", termTaxable: 24000, termGross: 28320, taxRate: 18, lineCommitment: "annual",
    });
    expect(button).not.toBeNull();
    const amt = quoteUpiAmount(q, "annual");
    expect(amt).toBe(button!.firstGross);
    expect(amt).toBe(7080);
    expect(amt).not.toBe(28320);
  });

  it("monthly cycle with a remainder still matches the engine's first period", () => {
    const q = { ...base, subtotal: 10001, amount: 11801, billing_cycle: "monthly" as const };
    const button = quoteInstalments({ cycle: "monthly", termTaxable: 10001, termGross: 11801, taxRate: 18, lineCommitment: null });
    expect(quoteUpiAmount(q, null)).toBe(button!.firstGross);
  });

  it("legacy quote without billing_cycle falls back to the line commitment like the view", () => {
    const q = { ...base, billing_cycle: null };
    // no split for a yearly / legacy-annual quote → whole amount
    expect(quoteUpiAmount(q, "annual")).toBe(28320);
  });

  it("yearly quote keeps the whole amount due", () => {
    expect(quoteUpiAmount({ ...base, billing_cycle: "yearly" as const }, "annual")).toBe(28320);
  });

  it("flex (commitment monthly) asks for the stored per-month amount", () => {
    expect(quoteUpiAmount({ ...base, billing_cycle: "monthly" as const }, "monthly")).toBe(28320);
  });

  it("split quote whose first instalment is already paid gets no QR (pay route refuses too)", () => {
    expect(quoteUpiAmount({ ...base, billing_cycle: "quarterly" as const, payment_status: "partial", payment_amount: 7080 }, "annual")).toBe(0);
  });

  it("foreign or invoiced quote still gets no QR", () => {
    expect(quoteUpiAmount({ ...base, billing_cycle: "quarterly" as const, currency: "USD" }, "annual")).toBe(0);
    expect(quoteUpiAmount({ ...base, billing_cycle: "quarterly" as const, payment_status: "invoiced" }, "annual")).toBe(0);
  });
});

describe("accept page copy + wiring (R-234)", () => {
  const dir = join(process.cwd(), "src/app/(public)/quote/[id]/accept");
  const view = readFileSync(join(dir, "quote-accept-view.tsx"), "utf8");
  const page = readFileSync(join(dir, "page.tsx"), "utf8");

  it("page builds the QR from quoteUpiAmount, not the whole quoteAmountDue", () => {
    expect(page).toMatch(/amountDue:\s*upiAmount/);
    expect(page).toContain("quoteUpiAmount(");
  });

  it("QR amount shown is the QR's own amount, not dTotal", () => {
    expect(view).toContain("upiQr.amount");
    expect(view).not.toMatch(/UPI QR code to pay \$\{tenantName\} \$\{fmtC\(dTotal\)\}/);
  });

  it("no Hinglish flex line on the customer page", () => {
    expect(view).not.toMatch(/har mahine ki apni invoice/);
    expect(view).not.toMatch(/bhugtan/);
  });

  /* R-376 (d): the contact PERSON first (./signer-default.ts); the company name only as
     the fallback — it used to be the company, so people signed as "Acme Pvt Ltd". */
  it("signer name starts from the contact person, falling back to the customer name", () => {
    expect(view).toMatch(/useState\(signerDefault \?\? quote\.customer_name \?\? ""\)/);
  });

  it("request changes without an email falls back to WhatsApp / phone", () => {
    expect(view).toContain("whatsAppLink(");
    expect(view).not.toContain("Reach out to the reseller via the email they sent you.");
  });
});
