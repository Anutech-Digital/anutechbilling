// @vitest-environment jsdom
/* R-1917 — the money-out Reconcile sheet for a vendor's line has ONE way (R-1906 audit B8 + UI rule
   "one way per task, primary button = the right next step").
   Owner's example: Sharma Associates' ₹11,800 bill PS-2 is unpaid; the ₹11,800 Sharma line is opened.
     · the vendor section is the only open block and its Record payment the only primary button;
     · every other way (suggested matches, EMI, Book as expense, Combine, loan/advance, manual) sits
       behind "Not a payment to Sharma Associates?";
     · there, "Book as expense" for Sharma is refused with a sentence naming PS-2;
     · Combine no longer offers Sharma's own bill (it is paid in the vendor section).
   R-2006: the "fold" is now the tile sheet — the guessed vendor opens the Vendor tile and the other
   ways are behind "← Change" (tests updated for that; the rules they check are the same).
   The vendor section itself is tested in debit-pay-for-section.test.tsx; it is a stub here that
   reports the vendor the way the real one does (onVendorChange). */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import type { VendorFocus } from "@/lib/banking/vendor-line-guard";
import type { VendorOpenItem } from "@/lib/banking/debit-pay-for";
import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  focus: null as unknown,
  bookExpense: vi.fn(),
  suggestions: [] as unknown[],
  expenses: [] as unknown[],
  /* R-2348: the handlers the footer must call — the same ones the in-form buttons called. */
  vendorPay: vi.fn(),
  customerPay: vi.fn(),
  refundPay: vi.fn(),
  reconcile: vi.fn(),
  reconcileExpenses: vi.fn(),
  salarySplit: vi.fn(),
  salaries: [] as unknown[],
  /* R-2008: the handlers the footer must call for the remaining sections. */
  equityPay: vi.fn(),
  incentivePay: vi.fn(),
  advancePay: vi.fn(),
  emiPay: vi.fn(),
  projectPay: vi.fn(),
  commissionPay: vi.fn(),
  commissions: [] as unknown[],
  /* R-2407 */
  owedBack: false,
  owedBackPay: vi.fn(),
}));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }) }));

/* R-2025: no known payers, our own name (the payer warning / known-payer guess). */
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
/* R-2325: no suggested expense is reconciled elsewhere here (that read is tested in reconcile-suggestions-reconciled-r2325). */
vi.mock("@/lib/banking/reconciled-suggestions", async (orig) => ({
  ...(await orig<typeof import("@/lib/banking/reconciled-suggestions")>()),
  useReconciledExpenseIds: () => ({ data: new Set<string>(), isLoading: false }),
}));
vi.mock("@/lib/queries/bank", () => ({
  useSuggestMatches: () => ({ data: state.suggestions, isLoading: false }),
  useReconcileTransaction: () => ({ mutateAsync: state.reconcile, isPending: false }),
  useReconcileExpensesToBankTxn: () => ({ mutateAsync: state.reconcileExpenses, isPending: false }),
  useBookTxnAsExpense: () => ({ mutateAsync: state.bookExpense, isPending: false }),
  useBookBankCredit: mutation,
  useBookBankAdvance: mutation,
  useBookBankTxnAsStatutory: mutation,
  useBookBankTxnAsCommission: () => ({ mutateAsync: state.commissionPay, isPending: false }),
  useReconcileSalaryAdvanceSplit: () => ({ mutateAsync: state.salarySplit, isPending: false }),
  useOpenInvoicesForCreditMatch: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Professional Services", "Bank Charges", "Salaries", "Other"],
  useUnreconciledExpenses: () => ({ data: state.expenses }),
  suggestCategory: () => null,
}));
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useUnreconciledSalaries: () => ({ data: state.salaries }), useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: [] }) }));
vi.mock("@/lib/queries/tax-payments", () => ({ useBookBankTxnAsTax: mutation }));
vi.mock("@/lib/queries/salary-from-bank", () => ({ useBookSalaryLines: mutation }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/referral-commissions", () => ({ useReferralCommissions: () => ({ data: state.commissions }) }));
/* R-2007's Suggestion card has its own test (reconcile-suggestion-r2007.test.tsx); none here. */
vi.mock("@/components/features/banking/credit-line-section", () => ({ CreditLineSection: () => null }));   // R-2374
vi.mock("@/components/features/banking/reconcile-suggestion-card", () => ({
  useReconcileSuggestion: () => ({ suggestion: null, accept: async () => false, accepting: false }),
  SuggestionCard: () => null,
  logSuggestion: () => {},
}));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType: "pvt_ltd" } }) }));
vi.mock("@/components/features/customers/add-customer-form", () => ({ AddCustomerForm: () => null }));
vi.mock("@/components/features/banking/project-payment-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    /* R-2008: a part payment — ₹10,000 of the ₹11,800 line ticked, so its Save is off. */
    ProjectPaymentSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, { label: "Save & reconcile", onSave: state.projectPay, disabled: true, booked: 10000 });
      return <section aria-label="Project payment" />;
    },
  };
});
/* R-2348: the Customer / Customer refund sections are tested on their own (credit-pay-for-section.test,
   customer-refund-section.test); here stubs that hand the footer their Save the way the real ones do. */
