// @vitest-environment jsdom
/* R-2377 — Business Loans → "Add loan" → Received into HDFC Current: the statement already has the
   Bajaj Finance disbursal (FT 0606 BAJAJ FINANCE LTD LOAN DISB ₹40,00,000 on 6 Jun 2026). The picker
   lists it and picks it, so Save links the loan to THAT line — no new money-in line (cash counted
   once). A new line is made only when the owner says the credit is not in the statement (warned). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

let lines: unknown[] = [];
let loading = false;
const linesArgs = vi.fn();
vi.mock("@/lib/banking/loan-setup-query", () => ({
  useLoanDisbursalLines: (...a: unknown[]) => { linesArgs(...a); return { data: loading ? undefined : lines, isLoading: loading }; },
}));

import { LoanMoneyLinePicker, useLoanMoneyLine, type LinePick } from "./loan-money-line-picker";

const bajaj = { id: "b1", txn_date: "2026-06-06", credit: 4000000, debit: 0, description: "FT 0606 BAJAJ FINANCE LTD LOAN DISB", matched_to_type: null };
const other = { id: "o1", txn_date: "2026-06-04", credit: 4000000, debit: 0, description: "NEFT CR SOMEONE", matched_to_type: null };

/* What AddLoanDialog does: the hook + the picker; `saved` shows the bank line Save would send. */
function Harness({ principal = 4000000, accountId = "acc-1" }: { principal?: number; accountId?: string }) {
  const [pick, setPick] = React.useState<LinePick>(undefined);
  const m = useLoanMoneyLine(accountId, principal, "2026-06-04", "Bajaj Finance", pick);
  return (
    <div>
      <LoanMoneyLinePicker principal={principal} window={m.window} candidates={m.candidates} chosen={m.chosen} loading={m.loading} onPick={setPick} />
      <output data-testid="saved">{m.loading ? "wait" : (m.chosen?.id ?? "new-line")}</output>
    </div>
  );
}

afterEach(cleanup);
beforeEach(() => { lines = [other, bajaj]; loading = false; linesArgs.mockReset(); });

describe("R-2377 — Add loan links the imported credit, not a new line", () => {
  it("looks on the chosen account for the loan amount within 15 days of Taken on", () => {
    render(<Harness />);
    expect(linesArgs).toHaveBeenLastCalledWith("acc-1", 4000000, { anchor: "2026-06-04", from: "2026-05-20", to: "2026-06-19" });
  });

  it("offers the Bajaj line first and picks it — Save sends that line", () => {
    render(<Harness />);
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(3);
    expect(screen.getByText(/BAJAJ FINANCE LTD LOAN DISB/)).toBeTruthy();
    expect((radios[0] as HTMLInputElement).checked).toBe(true);
    expect(screen.getByTestId("saved").textContent).toBe("b1");
    expect(screen.getByText(/no new bank entry is made/)).toBeTruthy();
    expect(screen.queryByText(/counted twice/)).toBeNull();
  });

  it("the other line can be picked instead", () => {
    render(<Harness />);
    fireEvent.click(screen.getAllByRole("radio")[1]);
    expect(screen.getByTestId("saved").textContent).toBe("o1");
  });

  it("a new line only when the owner says it is not in the statement — with the counted-twice warning", () => {
    render(<Harness />);
    fireEvent.click(screen.getByLabelText(/Not in my imported statement/));
    expect(screen.getByTestId("saved").textContent).toBe("new-line");
    expect(screen.getByText(/otherwise it is counted twice/)).toBeTruthy();
  });

  it("no matching line → says so and warns that a new line is added", () => {
    lines = [];
    render(<Harness />);
    expect(screen.getByText(/No unmatched money-in line of/)).toBeTruthy();
    expect(screen.getByText(/otherwise it is counted twice/)).toBeTruthy();
    expect(screen.getByTestId("saved").textContent).toBe("new-line");
  });

  it("while the lines load, Save waits (never a new line next to the imported one)", () => {
    loading = true;
    render(<Harness />);
    expect(screen.getByText(/Looking for the loan money/)).toBeTruthy();
    expect(screen.getByTestId("saved").textContent).toBe("wait");
  });

  it("asks for the amount first", () => {
    render(<Harness principal={0} />);
    expect(screen.getByText(/Enter the loan amount/)).toBeTruthy();
  });
});
