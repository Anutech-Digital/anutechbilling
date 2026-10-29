// @vitest-environment jsdom
/* R-2007 — the Suggestion card at the top of the Reconcile sheet.
   Owner's examples (Pardeep, 27 Oct; scenarios project-receipts + vendor-sharma):
     · ₹2,12,400 "NEFT CR-ICIC0001957-SCN BHARAT APPS-KIST 1 2 LESS TDS" — customers "SCN Acme
       Website Co" and "SCN Bharat Apps" both have "SCN": the card says SCN Bharat Apps · SCN Mobile
       app · Kist 1 + 2 · TDS ₹23,600 with a Why line; "Looks right — reconcile" books it through
       the project section's own save (allocate_project_receipt_with_tds); "Change" opens the Customer
       tile on that project with the TDS filled in.
     · ₹5,000 "NEFT DR-…-GOOGLE CLOUD INDIA PVT LTD-…" — Google's only open bill SCN-G-20 ₹11,800:
       a part payment through the vendor section's own save.
     · Ambiguous (shared word only) → no card, the tiles as before. */
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";

import type { BankTransactionRow } from "@/lib/queries/bank";

const state = vi.hoisted(() => ({
  customers: [] as unknown[],
  projects: [] as unknown[],
  creditItems: [] as unknown[],
  vendors: [] as unknown[],
  vendorItems: [] as unknown[],
  suggestions: [] as unknown[],
  allocate: vi.fn(),
  payItem: vi.fn(),
  payVendor: vi.fn(),
  rpc: vi.fn(),
  projectProps: null as null | Record<string, unknown>,
}));
const payerState = vi.hoisted(() => ({ payers: [] as unknown[], setPayer: vi.fn(), calls: [] as string[] }));
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }) }));

vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: payerState.payers, ownNames: ["Orbit Software"] }),
  useSetBankLinePayer: () => ({ mutateAsync: payerState.setPayer, isPending: false }),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({ rpc: state.rpc }) }));
vi.mock("@/lib/queries/bank", () => ({
  useSuggestMatches: () => ({ data: state.suggestions, isLoading: false }),
  useReconcileTransaction: mutation,
  useReconcileExpensesToBankTxn: mutation,
  useBookTxnAsExpense: mutation,
  useBookBankCredit: mutation,
  useBookBankAdvance: mutation,
  useBookBankTxnAsStatutory: mutation,
  useBookBankTxnAsCommission: mutation,
  useReconcileSalaryAdvanceSplit: mutation,
  useOpenInvoicesForCreditMatch: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/project-receipts", () => ({
  useOpenProjects: () => ({ data: state.projects }),
  useAllocateProjectReceipt: () => ({ mutateAsync: state.allocate, isPending: false }),
}));
vi.mock("@/lib/queries/bank-credit-pay-for", () => ({
  useBankCreditOpenItems: (id: string | null) => ({ data: id ? state.creditItems : undefined }),
  usePayItemFromBankCredit: () => ({ mutateAsync: state.payItem, isPending: false }),
}));
vi.mock("@/lib/queries/bank-debit-pay-for", () => ({
  useVendorOpenItems: (id: string | null) => ({ data: id ? state.vendorItems : undefined }),
  usePayVendorFromBankDebit: () => ({ mutateAsync: state.payVendor, isPending: false }),
  useVendorNarrationAliases: () => ({ data: [] }),
}));
vi.mock("@/lib/queries/vendors", () => ({ useVendors: () => ({ data: state.vendors }) }));
vi.mock("@/lib/queries/expenses", () => ({
  EXPENSE_CATEGORIES: ["Professional Services", "Bank Charges", "Salaries", "Other"],
  useUnreconciledExpenses: () => ({ data: [] }),
  suggestCategory: () => null,
}));
vi.mock("@/lib/queries/txn-category-rules", () => ({ useTxnCategoryRules: () => ({ data: [] }) }));
vi.mock("@/lib/queries/payroll", () => ({ useUnreconciledSalaries: () => ({ data: [] }), useEmployees: () => ({ data: [] }) }));
vi.mock("@/lib/queries/customers", () => ({ useCustomers: () => ({ data: state.customers }) }));
vi.mock("@/lib/queries/tax-payments", () => ({ useBookBankTxnAsTax: mutation }));
vi.mock("@/lib/queries/salary-from-bank", () => ({ useBookSalaryLines: mutation }));
vi.mock("@/lib/queries/prepaid-advances", () => ({ usePrepaidAdvances: () => ({ data: [] }) }));
vi.mock("@/lib/queries/referral-commissions", () => ({ useReferralCommissions: () => ({ data: [] }) }));
vi.mock("@/lib/compliance/profile", () => ({ useComplianceProfile: () => ({ data: { businessType: "pvt_ltd" } }) }));
vi.mock("@/components/features/customers/add-customer-form", () => ({ AddCustomerForm: () => null }));
vi.mock("@/components/features/banking/project-payment-section", () => ({
  ProjectPaymentSection: (p: Record<string, unknown>) => {
    state.projectProps = p;
    const tds = p.initialTds as { amount: number; sectionKey: string } | null;
    return <section aria-label="Project payment form">Project for {String(p.customerId)}{tds ? ` · TDS ${tds.amount} (${tds.sectionKey})` : ""}</section>;
  },
}));
vi.mock("@/components/features/banking/credit-pay-for-section", () => ({
  CreditPayForSection: () => <section aria-label="Customer payment form">Who paid?</section>,
}));
vi.mock("@/components/features/banking/owner-equity-section", () => ({ OwnerEquitySection: () => null }));
vi.mock("@/components/features/banking/incentive-from-bank-section", () => ({ IncentiveFromBankSection: () => null }));
vi.mock("@/components/features/banking/employee-advance-bank-section", () => ({ EmployeeAdvanceBankSection: () => null }));
vi.mock("@/components/features/banking/emi-repayment-section", () => ({ EmiRepaymentSection: () => null }));
vi.mock("@/components/features/banking/debit-pay-for-section", () => ({
  DebitPayForSection: () => <section aria-label="Paying a vendor">Vendor form</section>,
}));

