// @vitest-environment jsdom
/**
 * R-2918 — the month sheet: a line blocked only by a Razorpay payment that is in no app payment gets a
 * "Book as Other income" tick per such payment. Never ticked by itself (₹200 or less only says
 * "Suggested"); ticked → the line counts as Ready and the run sends that line's picked payment ids
 * (ids only — the server plans again). The owner's case: 9 Jul 2025 ₹63,545 blocked by a ₹1 payment.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const P1 = "Razorpay payment pay_Qq4aD1VWkbUlGk (₹1) is not in the app.";
const PBIG = "Razorpay payment pay_BIG (₹5,900) is not in the app.";
const mutateAsync = vi.fn(async (_input: Record<string, unknown>) => ({ runId: "R1", booked: [{ txnId: "L9", settlementId: "setl_J", amount: 63545, fee: 1356, otherIncome: 1 }], refused: [] }));
vi.mock("@/lib/queries/razorpay-settlement", () => ({
  useRazorpayMonthBatch: () => ({
    isLoading: false, isFetching: false, error: null,
    data: {
      state: "batch",
      batch: {
        month: "2025-07", ready: 0, blocked: 3, readyAmount: 0,
        rows: [
          { txnId: "L9", txnDate: "2025-07-09", amount: 63545, narration: "", settlementId: "setl_J", utr: "UTRJ", pairedBy: "utr", ready: false, blockers: [P1], payments: 4, gross: 64901, fee: 1356, feeGst: 207,
            unmatched: [{ rzpId: "pay_Qq4aD1VWkbUlGk", amount: 1, problem: P1, suggest: true }] },
          { txnId: "L10", txnDate: "2025-07-10", amount: 5782, narration: "", settlementId: "setl_K", utr: "UTRK", pairedBy: "utr", ready: false, blockers: [PBIG, "This settlement also has 1 Razorpay adjustment(s) (₹10)."], payments: 1, gross: 5900, fee: 118, feeGst: 18,
            unmatched: [{ rzpId: "pay_BIG", amount: 5900, problem: PBIG, suggest: false }] },
          { txnId: "L11", txnDate: "2025-07-11", amount: 700, narration: "", settlementId: null, utr: null, pairedBy: null, ready: false, blockers: ["No Razorpay settlement of ₹700."], payments: 0, gross: 0, fee: 0, feeGst: 0 },
        ],
      },
    },
  }),
  useRunRazorpayMonth: () => ({ mutateAsync, isPending: false }),
  invalidateBank: vi.fn(),
  useUndoRazorpayMonth: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { RazorpaySettlementBatch, otherIncomeText } from "./razorpay-settlement-batch";

const open = () => render(<QueryClientProvider client={new QueryClient()}><RazorpaySettlementBatch accountId="acc9" accountName="HDFC 4523" months={[{ month: "2025-07", count: 3 }]} open onOpenChange={() => {}} /></QueryClientProvider>);
beforeEach(() => { cleanup(); mutateAsync.mockClear(); window.sessionStorage.clear(); });

describe("R-2918 the month sheet — Book as Other income", () => {
  it("nothing is ticked by itself: the ₹1 line stays Blocked (Suggested only), 0 ready, the run button is off", () => {
    open();
    expect(screen.getAllByText("Blocked")).toHaveLength(3);
    expect(screen.queryByText("Ready")).toBeNull();
    const tick = screen.getByLabelText(/Book as Other income — pay_Qq4aD1VWkbUlGk \(₹1\)/) as HTMLInputElement;
    expect(tick.checked).toBe(false);
    expect(screen.getAllByText(/Suggested: a payment this small/)).toHaveLength(1);       // not for the ₹5,900 one
    expect(screen.getByText(/0 ready \(₹0\) · 3 blocked/)).toBeTruthy();
    expect((screen.getByRole("button", { name: /Reconcile all ready \(0\)/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(mutateAsync).not.toHaveBeenCalled();
  });

  it("ticking the ₹1 payment makes the line Ready; Reconcile all ready sends the line with ONLY the picked payment id", async () => {
    open();
    fireEvent.click(screen.getByLabelText(/Book as Other income — pay_Qq4aD1VWkbUlGk \(₹1\)/));
    expect(screen.getByText("Ready")).toBeTruthy();
    expect(screen.getByText(/₹1 will be booked as Other income, the rest as customer payments\./)).toBeTruthy();
    expect(screen.getByText(/1 ready \(₹63,545\) · 2 blocked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Reconcile all ready \(1\)/ }));
    await waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({
      accountId: "acc9", month: "2025-07", txnIds: ["L9"], runId: null, otherIncome: { L9: ["pay_Qq4aD1VWkbUlGk"] },
    }));
    expect(await screen.findByText(/This run reconciled 1 line \(₹63,545, fees ₹1,356, Other income ₹1\)/)).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("button", { name: /Undo this run/ })).toBeTruthy());
    /* review: a tick is used once — after the run (the mocked table still lists the line) it is not ticked any more */
    await waitFor(() => expect((screen.getByLabelText(/Book as Other income — pay_Qq4aD1VWkbUlGk \(₹1\)/) as HTMLInputElement).checked).toBe(false));
    expect(screen.getByRole("button", { name: /Reconcile all ready \(0\)/ })).toBeTruthy();
  });

  it("unticking takes it back to Blocked; a line with another blocker stays Blocked even when ticked", () => {
    open();
    const tick = screen.getByLabelText(/Book as Other income — pay_Qq4aD1VWkbUlGk \(₹1\)/);
    fireEvent.click(tick);
    fireEvent.click(tick);
    expect(screen.queryByText("Ready")).toBeNull();
    fireEvent.click(screen.getByLabelText(/Book as Other income — pay_BIG \(₹5,900\)/));
    expect(screen.queryByText("Ready")).toBeNull();
    expect(screen.getByText(/This settlement also has 1 Razorpay adjustment/)).toBeTruthy();
    expect(screen.getByText(/0 ready \(₹0\) · 3 blocked/)).toBeTruthy();
  });

  it("otherIncomeText: says nothing when the run booked no Other income", () => {
    expect(otherIncomeText([{ txnId: "a", settlementId: "s", amount: 10, fee: 1 }])).toBe("");
    expect(otherIncomeText([{ txnId: "a", settlementId: "s", amount: 10, fee: 1, otherIncome: 1 }, { txnId: "b", settlementId: "t", amount: 10, fee: 1, otherIncome: 125 }])).toBe(", Other income ₹126");
  });
});
