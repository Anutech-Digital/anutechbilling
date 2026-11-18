// @vitest-environment jsdom
/* R-2935 (staging 18 Nov 2026, Excel HDFC 4523): "FD REDEEM TAX - 50301205948354/1" −₹801 had no
   way to be booked. Tax tile → "TDS cut by bank": the interest booked from its own line (₹8,014,
   same day) is picked, and one save books the ₹801 as TDS receivable. */
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

type Row = { id: string; income_date: string; amount: number; description: string | null; source: string | null; fd_name: string | null };
const s = vi.hoisted(() => ({ book: vi.fn(), rows: [] as Row[], loading: false }));
vi.mock("@/lib/queries/bank-other-income", () => ({
  useInterestWithoutTds: () => ({ data: s.loading ? undefined : s.rows, isLoading: s.loading, isError: false }),
  useBookInterestTds: () => ({ mutateAsync: s.book, isPending: false }),
}));

import { InterestTdsSection } from "./interest-tds-section";
import { pickInterestForTds } from "@/lib/banking/interest-income";

const tax = { id: "tx", bank_account_id: "ca", txn_date: "2025-11-21", description: "FD REDEEM TAX - 50301205948354/1", debit: 801, credit: 0 } as unknown as BankTransactionRow;
const i1: Row = { id: "i1", income_date: "2025-11-21", amount: 8014, description: "Interest on FD", source: "fd", fd_name: "HDFC FD 50301205948354" };
const i2: Row = { id: "i2", income_date: "2025-11-21", amount: 6678, description: "Interest on FD", source: "fd", fd_name: "HDFC FD 50301205948355" };

afterEach(() => { cleanup(); s.book.mockReset(); s.rows = []; s.loading = false; });

function mount() {
  const report = vi.fn();
  const done = vi.fn();
  render(<InterestTdsSection transaction={tax} onDone={done} onFooterSave={report} />);
  return { done, last: () => report.mock.calls.filter((c) => c[0]).at(-1)?.[0] };
}

describe("R-2935 TDS cut by bank — the tax line of an FD paid on three lines", () => {
  it("owner's lines: of the two interests of that day the ₹8,014 one (801 = 10%) is picked; one save books it", async () => {
    s.rows = [i2, i1];
    s.book.mockResolvedValue({});
    const { done, last } = mount();
    await waitFor(() => expect((screen.getByLabelText("Interest this TDS was cut on") as HTMLSelectElement).value).toBe("i1"));
    expect(screen.getByText(/is 10% of the ₹8,014 interest/)).toBeTruthy();
    expect(screen.getByText(/₹7,213/)).toBeTruthy();
    await waitFor(() => expect(last().disabledReason).toBeNull());
    expect(last().label).toBe("Book ₹801 as TDS receivable");
    last().onSave();
    await waitFor(() => expect(s.book).toHaveBeenCalledWith({ transactionId: "tx", otherIncomeId: "i1" }));
    await waitFor(() => expect(done).toHaveBeenCalled());
  });

  it("no interest booked yet → the save is held and says to book the interest line first", async () => {
    const { last } = mount();
    await waitFor(() => expect(last().disabledReason).toMatch(/Book the interest line first/));
    expect(screen.queryByLabelText("Interest this TDS was cut on")).toBeNull();
    last().onSave();
    expect(s.book).not.toHaveBeenCalled();
  });

  it("nothing sure to pick → the owner picks, and until then the save is held", async () => {
    s.rows = [{ ...i1, income_date: "2025-11-20" }, { ...i2, income_date: "2025-11-19" }];
    const { last } = mount();
    await waitFor(() => expect(last().disabledReason).toBe("Pick the interest this TDS was cut on."));
    fireEvent.change(screen.getByLabelText("Interest this TDS was cut on"), { target: { value: "i2" } });
    await waitFor(() => expect(last().disabledReason).toBeNull());
    last().onSave();
    await waitFor(() => expect(s.book).toHaveBeenCalledWith({ transactionId: "tx", otherIncomeId: "i2" }));
  });
});

describe("R-2935 pickInterestForTds", () => {
  it("10% / 20% of exactly one same-day interest", () => {
    expect(pickInterestForTds([i1, i2], 801, "2025-11-21")).toBe("i1");
    expect(pickInterestForTds([i1, i2], 668, "2025-11-21")).toBe("i2");
    expect(pickInterestForTds([i1], 1603, "2025-11-21")).toBe("i1");   // 20%, no PAN
  });
  it("a rate that is not 10% / 20% is never pre-picked — not even the only interest of the day", () => {
    expect(pickInterestForTds([i1], 600, "2025-11-21")).toBe("");
    expect(pickInterestForTds([{ ...i1, amount: 50000 }], 801, "2025-11-21")).toBe("");
    expect(pickInterestForTds([i1, i2], 600, "2025-11-21")).toBe("");
  });
  it("another day, or an interest no bigger than the TDS, is never pre-picked", () => {
    expect(pickInterestForTds([{ ...i1, income_date: "2025-11-20" }], 801, "2025-11-21")).toBe("");
    expect(pickInterestForTds([{ ...i1, amount: 801 }], 801, "2025-11-21")).toBe("");
  });
});