import { ReconcileTransactionDialog } from "./reconcile-transaction-dialog";


const LINKS = [{ id: "c-links", name: "Links Infotech" }, { id: "c-acme", name: "Acme Trading" }];
const shreeLine = {
  id: "t-shree", bank_account_id: "b1", txn_date: "2026-10-23",
  description: "NEFT CR-INDB0000006-SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED-ORBIT SOFTWARE-INDBH23101090759",
  debit: 0, credit: 16709, reference: "INDBH23101090759", category: null,
} as unknown as BankTransactionRow;
const KNOWN = {
  id: "kp1", customer_id: "c-links", payer_name: "SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED",
  payer_name_key: "shree nandik technologies private limited", relation: "director", note: null,
  ifsc: "INDB0000006", upi_id: null, account_tail: null, uses: 1, first_seen_txn: "t0", created_at: "2026-10-27T12:00:00Z",
};
const OPEN_Q = {
  kind: "new", quote_id: "Q-L1", invoice_id: null, doc_date: "2026-10-20", amount_due: 16709, taxable_value: 14160,
  makes_subscription: false, subscription_id: null, plan: null, seats: null, renewal_date: null, lines: [],
};
const card = () => screen.getByRole("region", { name: "Suggestion" });

afterEach(cleanup);
beforeEach(() => {
  state.customers = LINKS;
  state.projects = [];
  state.creditItems = [OPEN_Q];
  state.vendors = [];
  state.vendorItems = [];
  state.suggestions = [];
  state.rpc.mockReset().mockResolvedValue({ error: null });
  payerState.payers = [];
  payerState.calls = [];
  payerState.setPayer.mockReset().mockImplementation(async () => { payerState.calls.push("payer"); });
  state.payItem.mockReset().mockImplementation(async () => { payerState.calls.push("pay"); return {}; });
});

describe("R-2025 Suggestion card and known payers", () => {
  it("a known payer guesses the customer: 'Why: Known payer for Links Infotech'", () => {
    payerState.payers = [KNOWN];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={shreeLine} />);
    expect(within(card()).getByText("Links Infotech · New product Q-L1")).toBeTruthy();
    expect(card().textContent).toMatch(/Why:\s*Known payer for Links Infotech; ₹16,709 is exactly what is due on Q-L1/);
  });

  it("'Looks right' records who paid (director) FIRST, then the payment", async () => {
    payerState.payers = [KNOWN];
    const onOpenChange = vi.fn();
    render(<ReconcileTransactionDialog open onOpenChange={onOpenChange} transaction={shreeLine} />);
    fireEvent.click(within(card()).getByRole("button", { name: "Looks right — reconcile" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(payerState.calls).toEqual(["payer", "pay"]);
    expect(payerState.setPayer.mock.calls[0][0]).toMatchObject({
      transactionId: "t-shree", customerId: "c-links", relation: "director",
      payer: { name: "SHREE NANDIK TECHNOLOGIES PRIVATE LIMITED" },
    });
  });

  it("not known yet → no card for Links (nothing names Links)", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={shreeLine} />);
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
  });

  it("the same payer known for two customers → no card", () => {
    payerState.payers = [KNOWN, { ...KNOWN, id: "kp2", customer_id: "c-acme" }];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={shreeLine} />);
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
  });

  it("the remark names Acme but RAJESH KUMAR paid → no one-click card (the form asks who paid)", () => {
    const line = { ...shreeLine, id: "t-rk", description: "NEFT CR-HDFC0000240-RAJESH KUMAR-ORBIT SOFTWARE-ACME TRADING Q L1" } as BankTransactionRow;
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={line} />);
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
  });
});