vi.mock("@/components/features/banking/credit-pay-for-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    CreditPayForSection: ({ onFooterSave, onProjectPayment }: {
      onFooterSave?: Parameters<typeof useFooterSaveReport>[0]; onProjectPayment?: (customerId: string) => void;
    }) => {
      useFooterSaveReport(onFooterSave, { label: "Record ₹11,800 on Q-7 & reconcile", onSave: state.customerPay });
      return <section aria-label="This money is for"><button type="button" onClick={() => onProjectPayment?.("c1")}>Project payment</button></section>;
    },
  };
});
vi.mock("@/components/features/banking/customer-refund-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    CustomerRefundSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, { label: "Book ₹11,800 as customer refund", onSave: state.refundPay, disabled: false });
      return <section aria-label="Customer refund" />;
    },
  };
});
/* R-2008: the Owner / Employee / Loan / Project sections are tested on their own (owner-equity-section,
   employee-advance-bank-section, incentive-from-bank-section, emi-repayment-section,
   project-payment-section tests); here stubs that hand the footer their Save the way the real ones
   do — advance / incentive only once opened, like the real forms. */
vi.mock("@/components/features/banking/owner-equity-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    OwnerEquitySection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, { label: "Book ₹11,800 as owner drawings", onSave: state.equityPay });
      return <section aria-label="Owner drawings"><input aria-label="Note" /></section>;
    },
  };
});
/* R-2095: the transfer / other-income sections have their own tests (own-transfer-section-r2095). */
vi.mock("@/components/features/banking/other-income-section", () => ({ OtherIncomeSection: () => null }));
vi.mock("@/components/features/banking/own-transfer-section", () => ({ OwnTransferSection: () => null }));
vi.mock("@/components/features/banking/incentive-from-bank-section", async () => {
  const R = await import("react");
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    IncentiveFromBankSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      const [open, setOpen] = R.useState(false);
      useFooterSaveReport(onFooterSave, open ? { label: "Book ₹11,800 as incentive", onSave: state.incentivePay } : null);
      return <section aria-label="Incentive"><button type="button" onClick={() => setOpen(true)}>Book incentive</button>{open && <input aria-label="TDS deducted" />}</section>;
    },
  };
});
vi.mock("@/components/features/banking/employee-advance-bank-section", async () => {
  const R = await import("react");
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    EmployeeAdvanceBankSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      const [open, setOpen] = R.useState(false);
      useFooterSaveReport(onFooterSave, open ? { label: "Book ₹11,800 as advance to Asha", onSave: state.advancePay } : null);
      return <section aria-label="Employee advance"><button type="button" onClick={() => setOpen(true)}>Book advance</button></section>;
    },
  };
});
/* R-2407: the salary + owed-back section (tested in salary-owed-back-r2407.test.tsx) — a stub that
   offers its save only when a test sets state.owedBack. */
