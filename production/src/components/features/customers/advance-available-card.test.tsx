// @vitest-environment jsdom
/* R-2023 — the customer page shows "Advance available ₹X" with the receipt voucher(s) it came from. */
import { describe, it, expect, afterEach } from "vitest";
import * as React from "react";
import { render, cleanup, screen } from "@testing-library/react";
import { AdvanceAvailableCard } from "./advance-available-card";
import { openAdvanceLines, type CustomerCreditRow } from "@/lib/queries/customer-advances";

afterEach(cleanup);

const row = (over: Partial<CustomerCreditRow>): CustomerCreditRow => ({
  id: "c", amount: 0, status: "open", source: "overpayment", source_payment_id: "p1",
  source_quote_id: "Q-A378-27-0019", created_at: "2026-10-23T00:00:00Z",
  receipt_voucher_no: "RV-A378-27-0005", received_at: "2026-10-23T00:00:00Z", ...over,
});

describe("R-2023 — Advance available on the customer page", () => {
  it("one line per receipt, open part only (a part-used advance is grouped)", () => {
    const lines = openAdvanceLines([
      row({ id: "a", amount: 40000 }),
      row({ id: "b", amount: 7348, status: "used", source: "redeemed_split" }),
      row({ id: "c", amount: 1000, source_payment_id: "p2", receipt_voucher_no: "RV-2", source_quote_id: "Q-2" }),
    ]);
    expect(lines.map((l) => [l.receiptVoucherNo, l.open])).toEqual([["RV-A378-27-0005", 40000], ["RV-2", 1000]]);
  });

  it("shows the total with the RV linked to where it was received", () => {
    render(<AdvanceAvailableCard total={47348} lines={openAdvanceLines([row({ amount: 47348 })])} />);
    expect(screen.getByText("Advance available ₹47,348")).toBeTruthy();
    const link = screen.getByRole("link", { name: "RV-A378-27-0005" });
    expect(link.getAttribute("href")).toBe("/quotes/Q-A378-27-0019");
    expect(document.body.textContent).toMatch(/Use advance/);
  });

  it("nothing when there is no advance", () => {
    const { container } = render(<AdvanceAvailableCard total={0} lines={[]} />);
    expect(container.textContent).toBe("");
  });
});
