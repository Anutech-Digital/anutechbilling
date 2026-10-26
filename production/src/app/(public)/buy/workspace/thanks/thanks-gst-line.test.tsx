// @vitest-environment jsdom
/**
 * R-1965 (Pardeep, 26 Oct 2026): the thanks page under the paid total said only "incl 18% GST".
 * It is a receipt, so the big number stays what was paid; the line below now splits it the same
 * way the buy page does — the pre-GST amount + GST (18%). An old order without a subtotal keeps
 * the old wording.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ThanksClient, type ThanksOrder } from "./thanks-client";

const order: ThanksOrder = {
  quoteId: "Q-ADPL-2026-27-0048", customerName: "Asha Co", tierName: "Business Starter",
  seats: 1, amount: 3823, subtotal: 3240, paymentStatus: "received", paymentState: "paid", amountReceived: 3823, paymentDate: "2026-10-26",
};

afterEach(cleanup);

describe("R-1965 thanks page GST line", () => {
  it("paid ₹3,823 for Starter × 1 → big ₹3,823 and '₹3,240 + ₹583 GST (18%)'", () => {
    const { container } = render(<ThanksClient order={order} isSimulation={false} />);
    const text = container.textContent ?? "";
    expect(text).toContain("₹3,823");
    expect(text).toContain("₹3,240 + ₹583 GST (18%)");
    expect(text).not.toContain("incl 18% GST");
  });

  it("no subtotal on the order → falls back to 'incl 18% GST'", () => {
    const { container } = render(<ThanksClient order={{ ...order, subtotal: null }} isSimulation={false} />);
    expect(container.textContent).toContain("incl 18% GST");
  });

  it("fetchOrder reads the quote's subtotal", () => {
    const src = readFileSync(join(__dirname, "fetch-order.ts"), "utf8");
    expect(src).toMatch(/select\("[^"]*\bsubtotal\b/);
    expect(src).toMatch(/subtotal:\s/);
  });
});