vi.mock("@/components/features/banking/salary-owed-back-r2407", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    SalaryOwedBackSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, state.owedBack ? { label: "Pay salary + ₹1,800 owed back · Ravi", onSave: state.owedBackPay } : null);
      return state.owedBack ? <section aria-label="Salary and owed back">Also pays back ₹1,800 owed to Ravi</section> : null;
    },
  };
});
vi.mock("@/components/features/banking/emi-repayment-section", async () => {
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    EmiRepaymentSection: ({ onFooterSave }: { onFooterSave?: Parameters<typeof useFooterSaveReport>[0] }) => {
      useFooterSaveReport(onFooterSave, { label: "Reconcile as EMI 3", onSave: state.emiPay });
      return <section aria-label="EMI"><input type="radio" aria-label="EMI 3 · Dell laptop" /></section>;
    },
  };
});
vi.mock("@/components/features/banking/debit-pay-for-section", async () => {
  const R = await import("react");
  const { Button } = await import("@/components/ui/button");
  const { useFooterSaveReport } = await import("./reconcile-who-tiles");
  return {
    DebitPayForSection: ({ onVendorChange, onFooterSave }: {
      onVendorChange?: (f: unknown) => void; onFooterSave?: Parameters<typeof useFooterSaveReport>[0];
    }) => {
      R.useEffect(() => { onVendorChange?.(state.focus); }, [onVendorChange]);
      const f = state.focus as VendorFocus | null;
      const label = f ? `Record payment ₹11,800 to ${f.vendorName} & reconcile` : "";
      /* R-2348: like the real section — the Save goes to the footer when the sheet asks for it. */
      useFooterSaveReport(onFooterSave, f ? { label, onSave: state.vendorPay } : null);
      return (
        <section aria-label="Paying a vendor">
          {f && !onFooterSave && <Button variant="primary">{label}</Button>}
        </section>
      );
    },
  };
});

import { ReconcileTransactionDialog } from "./reconcile-transaction-dialog";

const PS2: VendorOpenItem = {
  source: "expense", doc_id: "E2", bill_no: "PS-2", doc_date: "2026-09-10", due_date: null, category: "Professional Services",
  total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 0, tds_section: null, can_part: false, in_run: null,
};
const sharmaLine = {
  id: "t1", bank_account_id: "b1", txn_date: "2026-10-08", description: "IMPS SHARMA ASSOCIATES PS-2",
  debit: 11800, credit: 0, reference: null, category: null,
} as unknown as BankTransactionRow;

/* A primary button is the amber one (components/ui/button.tsx variant "primary"). */
const primaryButtons = () =>
  screen.getAllByRole("button").filter((b) => b.className.split(/\s+/).includes("bg-amber"));

afterEach(cleanup);
beforeEach(() => {
  state.bookExpense.mockReset();
  for (const fn of [state.vendorPay, state.customerPay, state.refundPay, state.reconcile, state.reconcileExpenses, state.salarySplit,
    state.equityPay, state.incentivePay, state.advancePay, state.emiPay, state.projectPay, state.commissionPay]) fn.mockReset().mockResolvedValue({});
  state.salaries = [];
  state.commissions = [];
  state.focus = { vendorId: "v1", vendorName: "Sharma Associates", openItems: [PS2] } satisfies VendorFocus;
  state.suggestions = [{ match_type: "expense", match_id: "E2", match_label: "Sharma Associates · PS-2", match_amount: 11800, match_date: "2026-09-10", match_confidence: "exact" }];
  state.expenses = [
    { id: "E2", category: "Professional Services", vendor_id: "v1", vendor_name: "Sharma Associates", expense_date: "2026-09-10", description: null, amount: 11800 },
    { id: "E9", category: "Rent", vendor_id: "v7", vendor_name: "Kapoor Estates", expense_date: "2026-09-01", description: null, amount: 30000 },
  ];
});

