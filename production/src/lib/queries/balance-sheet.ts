/**
 * Balance Sheet data.
 *
 * Two parts:
 *   1. useBalanceSheetAuto()  — figures ResellerOS can compute from its own
 *      records (cash & bank, trade receivables, TDS receivable, trade payables,
 *      GST payable). All "as of now" — current live balances.
 *   2. Manual line CRUD       — operator-entered items the app doesn't track
 *      (fixed assets, loans, owner's capital, drawings, deposits…), under
 *      Assets / Liabilities / Equity.
 *
 * The page combines both and derives Equity = Total Assets − Total Liabilities
 * so the sheet always balances (retained earnings is the plug — standard for a
 * single-entry books-lite setup).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { BalanceSheetSection } from "@/lib/supabase/database.types";
import { balanceSheetFromRpc, rpcRowOrThrow, type BalanceSheetRpcRow } from "@/lib/accounting/report-rpc";

export type BalanceSheetItem = {
  id:         string;
  section:    BalanceSheetSection;
  label:      string;
  amount:     number;
  sort_order: number;
  notes:      string | null;
};

export interface BalanceSheetAuto {
  cashAndBank:     number;   // sum of all bank + cash account balances
  undepositedFunds: number;  // R-179: customer receipts (payments + project payments) not matched to any bank line — money in hand, an asset
  receivables:     number;   // invoiced-but-unpaid, EXCLUDING project milestones (accrual)
  advancesFromCustomers: number; // money received before invoicing — a LIABILITY, not earnings
  projectReceivable: number; // one-time / project sales: total − payments received
  tdsReceivable:   number;   // pending TDS credits from customers
  employeeLoans:   number;   // outstanding loans/advances to employees (an asset)
  prepaidAdvances: number;   // vendor advances paid but not yet consumed (a current asset)
  fixedAssets:     number;   // registered assets at WDV (lib/accounting/depreciation.ts) + EMI purchases not yet registered, at cost
  payables:        number;   // unpaid vendor bills (total − paid)
  salaryPayable:   number;   // net salary accrued (payroll run) but not yet paid out — a liability
  salaryDuesPayable: number; // statutory dues: salary TDS/PF/ESI (both shares) + vendor TDS, less challans
  reimbursementsPayable: number; // company expenses paid from someone's own card/cash, not yet repaid (a liability)
  creditCardPayable: number; // outstanding owed on company credit-card accounts (a liability)
  emiLoansPayable: number;   // outstanding EMI/asset loans (a liability)
  businessLoansPayable: number; // outstanding principal on loans TAKEN by the company (a liability)
  gstPayable:      number;   // net GST this FY (output − input − GST paid for this FY's returns); may be negative (credit)
  gstPaid:         number;   // GST paid for this FY's return months (already inside gstPayable)
  advanceTaxPaid:  number;   // advance + self-assessment income tax paid for this FY (an asset)
  fyLabel:         string;   // e.g. "FY 2026-27" for the GST caveat
}

// ── Pure helpers (unit-tested — see balance-sheet.helpers.test.ts) ──────────

/**
 * Trade receivables on an ACCRUAL basis: invoiced but unpaid, EXCLUDING invoices
 * that belong to a project milestone (those are counted by `projectReceivable`,
 * so including them here would double-count — verified in prod: of ₹7,82,639
 * unpaid invoices, ₹6,85,000 were project milestones).
 *
 * `net_payable` is preferred over `amount` because migration 0005 freezes the
 * advance adjustment into it (CGST Rule 53) — using `amount` would re-count an
 * advance that was already applied.
 *
 * S45 (7 Oct 2026): minus `paid_amount` (record_payment writes it on every part payment,
 * R-015; Aging reads the same). Counting the whole net_payable while the part payment is
 * also money received put that amount on the Dr side twice — the Trial Balance moved by it.
 */
export function computeTradeReceivables(
  openInvoices: ReadonlyArray<{ id: string; amount?: number | null; net_payable?: number | null; paid_amount?: number | null }>,
  projectInvoiceIds: ReadonlySet<string>,
): number {
  return openInvoices
    .filter((i) => !projectInvoiceIds.has(i.id))
    .reduce((s, i) => s + Math.max(0, (i.net_payable ?? i.amount ?? 0) - (i.paid_amount ?? 0)), 0);
}

