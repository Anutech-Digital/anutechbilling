// @vitest-environment jsdom
/**
 * R-2654 — the bank page's "Razorpay settlements (N)": counts only OPEN money-in lines naming Razorpay,
 * per month, oldest first; the sheet's table says Ready / Blocked with the reason and the primary button
 * books only the ready ones.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { razorpayMonths } from "./razorpay-settlement-batch";

const mutate = vi.fn();
vi.mock("@/lib/queries/razorpay-settlement", () => ({
  useRazorpayMonthBatch: () => ({
    isLoading: false, isFetching: false, error: null,
    data: {
      state: "batch",
      batch: {
        month: "2025-10", ready: 1, blocked: 1, readyAmount: 1156,
        rows: [
          { txnId: "L1", txnDate: "2025-10-03", amount: 1156, narration: "", settlementId: "setl_A", utr: "UTRA", pairedBy: "utr", ready: true, blockers: [], payments: 1, gross: 1180, fee: 24, feeGst: 4 },
          { txnId: "L3", txnDate: "2025-10-08", amount: 5782, narration: "", settlementId: "setl_C", utr: "UTRC", pairedBy: "utr", ready: false, blockers: ["Razorpay payment pay_UNKNOWN (₹5,900) is not in the app."], payments: 1, gross: 5900, fee: 118, feeGst: 18 },
        ],
      },
    },
  }),
  useRunRazorpayMonth: () => ({ mutate, isPending: false }),
  useUndoRazorpayMonth: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { RazorpaySettlementBatch } from "./razorpay-settlement-batch";

describe("R-2654 razorpayMonths", () => {
  it("open Razorpay money-in lines per month, oldest first", () => {
    const t = (d: string, desc: string, credit: number, matched: string | null = null) => ({ txn_date: d, description: desc, credit, matched_to_type: matched });
    expect(razorpayMonths([
      t("2025-11-02", "NEFT CR RAZORPAY PAYMENTS", 100),
      t("2025-10-02", "NEFT CR RAZORPAY PAYMENTS", 100),
      t("2025-10-09", "NEFT CR RAZORPAY PAYMENTS", 100),
      t("2025-10-10", "NEFT CR RAZORPAY PAYMENTS", 100, "payment"),
      t("2025-10-11", "NEFT CR SOMEONE", 100),
      { txn_date: "2025-10-12", description: "RAZORPAY CHARGES", credit: 0, matched_to_type: null },
    ])).toEqual([{ month: "2025-10", count: 2 }, { month: "2025-11", count: 1 }]);
  });
});

describe("R-2654 the sheet", () => {
  it("shows Ready / Blocked with the reason and books only the ready line", () => {
    render(<RazorpaySettlementBatch accountId="acc" accountName="HDFC 4523" months={[{ month: "2025-10", count: 2 }]} open onOpenChange={() => {}} />);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText(/pay_UNKNOWN .* is not in the app/)).toBeTruthy();
    expect(screen.getByText(/1 ready \(₹1,156\) · 1 blocked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reconcile all ready \(1\)/ }));
    expect(mutate).toHaveBeenCalledWith({ accountId: "acc", month: "2025-10", txnIds: ["L1"] }, expect.anything());
  });
});