describe("R-1917 Reconcile sheet — one way for a vendor's money-out line", () => {
  it("Sharma line: the vendor section's Record payment is the ONLY primary button; the rest is behind ← Change", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    const primaries = primaryButtons();
    expect(primaries.map((b) => b.textContent)).toEqual(["Record payment ₹11,800 to Sharma Associates & reconcile"]);
    expect(screen.queryByText("Suggested matches")).toBeNull();
    expect(screen.queryByText(/Book as a new expense|Looks like a/)).toBeNull();
    expect(screen.queryByText("Combine multiple expenses")).toBeNull();
    expect(screen.queryByText("Mark reconciled manually")).toBeNull();
    // R-2006: the Vendor tile is open; the other ways are behind "← Change".
    expect(screen.getByRole("button", { name: "Change who this money is for" })).toBeTruthy();
    expect(screen.queryByRole("radiogroup")).toBeNull();
  });

  it("B8: opened from the fold, Book as expense for Sharma is refused with a sentence naming PS-2", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    fireEvent.click(screen.getByRole("button", { name: "Change who this money is for" }));
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    expect((screen.getByLabelText("Vendor / payee (optional)") as HTMLInputElement).value).toBe("Sharma Associates");
    fireEvent.change(screen.getByLabelText("Expense category"), { target: { value: "Professional Services" } });
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Sharma Associates has an open bill PS-2 for ₹11,800 — pay it with Record payment on the Vendor tile instead");
    expect(alert.textContent).not.toMatch(/above/i);
    const book = screen.getByRole("button", { name: /Book ₹11,800 as Professional Services/ }) as HTMLButtonElement;
    expect(book.disabled).toBe(true);
    fireEvent.click(book);
    expect(state.bookExpense).not.toHaveBeenCalled();
    // "Go to Record payment" closes the fold again.
    fireEvent.click(within(alert).getByRole("button", { name: "Go to Record payment" }));
    expect(screen.queryByLabelText("Expense category")).toBeNull();
  });

  it("the expense is for someone else (payee changed) → it books", async () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    fireEvent.click(screen.getByRole("button", { name: "Change who this money is for" }));
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    fireEvent.change(screen.getByLabelText("Expense category"), { target: { value: "Other" } });
    fireEvent.change(screen.getByLabelText("Vendor / payee (optional)"), { target: { value: "Gupta Printers" } });
    expect(screen.queryByRole("alert")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Book ₹11,800 as Other/ }));
    expect(state.bookExpense).toHaveBeenCalledWith(expect.objectContaining({ transactionId: "t1", vendor: "Gupta Printers", category: "Other" }));
  });

  it("Combine multiple expenses (in the fold) leaves out Sharma's own bill — it is paid in the vendor section", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    fireEvent.click(screen.getByRole("button", { name: "Change who this money is for" }));
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    fireEvent.click(screen.getByRole("button", { name: "Combine multiple expenses" }));
    expect(screen.getByText("Rent · Kapoor Estates")).toBeTruthy();
    expect(screen.queryByText("Professional Services · Sharma Associates")).toBeNull();
  });

  it("no vendor known: suggestions show and the expense form is under Bank charge / other", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={{ ...sharmaLine, description: "UPI 9876@okhdfc" } as BankTransactionRow} />);
    expect(screen.getByText("Suggested matches")).toBeTruthy();
    // R-2006: no tile is guessed — the tiles show; the expense form is one click away.
    expect(screen.queryByLabelText("Expense category")).toBeNull();
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    expect(screen.getByLabelText("Expense category")).toBeTruthy();
  });
});

/* R-2268 (design audit D8): Save always visible. The save sits in the sticky footer, under the
   scrolling body; the footer never sends the owner looking for a "button above". */
describe("R-2268 Reconcile sheet — the save is in the sticky footer", () => {
  it("Bank charge / other: the Book button is inside the footer, the footer is outside the scrolling body", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={{ ...sharmaLine, description: "UPI 9876@okhdfc" } as BankTransactionRow} />);
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    const footer = screen.getByTestId("reconcile-footer");
    expect(within(footer).getByRole("button", { name: /^Book ₹11,800/ })).toBeTruthy();
    expect(within(footer).getByRole("button", { name: "Close" })).toBeTruthy();
    const body = screen.getByTestId("reconcile-scroll-body");
    expect(body.contains(footer)).toBe(false);
    expect(body.className.split(/\s+/)).toEqual(expect.arrayContaining(["flex-1", "min-h-0", "overflow-y-auto"]));
  });

  it("a form that keeps its own button: the footer hint never says 'above'", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    const footer = screen.getByTestId("reconcile-footer");
    expect(footer.textContent).not.toMatch(/above/i);
  });
});

/* R-2348 (follow-up of R-2268): the tiles that kept their own button inside the form — Vendor
   "Record payment", Customer, Customer refund, salary "Pay in full", Combine multiple expenses,
   Overpaid salary — now save from the sticky footer: the button is in reconcile-footer, outside the
   scrolling body, it is the footer's ONLY primary, and it calls the same handler. */