/**
 * S45 (7 Oct 2026): money owed BACK to customers after the invoice — overpayment, or a
 * credit note on an invoice already paid. Per invoiced quote: received − (invoice − credit
 * notes + debit notes), when positive. Before this it was nowhere: the money sat in cash /
 * undeposited funds with no liability against it, and the Trial Balance moved by it.
 * Only a quote's single, non-project invoice (split billing / milestones have their own
 * arithmetic). Mirrors report_balance_sheet (migration 20261007290000); it is added to
 * `advancesFromCustomers`.
 */
export function computeOwedBackToCustomers(
  invoicedQuotes: ReadonlyArray<{ received: number; invoice_amount: number; credit_notes: number; debit_notes: number }>,
): number {
  return invoicedQuotes.reduce(
    (s, q) => s + Math.max(0, q.received - (q.invoice_amount - q.credit_notes + q.debit_notes)), 0);
}

/**
 * Advances from customers: received payments against quotes that have NO invoice
 * yet. The cash is already an asset in `cashAndBank`; this is the matching
 * liability (service still owed). Without it the equity plug reports customer
 * money as retained earnings.
 */
export function computeCustomerAdvances(
  receivedPayments: ReadonlyArray<{ quote_id?: string | null; amount?: number | null }>,
  quotes: ReadonlyArray<{ id: string; invoice_id?: string | null }>,
): number {
  const unInvoiced = new Set(quotes.filter((q) => !q.invoice_id).map((q) => q.id));
  return receivedPayments
    .filter((p) => p.quote_id != null && unInvoiced.has(p.quote_id))
    .reduce((s, p) => s + (p.amount ?? 0), 0);
}

// ── Auto figures from app records ───────────────────────────────────────────
/**
 * S17 (28 Sep 2026): ek RPC, ek round trip.
 *
 * Pehle ye ~25 sequential reads the aur har bank account ke liye alag
 * `bank_account_current_balance` (N+1) — aur har table ki all-time rows browser me, jo
 * PostgREST ke row cap par chup-chaap kat jaati. `report_balance_sheet` (migration
 * 20260928110000) wahi filters SQL me chalata hai. Har figure ka "kyun" (accrual
 * receivables, project milestones double-count, customer advances, credit card liability,
 * WDV, ITC, statutory dues, cumulative GST) us migration me line ke saath likha hai; jo
 * niyam TS me tested hain wo lib/accounting/report-rpc.ts me wahi functions se chalte hain.
 * Purana per-row hisaab lib/accounting/reports-reference.ts me oracle hai — parity test
 * tests/parity/reports-parity.test.ts.
 */
export function useBalanceSheetAuto() {
  return useQuery({
    queryKey: ["balance-sheet", "auto"],
    queryFn: async (): Promise<BalanceSheetAuto> => {
      const supabase = createClient();
      const res = await supabase.rpc("report_balance_sheet", {});
      return balanceSheetFromRpc(rpcRowOrThrow<BalanceSheetRpcRow>(res, "report_balance_sheet"));
    },
    staleTime: 30_000,
  });
}

// ── Manual lines ────────────────────────────────────────────────────────────
export function useBalanceSheetItems() {
  return useQuery({
    queryKey: ["balance-sheet", "items"],
    queryFn: async (): Promise<BalanceSheetItem[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("balance_sheet_items")
        .select("id, section, label, amount, sort_order, notes")
        .order("section", { ascending: true })
        .order("sort_order", { ascending: true });
      if (error) throw error;
      return (data ?? []) as BalanceSheetItem[];
    },
  });
}

export function useCreateBalanceSheetItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { section: BalanceSheetSection; label: string; amount: number; notes?: string | null }) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { error } = await supabase.from("balance_sheet_items").insert({
        tenant_id: me.tenant_id,
        section:   input.section,
        label:     input.label,
        amount:    input.amount,
        notes:     input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["balance-sheet", "items"] });
      toast.success("Line added");
    },
    onError: (err) => toastError(err),
  });
}

export function useUpdateBalanceSheetItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; label: string; amount: number }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("balance_sheet_items")
        .update({ label: input.label, amount: input.amount })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["balance-sheet", "items"] });
      toast.success("Line updated");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteBalanceSheetItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("balance_sheet_items").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["balance-sheet", "items"] });
      toast.success("Line removed");
    },
    onError: (err) => toastError(err),
  });
}
