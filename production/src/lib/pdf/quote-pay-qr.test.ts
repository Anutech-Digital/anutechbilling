/* R-1694 — one rule for the quote's scan-to-pay QR, shared by the PDF route and the staff
   preview (api/quotes/[id]/pay-qr). Real QR encoder; only the due-now state is varied. */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { quotePayQr } from "./quote-pay-qr";
import type { QuoteDueNow } from "@/lib/payments/quote-due-now";

const due = (amount: number, inr = true): QuoteDueNow => ({
  state: "due", amount, currency: inr ? "INR" : "USD", inr, instalment: null, quoteTotal: amount, alreadyPaid: 0,
});
const tenant = { name: "ANUTECH DIGITAL PVT LTD", upi_vpa: "anutech@okhdfcbank", upi_payee_name: null };

describe("quotePayQr — the PDF's QR rule (R-1694)", () => {
  it("UPI ID + ₹ due → a QR for that amount, UPI ID under it", async () => {
    const qr = await quotePayQr({ tenant, quoteId: "Q-1", due: due(1180) });
    expect(qr?.dataUrl).toMatch(/^data:image\/png;base64,/);
    expect(qr?.vpa).toBe("anutech@okhdfcbank");
    expect(qr?.amount).toBe(1180);
  });

  it("no UPI ID → no QR", async () => {
    expect(await quotePayQr({ tenant: { ...tenant, upi_vpa: null }, quoteId: "Q-1", due: due(1180) })).toBeNull();
    expect(await quotePayQr({ tenant: null, quoteId: "Q-1", due: due(1180) })).toBeNull();
  });

  it("paid / invoiced / USD quote → no QR", async () => {
    expect(await quotePayQr({ tenant, quoteId: "Q-1", due: { state: "paid" } })).toBeNull();
    expect(await quotePayQr({ tenant, quoteId: "Q-1", due: { state: "invoiced" } })).toBeNull();
    expect(await quotePayQr({ tenant, quoteId: "Q-1", due: due(500, false) })).toBeNull();
  });

  it("the PDF route and the preview route both decide through quotePayQr (cannot drift)", () => {
    const root = path.resolve(__dirname, "../../app/api");
    for (const f of ["v1/documents/quote/[id]/pdf/route.ts", "quotes/[id]/pay-qr/route.ts"]) {
      const src = fs.readFileSync(path.join(root, f), "utf8");
      expect(src, f).toMatch(/quotePayQr\(\{/);
      expect(src, f).toMatch(/readQuoteDueNow\(/);
      expect(src, f).not.toMatch(/buildQuoteUpiQr\(/);
    }
  });
});
