// @vitest-environment jsdom
/* R-1839 — Banking → Reconcile → "Employee incentive / bonus": the employee is suggested from
   the bank text, the month defaults to the month before payment, incentive = paid + TDS; the
   screen says whether it is added to that month's salary or becomes a one-off payroll record;
   the RPC gets exactly the employee / month / TDS. Salary, never drawings. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReconcileFooter, type FooterSave } from "./reconcile-who-tiles";

import type { BankTransactionRow } from "@/lib/queries/bank";

const mutateAsync = vi.fn();
let record: { id: string; gross: number; incentive: number; tds: number; net: number; paid_status: string } | null = null;
const employees = [
  { id: "e1", name: "Ravi Kumar", is_active: true },
  { id: "e2", name: "Sita Devi", is_active: true },
  { id: "e3", name: "Old Person", is_active: false },
];
vi.mock("@/lib/queries/payroll", () => ({ useEmployees: () => ({ data: employees }) }));
vi.mock("@/lib/queries/incentive-from-bank", async (orig) => {
  const real = await orig<typeof import("@/lib/queries/incentive-from-bank")>();
  return {
    ...real,
    useSalaryRecordFor: () => ({ data: record, isLoading: false, isError: false }),
    useBookBankTxnAsIncentive: () => ({ mutateAsync, isPending: false }),
  };
});

import { IncentiveFromBankSection } from "./incentive-from-bank-section";
import { suggestEmployee } from "@/lib/queries/incentive-from-bank";

const txn = (over: Partial<BankTransactionRow> = {}): BankTransactionRow => ({
  id: "t1", tenant_id: "x", bank_account_id: "acc-1", txn_date: "2026-10-05", description: "IMPS-123-SITA DEVI-INCENTIVE",
  debit: 8000, credit: 0, balance_after: null, reference: null, source: "csv_upload",
  matched_to_type: null, matched_to_id: null, matched_at: null, matched_by: null, match_confidence: null,
  imported_at: "", created_at: "", updated_at: "", ...over,
} as BankTransactionRow);

afterEach(cleanup);
beforeEach(() => { mutateAsync.mockReset(); mutateAsync.mockResolvedValue({ mode: "one_off" }); record = null; });

describe("R-1839 employee incentive from a bank line", () => {
  it("suggests the employee named in the narration (active only)", () => {
    expect(suggestEmployee("IMPS-123-SITA DEVI-INCENTIVE", employees)).toBe("e2");
    expect(suggestEmployee("UPI/RAVI/bonus oct", employees)).toBe("e1");
    expect(suggestEmployee("UPI/OLD/bonus", employees)).toBe("");
    expect(suggestEmployee("ATM WDL", employees)).toBe("");
  });

  it("one-off: no salary that month → says so, sends employee / month / TDS", async () => {
    const done = vi.fn();
    render(<IncentiveFromBankSection transaction={txn()} onDone={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Book incentive" }));
    expect((screen.getByLabelText("Employee") as HTMLSelectElement).value).toBe("e2");
    expect((screen.getByLabelText("Incentive for month") as HTMLInputElement).value).toBe("2026-09");
    expect(screen.getByText(/one-off payroll record/)).toBeTruthy();
    expect(screen.getByText(/TDS: check/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText("TDS deducted"), { target: { value: "800" } });
    expect(screen.getByText(/Incentive ₹8,800 = ₹8,000 paid \+ ₹800 TDS/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Book ₹8,000 as incentive/ }));
    await vi.waitFor(() => expect(done).toHaveBeenCalled());
    expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", employeeId: "e2", period: "2026-09", tds: 800 });
  });

  it("existing month: says it is added to that salary", () => {
    record = { id: "s1", gross: 30000, incentive: 0, tds: 0, net: 30000, paid_status: "paid" };
    render(<IncentiveFromBankSection transaction={txn({ description: "UPI/RAVI/bonus" })} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Book incentive" }));
    expect(screen.getByText(/Added to Ravi Kumar's 2026-09 salary/)).toBeTruthy();
  });

  it("refuses paise / letters in TDS", () => {
    render(<IncentiveFromBankSection transaction={txn()} onDone={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "Book incentive" }));
    fireEvent.change(screen.getByLabelText("TDS deducted"), { target: { value: "12.5" } });
    expect((screen.getByRole("button", { name: /as incentive/ }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("not shown on a money-in line", () => {
    const { container } = render(<IncentiveFromBankSection transaction={txn({ debit: 0, credit: 5000 })} onDone={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});

/* R-2008: in the Reconcile sheet "Book ₹X as incentive" is the sticky footer's Save once the form
   is open — same label, same rule (TDS whole rupees), same submit(). */
function InSheet({ t }: { t: BankTransactionRow }) {
  const [footer, setFooter] = React.useState<FooterSave | null>(null);
  return (
    <>
      <div data-testid="reconcile-scroll-body"><IncentiveFromBankSection transaction={t} onDone={() => {}} onFooterSave={setFooter} /></div>
      <ReconcileFooter amount={t.debit} save={footer} hint="pick" onClose={() => {}} />
    </>
  );
}
describe("R-2008 Incentive — Save in the sticky footer", () => {
  it("closed → nothing in the footer; open → the footer books the same incentive; bad TDS keeps it off", async () => {
    render(<InSheet t={txn()} />);
    const footer = screen.getByTestId("reconcile-footer");
    expect(within(footer).queryAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
    fireEvent.click(screen.getByRole("button", { name: "Book incentive" }));
    const btn = () => within(footer).getByRole("button", { name: "Book ₹8,000 as incentive" }) as HTMLButtonElement;
    await vi.waitFor(() => expect(btn().disabled).toBe(false));
    expect(within(screen.getByTestId("reconcile-scroll-body")).queryByRole("button", { name: /as incentive/ })).toBeNull();
    expect(footer.textContent).toContain("Bank ₹8,000 = ₹8,000 ✓");
    fireEvent.change(screen.getByLabelText("TDS deducted"), { target: { value: "8.5" } });
    await vi.waitFor(() => expect(btn().disabled).toBe(true));
    fireEvent.change(screen.getByLabelText("TDS deducted"), { target: { value: "800" } });
    await vi.waitFor(() => expect(btn().disabled).toBe(false));
    fireEvent.click(btn());
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledWith({ transactionId: "t1", employeeId: "e2", period: "2026-09", tds: 800 }));
  });
});
