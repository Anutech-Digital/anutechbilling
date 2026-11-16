// @vitest-environment jsdom
/* R-2656 (10 Nov 2026, G-RECON N3): Banking → "Find transfer pairs" shows the server's pairs with the
   reason, "Book N pairs" sends only the sure ones, the rest are listed as not booked, and the last run
   keeps an Undo. The pairing rules themselves: supabase/tests/r2656_bank_pair_detector.test.sql. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { PairRow } from "@/lib/banking/transfer-pair";

const s = vi.hoisted(() => ({
  rows: [] as unknown[],
  lastRun: null as null | { id: string; created_at: string; pairs: number },
  book: vi.fn(), undo: vi.fn(),
}));
vi.mock("@/lib/queries/bank-pairs", () => ({
  usePairCandidates: () => ({ data: s.rows, isLoading: false, isError: false, refetch: vi.fn() }),
  useLastPairRun: () => ({ data: s.lastRun }),
  useBookPairs: () => ({ mutateAsync: s.book, isPending: false }),
  useUndoPairRun: () => ({ mutateAsync: s.undo, isPending: false }),
}));

import { PairFinderSheet } from "./pair-finder";

const row = (p: Partial<PairRow>): PairRow => ({
  kind: "transfer", status: "sure", reason: "Transfer word in the narration, same amount, 1 day(s) apart, the only open line on each side.",
  amount: 500000, out_txn_id: "o1", out_account_id: "A", out_account: "HDFC 4523", out_date: "2026-10-01", out_description: "TRF TO FD SWEEP",
  in_txn_id: "i1", in_account_id: "F", in_account: "HDFC FD 1", in_date: "2026-10-02", in_description: "PRINCIPAL DEPOSITED", ...p,
});

afterEach(() => { cleanup(); s.book.mockReset(); s.undo.mockReset(); s.rows = []; s.lastRun = null; });

describe("R-2656 Find transfer pairs", () => {
  it("books only the sure pairs and says what happened", async () => {
    s.rows = [
      row({}),
      row({ kind: "reversal", out_txn_id: "o2", in_txn_id: "i2", amount: 1500, out_account: "HDFC 4523", in_account: "HDFC 4523", out_description: "UPI-PHONEPE", in_description: "UPIRET-PHONEPE", reason: "Reversal word in the narration" }),
      row({ status: "ambiguous", out_txn_id: "o3", in_txn_id: "i3", amount: 250000, reason: "2 lines could pair here — nothing is booked when there is more than one match." }),
      row({ kind: "reversal", status: "other_side_booked", out_txn_id: "o4", in_txn_id: "i4", amount: 2000, reason: "The other line is already reconciled as manual" }),
      row({ kind: "reversal", status: "check", out_txn_id: "o5", in_txn_id: "i5", amount: 7000, reason: "A reversal word, but the two lines share no name or reference" }),
    ];
    s.book.mockResolvedValue({ run_id: "run1", booked: 2, skipped: [] });
    render(<PairFinderSheet open onOpenChange={() => {}} />);

    expect(screen.getByText(/2 ready to book \(₹5,01,500\) · 1 with more than one match · 1 to check by hand · 1 with the other side already booked/)).toBeTruthy();
    const ready = screen.getByRole("region", { name: "Ready to book" });
    expect(within(ready).getAllByRole("row")).toHaveLength(3);   // header + 2
    const review = screen.getByRole("region", { name: /Not booked/ });
    expect(within(review).getByText(/2 lines could pair here/)).toBeTruthy();
    expect(within(review).getByText("Other side already booked")).toBeTruthy();
    expect(within(review).getByText("Check by hand")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Book 2 pairs" }));
    await waitFor(() => expect(s.book).toHaveBeenCalledWith([{ out_txn_id: "o1", in_txn_id: "i1" }, { out_txn_id: "o2", in_txn_id: "i2" }]));
    expect(await screen.findByText("2 pairs booked (4 lines reconciled)")).toBeTruthy();
  });

  it("no sure pair → Book is off", () => {
    s.rows = [row({ status: "ambiguous" })];
    render(<PairFinderSheet open onOpenChange={() => {}} />);
    expect((screen.getByRole("button", { name: "Book 0 pairs" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("the last run can be undone", async () => {
    s.lastRun = { id: "run1", created_at: "2026-11-10T06:00:00Z", pairs: 7 };
    s.undo.mockResolvedValue({ run_id: "run1", undone: 7, left: [] });
    render(<PairFinderSheet open onOpenChange={() => {}} />);
    expect(screen.getByText(/Last run: 7 pairs booked/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Undo this run" }));
    await waitFor(() => expect(s.undo).toHaveBeenCalledWith("run1"));
    expect(await screen.findByText("7 pairs undone — the lines are open again")).toBeTruthy();
  });

  it("nothing open to pair → says so", () => {
    render(<PairFinderSheet open onOpenChange={() => {}} />);
    expect(screen.getByText("No transfer or reversal pairs among the open lines.")).toBeTruthy();
  });
});
