// @vitest-environment jsdom
/* R-2365 — Customer → Transactions: a payment the customer paid after deducting TDS says so
   under its amount (owner's case: RV-A378-27-0324, ₹7,753 = Received ₹7,687 + TDS ₹66). */
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { PaymentTdsLine, paymentTdsText, tdsInfoByPayment } from "./payment-tds-line";

afterEach(cleanup);

const tdsRows = [
  { payment_id: "pay-324", tds_amount: 66, section: "194C" },
  { payment_id: null, tds_amount: 500, section: "194J" },
];

describe("R-2365 — TDS split on the Transactions payment row", () => {
  it("payment with TDS: 'Received ₹7,687 + TDS ₹66' and the section", () => {
    const info = tdsInfoByPayment(tdsRows);
    render(<span>₹7,753<PaymentTdsLine amount={7753} tds={info["pay-324"]} /></span>);
    const line = screen.getByTestId("payment-tds-line");
    expect(line.textContent).toBe("Received ₹7,687 + TDS ₹66 · 194C");
    expect(paymentTdsText(7753, info["pay-324"])).toBe("Received ₹7,687 + TDS ₹66");
  });

  it("payment without TDS: nothing extra under the amount", () => {
    const info = tdsInfoByPayment(tdsRows);
    const { container } = render(<span><PaymentTdsLine amount={5000} tds={info["pay-other"]} /></span>);
    expect(screen.queryByTestId("payment-tds-line")).toBeNull();
    expect(container.textContent).toBe("");
  });

  it("two TDS rows on one payment add up; no section → no section text", () => {
    const info = tdsInfoByPayment([
      { payment_id: "p", tds_amount: 100, section: "194J" },
      { payment_id: "p", tds_amount: 50.4, section: "194J" },
      { payment_id: "q", tds_amount: 20, section: null },
    ]);
    expect(info.p).toEqual({ tds: 150, section: "194J" });
    render(<PaymentTdsLine amount={1000} tds={info.q} />);
    expect(screen.getByTestId("payment-tds-line").textContent).toBe("Received ₹980 + TDS ₹20");
  });

  it("the Transactions row renders the line for Payment rows only (R-2544: the tab lives in customer-transactions-tab.tsx)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(`${__dirname}/customer-transactions-tab.tsx`, "utf8");
    expect(src).toContain('t.type === "Payment" && payId && (t.tds ?? true) ? <PaymentTdsLine amount={t.tdsGross ?? t.amount} tds={tdsInfo[payId]} />');
    expect(fs.readFileSync(`${__dirname}/customer-profile.tsx`, "utf8")).toContain("tdsInfo={tdsInfoOnPayment}");
  });
});