describe("R-2348 Reconcile sheet — every tile saves from the sticky footer", () => {
  const plainOut = { ...sharmaLine, description: "UPI 9876@okhdfc" } as BankTransactionRow;
  const parts = () => {
    const footer = screen.getByTestId("reconcile-footer");
    const body = screen.getByTestId("reconcile-scroll-body");
    expect(body.contains(footer)).toBe(false);
    const footerPrimaries = within(footer).getAllByRole("button").filter((b) => b.className.split(/\s+/).includes("bg-amber"));
    expect(footerPrimaries).toHaveLength(1);
    return { footer, body, primary: footerPrimaries[0] as HTMLButtonElement };
  };

  it("Vendor: Record payment is in the footer, not in the body, and runs the vendor section's save", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    const { body, primary } = parts();
    expect(primary.textContent).toBe("Record payment ₹11,800 to Sharma Associates & reconcile");
    expect(within(body).queryByRole("button", { name: /Record payment/ })).toBeNull();
    fireEvent.click(primary);
    expect(state.vendorPay).toHaveBeenCalledTimes(1);
  });

  it("Customer (money in): the section's save is the footer's primary", () => {
    state.focus = null;
    const credit = { ...sharmaLine, debit: 0, credit: 11800, description: "NEFT ACME CORP" } as BankTransactionRow;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={credit} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Customer/ }));
    const { body, primary } = parts();
    expect(primary.textContent).toBe("Record ₹11,800 on Q-7 & reconcile");
    expect(within(body).queryByRole("button", { name: /& reconcile/ })).toBeNull();
    fireEvent.click(primary);
    expect(state.customerPay).toHaveBeenCalledTimes(1);
  });

  it("Customer refund (money out): the refund's save is the footer's primary", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Customer refund/ }));
    const { primary } = parts();
    expect(primary.textContent).toBe("Book ₹11,800 as customer refund");
    fireEvent.click(primary);
    expect(state.refundPay).toHaveBeenCalledTimes(1);
  });

  it("Salary: pick the salary in the list → Pay in full / Apply ₹X in the footer; more than due stays disabled", async () => {
    state.focus = null;
    state.salaries = [
      { id: "S1", employee_name: "Asha", period: "2026-09", paid_status: "unpaid", paid_amount: 0, net: 11800, remaining: 11800 },
      { id: "S2", employee_name: "Ravi", period: "2026-09", paid_status: "unpaid", paid_amount: 0, net: 5000, remaining: 5000 },
      { id: "S3", employee_name: "Meena", period: "2026-09", paid_status: "unpaid", paid_amount: 0, net: 20000, remaining: 20000 },
    ];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Employee \/ salary/ }));
    fireEvent.click(screen.getByRole("button", { name: "Pay a salary (full or part)" }));
    // nothing picked yet → no save in the footer
    expect(within(screen.getByTestId("reconcile-footer")).queryAllByRole("button").map((b) => b.textContent)).toEqual(["Close"]);
    // the old rule: a salary with less left than this line cannot take it
    const ravi = screen.getByRole("button", { name: /^Ravi · 2026-09/ }) as HTMLButtonElement;
    expect(ravi.disabled).toBe(true);
    expect(ravi.title).toBe("This line (₹11,800) is more than the ₹5,000 left on this salary");

    fireEvent.click(screen.getByRole("button", { name: /^Meena · 2026-09/ }));
    expect(parts().primary.textContent).toBe("Apply ₹11,800 · Meena · 2026-09");
    fireEvent.click(screen.getByRole("button", { name: /^Asha · 2026-09/ }));
    const { body, primary } = parts();
    expect(primary.textContent).toBe("Pay in full · Asha · 2026-09");
    expect(within(body).queryByRole("button", { name: /^(Pay in full|Apply ₹)/ })).toBeNull();
    fireEvent.click(primary);
    await vi.waitFor(() => expect(state.reconcile).toHaveBeenCalledWith({ transactionId: "t1", matchedToType: "salary", matchedToId: "S1", confidence: "manual" }));
  });

  it("Overpaid salary: the salary picked in the select → Pay salary + book ₹X advance in the footer", async () => {
    state.focus = null;
    state.salaries = [{ id: "S2", employee_name: "Ravi", period: "2026-09", paid_status: "unpaid", paid_amount: 0, net: 5000, remaining: 5000 }];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Employee \/ salary/ }));
    fireEvent.change(screen.getByLabelText("Salary to settle"), { target: { value: "S2" } });
    const { body, primary } = parts();
    expect(primary.textContent).toBe("Pay salary + book ₹6,800 advance");
    expect(within(body).queryByRole("button", { name: /Pay salary \+ book/ })).toBeNull();
    fireEvent.click(primary);
    await vi.waitFor(() => expect(state.salarySplit).toHaveBeenCalledWith({ transactionId: "t1", salaryId: "S2", advanceAmount: 6800, employeeName: "Ravi" }));
  });

  /* R-2407: a salary payout that also pays back what is owed — its save leads the Employee footer
     (before the "Overpaid salary → advance" split, which would book the extra as a new advance). */
  it("R-2407 salary + owed back: its save is the Employee footer's primary; picking a salary still wins", async () => {
    state.focus = null;
    state.owedBack = true;
    state.salaries = [{ id: "S2", employee_name: "Ravi", period: "2026-09", paid_status: "unpaid", paid_amount: 0, net: 10000, remaining: 10000 }];
    try {
      render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
      fireEvent.click(screen.getByRole("radio", { name: /^Employee \/ salary/ }));
      expect(screen.getByText("Also pays back ₹1,800 owed to Ravi")).toBeTruthy();
      const { primary } = parts();
      expect(primary.textContent).toBe("Pay salary + ₹1,800 owed back · Ravi");
      fireEvent.click(primary);
      await vi.waitFor(() => expect(state.owedBackPay).toHaveBeenCalled());
      fireEvent.change(screen.getByLabelText("Salary to settle"), { target: { value: "S2" } });
      expect(parts().primary.textContent).toBe("Pay salary + book ₹1,800 advance");
    } finally {
      state.owedBack = false;
    }
  });

  it("Combine multiple expenses: Reconcile N expenses in the footer, disabled until the ticks add up", async () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /Bank charge \/ other/ }));
    fireEvent.click(screen.getByRole("button", { name: "Combine multiple expenses" }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Rent · Kapoor Estates/ }));
    let p = parts();
    expect(p.primary.textContent).toBe("Reconcile 1 expense");
    expect(p.primary.disabled).toBe(true);
    expect(p.footer.textContent).toContain("₹18,200 more than the line");
    fireEvent.click(p.primary);
    expect(state.reconcileExpenses).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("checkbox", { name: /Rent · Kapoor Estates/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Professional Services · Sharma Associates/ }));
    p = parts();
    expect(p.primary.disabled).toBe(false);
    expect(within(p.body).queryByRole("button", { name: /^Reconcile \d* ?expense/ })).toBeNull();
    fireEvent.click(p.primary);
    await vi.waitFor(() => expect(state.reconcileExpenses).toHaveBeenCalledWith({ transactionId: "t1", expenseIds: ["E2"] }));
  });
});

