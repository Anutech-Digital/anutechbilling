// @vitest-environment jsdom
/**
 * R-2654 — the bank page's "Razorpay settlements (N)": counts only OPEN money-in lines naming Razorpay,
 * per month, oldest first; the sheet's table says Ready / Blocked with the reason and the primary button
 * books only the ready ones.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { razorpayMonths, feeDatedLaterText } from "./razorpay-settlement-batch";

const mutateAsync = vi.fn(async () => ({ runId: "R1", booked: [{ txnId: "L1", settlementId: "setl_A", amount: 1156, fee: 24 }], refused: [] }));
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
  useRunRazorpayMonth: () => ({ mutateAsync, isPending: false }),
  invalidateBank: vi.fn(),
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
  it("shows Ready / Blocked with the reason, books only the ready line and keeps the run for Undo", async () => {
    render(<QueryClientProvider client={new QueryClient()}><RazorpaySettlementBatch accountId="acc" accountName="HDFC 4523" months={[{ month: "2025-10", count: 2 }]} open onOpenChange={() => {}} /></QueryClientProvider>);
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText("Blocked")).toBeTruthy();
    expect(screen.getByText(/pay_UNKNOWN .* is not in the app/)).toBeTruthy();
    expect(screen.getByText(/1 ready \(₹1,156\) · 1 blocked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reconcile all ready \(1\)/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ accountId: "acc", month: "2025-10", txnIds: ["L1"], runId: null }));
    await waitFor(() => expect(screen.getByRole("button", { name: /Undo this run/ })).toBeTruthy());
    expect(window.sessionStorage.getItem("ros_rzp_month_run_v1:acc")).toContain("R1");
    expect(await screen.findByText(/This run reconciled 1 line \(₹1,156, fees ₹24\)/)).toBeTruthy();
  });
});

describe("R-2745 feeDatedLaterText — fees of GST-filed months are dated on the first open day", () => {
  it("names the lines, the fee total, the day(s) and why; the bank lines keep their dates", () => {
    const why = "GST returns are filed up to October 2025 (Accounting → Overview → GST returns filed up to)";
    expect(feeDatedLaterText([
      { txnId: "L1", settlementId: "setl_A", amount: 1156, fee: 24, feeDate: "2025-11-01", feeDateWhy: why },
      { txnId: "L2", settlementId: "setl_B", amount: 2313, fee: 47, feeDate: "2025-11-01", feeDateWhy: why },
      { txnId: "L3", settlementId: "setl_C", amount: 1156, fee: 24, feeDate: "2025-11-05", feeDateWhy: null },
    ])).toBe(`Razorpay fees of 2 lines (₹71) are dated 01 Nov 2025 — the first open day: ${why}. The bank lines keep their own dates.`);
  });
  it("says nothing when no fee moved (open month, or a run before R-2745)", () => {
    expect(feeDatedLaterText([{ txnId: "L1", settlementId: "setl_A", amount: 1156, fee: 24 }])).toBe("");
    expect(feeDatedLaterText([{ txnId: "L1", settlementId: "setl_A", amount: 1156, fee: 24, feeDate: "2025-10-20", feeDateWhy: null }])).toBe("");
  });
});
