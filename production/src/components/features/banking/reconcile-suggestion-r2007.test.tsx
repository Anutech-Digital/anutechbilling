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
const { mutation } = vi.hoisted(() => ({ mutation: () => ({ mutateAsync: vi.fn(), mutate: vi.fn(), isPending: false }) }));

/* R-2025: no known payers, our own name (the payer warning / known-payer guess). */
vi.mock("@/lib/queries/customer-payers", () => ({
  usePayerMemory: () => ({ payers: [], ownNames: [] }),
  useSetBankLinePayer: () => ({ mutateAsync: vi.fn(), isPending: false }),
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

const SCN_CUSTOMERS = [
  { id: "cu-acme", name: "SCN Acme Website Co" },
  { id: "cu-bharat", name: "SCN Bharat Apps" },
];
const PROJECTS = [
  {
    id: "p-web", title: "SCN Website", customerName: "SCN Acme Website Co", customerId: "cu-acme", total: 354000, paid: 0, gstRate: 18,
    milestones: [1, 2, 3].map((n) => ({ id: `a${n}`, seq: n, label: `Kist ${n}`, total: 118000, paid: 0, remaining: 118000, invoiceId: null })),
  },
  {
    id: "p-mobile", title: "SCN Mobile app", customerName: "SCN Bharat Apps", customerId: "cu-bharat", total: 236000, paid: 0, gstRate: 18,
    milestones: [
      { id: "k1", seq: 1, label: "Kist 1 — advance", total: 118000, paid: 0, remaining: 118000, invoiceId: null },
      { id: "k2", seq: 2, label: "Kist 2 — delivery", total: 118000, paid: 0, remaining: 118000, invoiceId: null },
    ],
  },
];
const bharatLine = {
  id: "t-bharat", bank_account_id: "b1", txn_date: "2026-10-24", description: "NEFT CR-ICIC0001957-SCN BHARAT APPS-KIST 1 2 LESS TDS",
  debit: 0, credit: 212400, reference: "SCN-N298261957000432", category: null,
} as unknown as BankTransactionRow;
const googleLine = {
  id: "t-google", bank_account_id: "b1", txn_date: "2026-10-23", description: "NEFT DR-HSBC0400002-GOOGLE CLOUD INDIA PVT LTD-NETBANK, MUM-N298261957000114-SCN G20",
  debit: 5000, credit: 0, reference: "SCN-N298261957000114", category: null,
} as unknown as BankTransactionRow;
const G20 = {
  source: "vendor_bill", doc_id: "BILL-SCN-G-20", bill_no: "SCN-G-20", doc_date: "2026-10-12", due_date: null, category: "COGS-Workspace",
  total: 11800, amount_due: 11800, gst: 1800, tds_base: 10000, tds_amount: 0, tds_section: null, can_part: true, in_run: null,
};

const card = () => screen.getByRole("region", { name: "Suggestion" });

afterEach(cleanup);
beforeEach(() => {
  state.customers = SCN_CUSTOMERS;
  state.projects = PROJECTS;
  state.creditItems = [];
  state.vendors = [];
  state.vendorItems = [];
  state.suggestions = [];
  state.allocate.mockReset().mockResolvedValue({ allocations: [] });
  state.payItem.mockReset();
  state.payVendor.mockReset().mockResolvedValue({});
  state.rpc.mockReset().mockResolvedValue({ error: null });
  state.projectProps = null;
});

describe("R-2007 Suggestion card — money in (SCN Bharat Apps, ₹2,12,400)", () => {
  it("shows who, what for and TDS, with a Why line; the Customer tile is pre-selected, no form open", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={bharatLine} />);
    expect(within(card()).getByText("SCN Bharat Apps · SCN Mobile app · Kist 1 + 2 · TDS ₹23,600")).toBeTruthy();
    expect(card().textContent).toContain("Bank ₹2,12,400 + TDS ₹23,600 = ₹2,36,000 due ✓");
    expect(card().textContent).toMatch(/Why:.*bharat apps.*₹2,12,400 \+ TDS ₹23,600 \(10%\) = ₹2,36,000/);
    expect(screen.getByRole("radio", { name: /Customer/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("region", { name: "Customer payment form" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Project payment form" })).toBeNull();
  });

  it("'Looks right — reconcile' runs the project section's own save: both kists + TDS ₹23,600 (194J 10%), then closes", async () => {
    const onOpenChange = vi.fn();
    render(<ReconcileTransactionDialog open onOpenChange={onOpenChange} transaction={bharatLine} />);
    fireEvent.click(within(card()).getByRole("button", { name: "Looks right — reconcile" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(state.allocate).toHaveBeenCalledWith({
      bankTxnId: "t-bharat", projectId: "p-mobile",
      allocations: [{ milestoneId: "k1", amount: 118000, raiseInvoice: true }, { milestoneId: "k2", amount: 118000, raiseInvoice: true }],
      tds: { section: "194J", ratePct: 10, amount: 23600 },
      receivedAt: "2026-10-24", reference: "SCN-N298261957000432",
    });
    expect(state.rpc).toHaveBeenCalledWith("log_activity", expect.objectContaining({ p_action: "reconcile_suggestion_accept", p_entity_id: "t-bharat" }));
  });

  it("'Change' opens the Customer tile on that project with the TDS filled in; nothing is booked", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={bharatLine} />);
    fireEvent.click(within(card()).getByRole("button", { name: "Change" }));
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
    expect(screen.getByRole("region", { name: "Project payment form" }).textContent).toBe("Project for cu-bharat · TDS 23600 (194J-10)");
    expect(screen.getByText("Customer", { selector: "span.text-ink" })).toBeTruthy();
    expect(state.allocate).not.toHaveBeenCalled();
    expect(state.rpc).toHaveBeenCalledWith("log_activity", expect.objectContaining({ p_action: "reconcile_suggestion_change" }));
  });

  it("picking another tile also leaves the card (counted as Change)", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={bharatLine} />);
    fireEvent.click(screen.getByRole("radio", { name: /Own transfer/ }));
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
    expect(screen.getByText("Own transfer", { selector: "span.text-ink" })).toBeTruthy();
  });

  it("ambiguous — only the shared word 'SCN' in the line → no card, the tiles as before", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={{ ...bharatLine, description: "NEFT CR-ICIC0001957-SCN-KIST" } as BankTransactionRow} />);
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
    expect(screen.getAllByRole("radio").every((t) => t.getAttribute("aria-checked") === "false")).toBe(true);
  });

  it("a payment already recorded that matches the line → no card (never count the money twice)", () => {
    state.suggestions = [{ match_type: "project_payment", match_id: "PP1", match_label: "SCN Mobile app", match_amount: 212400, match_date: "2026-10-24", match_confidence: "exact" }];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={bharatLine} />);
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
  });
});

describe("R-2007 Suggestion card — money out (Google ₹5,000, bill SCN-G-20 ₹11,800)", () => {
  beforeEach(() => {
    state.vendors = [{ id: "v-google", name: "Google Cloud India Pvt Ltd", default_tds_section: null }];
    state.vendorItems = [G20];
  });

  it("says the vendor, the bill and the part payment; accept runs the vendor section's save with ₹5,000 on SCN-G-20", async () => {
    const onOpenChange = vi.fn();
    render(<ReconcileTransactionDialog open onOpenChange={onOpenChange} transaction={googleLine} />);
    expect(within(card()).getByText("Google Cloud India Pvt Ltd · Bill SCN-G-20 · part payment")).toBeTruthy();
    expect(card().textContent).toContain("Bank ₹5,000 of ₹11,800 due · ₹6,800 stays due");
    expect(screen.getByRole("radio", { name: /Vendor/ }).getAttribute("aria-checked")).toBe("true");
    expect(screen.queryByRole("region", { name: "Paying a vendor" })).toBeNull();   // mounted, hidden
    fireEvent.click(within(card()).getByRole("button", { name: "Looks right — reconcile" }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(state.payVendor).toHaveBeenCalledWith({
      transactionId: "t-google", vendorId: "v-google", newVendor: null,
      items: [{ item: G20, cash: 5000, tds: 0, section: null }],
      newBill: null, advance: 0, advanceCategory: null, bankCharge: 0, note: null,
    });
  });

  it("'Change' opens the Vendor tile (its form ticks the same bill)", () => {
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={googleLine} />);
    fireEvent.click(within(card()).getByRole("button", { name: "Change" }));
    expect(screen.getByRole("region", { name: "Paying a vendor" })).toBeTruthy();
    expect(state.payVendor).not.toHaveBeenCalled();
  });

  it("two open bills, neither exact → no card", () => {
    state.vendorItems = [G20, { ...G20, doc_id: "BILL-2", bill_no: "G-21" }];
    render(<ReconcileTransactionDialog open onOpenChange={() => {}} transaction={googleLine} />);
    expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull();
  });
});