/* R-2008 (second half of R-2006 / R-2348): Project payment, EMI, Owner drawings, Employee advance,
   Incentive and the referral commission save from the sticky footer too. A tile with several forms
   has ONE Save in the footer: the form the owner last clicked or typed in (else the first ready). */
describe("R-2008 Reconcile sheet — the remaining forms save from the sticky footer", () => {
  const plainOut = { ...sharmaLine, description: "UPI 9876@okhdfc" } as BankTransactionRow;
  const credit = { ...sharmaLine, debit: 0, credit: 11800, description: "NEFT ACME CORP" } as BankTransactionRow;
  const parts = () => {
    const footer = screen.getByTestId("reconcile-footer");
    const body = screen.getByTestId("reconcile-scroll-body");
    expect(body.contains(footer)).toBe(false);
    expect(footer.textContent).not.toMatch(/above/i);
    const footerPrimaries = within(footer).getAllByRole("button").filter((b) => b.className.split(/\s+/).includes("bg-amber"));
    expect(footerPrimaries).toHaveLength(1);
    return { footer, body, primary: footerPrimaries[0] as HTMLButtonElement };
  };
  const footerButtons = () => within(screen.getByTestId("reconcile-footer")).queryAllByRole("button").map((b) => b.textContent);

  it("Project payment (Customer tile): its Save is the footer's; a part payment shows '₹Z left' and stays off", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={credit} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Customer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Project payment" }));
    const { footer, primary } = parts();
    expect(primary.textContent).toBe("Save & reconcile");
    expect(primary.disabled).toBe(true);
    expect(footer.textContent).toContain("₹1,800 left");
    fireEvent.click(primary);
    expect(state.projectPay).not.toHaveBeenCalled();
  });

  it("Owner (money out): Book ₹X as owner drawings is the footer's Save and runs the section's save", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Owner/ }));
    const { footer, primary } = parts();
    expect(primary.textContent).toBe("Book ₹11,800 as owner drawings");
    expect(footer.textContent).toContain("Bank ₹11,800 = ₹11,800 ✓");
    fireEvent.click(primary);
    expect(state.equityPay).toHaveBeenCalledTimes(1);
  });

  it("Employee: nothing open → no Save (and no 'above'); the form opened / typed in last owns the footer", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Employee \/ salary/ }));
    expect(footerButtons()).toEqual(["Close"]);
    expect(screen.getByTestId("reconcile-footer").textContent).toContain("its save shows here");
    expect(screen.getByTestId("reconcile-footer").textContent).not.toMatch(/above/i);

    fireEvent.click(screen.getByRole("button", { name: "Book incentive" }));
    expect(parts().primary.textContent).toBe("Book ₹11,800 as incentive");
    fireEvent.click(screen.getByRole("button", { name: "Book advance" }));
    expect(parts().primary.textContent).toBe("Book ₹11,800 as advance to Asha");
    fireEvent.change(screen.getByLabelText("TDS deducted"), { target: { value: "500" } });
    const { primary } = parts();
    expect(primary.textContent).toBe("Book ₹11,800 as incentive");
    fireEvent.click(primary);
    expect(state.incentivePay).toHaveBeenCalledTimes(1);
    expect(state.advancePay).not.toHaveBeenCalled();
  });

  it("Loan / EMI: the EMI's save first; typing in Loan with a person moves the footer there and back", () => {
    state.focus = null;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={plainOut} />);
    fireEvent.click(screen.getByRole("radio", { name: /^Loan \/ EMI/ }));
    expect(parts().primary.textContent).toBe("Reconcile as EMI 3");
    expect(within(screen.getByTestId("reconcile-scroll-body")).queryByRole("button", { name: /Reconcile as EMI/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Person's name (e.g. Julie Rawat)"), { target: { value: "Julie Rawat" } });
    expect(parts().primary.textContent).toMatch(/^Book ₹11,800 as a loan/);
    fireEvent.click(screen.getByRole("radio", { name: "EMI 3 · Dell laptop" }));
    const { primary } = parts();
    expect(primary.textContent).toBe("Reconcile as EMI 3");
    fireEvent.click(primary);
    expect(state.emiPay).toHaveBeenCalledTimes(1);
  });

  it("Referral commission (Vendor tile): opened → its Save is the footer's, off until picked; same call as its old button", async () => {
    state.commissions = [{ id: "rc1", status: "earned", net_payable: 11800, earned_date: "2026-09-30", partner_name: "Mehta Refs" }];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={sharmaLine} />);
    expect(parts().primary.textContent).toBe("Record payment ₹11,800 to Sharma Associates & reconcile");
    fireEvent.click(screen.getByRole("button", { name: "Referral partner commission?" }));
    let p = parts();
    expect(p.primary.textContent).toBe("Book ₹11,800 as commission paid");
    expect(p.primary.disabled).toBe(true);
    expect(within(p.body).queryByRole("button", { name: /as commission paid/ })).toBeNull();
    fireEvent.change(screen.getByLabelText("Referral commission"), { target: { value: "rc1" } });
    p = parts();
    expect(p.primary.disabled).toBe(false);
    fireEvent.click(p.primary);
    await vi.waitFor(() => expect(state.commissionPay).toHaveBeenCalledWith({ transactionId: "t1", accountId: "b1", commissionId: "rc1" }));
    // back in the vendor section → its Record payment owns the footer again
    fireEvent.click(screen.getByRole("region", { name: "Paying a vendor" }));
    expect(parts().primary.textContent).toBe("Record payment ₹11,800 to Sharma Associates & reconcile");
  });
});
