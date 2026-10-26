/**
 * Payment runs (R-163) — data for /accounting/payment-runs.
 *
 * Reads are plain tenant-scoped selects (RLS), paged past the gateway's 1000-row cap (R-1519). Every write is one of the four RPCs in
 * migration 20261005110000_payment_runs.sql, which own the rules (roles, approval, no double
 * payment); this file never writes payment_runs itself.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { errorMessage, fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";
import type { Payable, PayableSource, RunItem, VendorBank } from "@/lib/payables/payment-run";
import { expenseCashDue } from "@/lib/payables/still-due";

export interface PaymentRun {
  id: string;
  run_no: string;
  status: "draft" | "approved" | "paid" | "cancelled";
  bank_account_id: string;
  pay_on: string;
  total: number;
  note: string | null;
  created_by: string;
  created_at: string;
  approved_by: string | null;
  approved_at: string | null;
  paid_on: string | null;
  paid_at: string | null;
  items: RunItem[];
}

const KEY = ["payment-runs"] as const;

type Client = ReturnType<typeof createClient>;
type MsmeRow = { source: string; doc_id: string; deadline: string | null; over_limit: boolean };

/** fetchAllRows throws the query's own error (a plain object); the screen shows `.message`. */
const asError = (e: unknown) => new Error(errorMessage(e));

/**
 * Everything still owed in rupees: unpaid/partial vendor bills + unpaid expenses, with MSME deadlines.
 *
 * R-1519: every read is paged. `.limit(1000)` was exactly the gateway's cap, so a tenant with
 * 1,500 unpaid bills saw the first 1000 in a payment run and the rest were never offered for
 * payment. The MSME list (a set-returning RPC, capped the same way) is paged too — a bill past
 * its 1000th row lost its 45-day deadline. Each order ends on a unique column.
 */
export async function fetchPayables(supabase: Client): Promise<Payable[]> {
  const [bills, exps, msmeRows] = await Promise.all([
    fetchAllRows<{
      id: string; bill_no: string | null; vendor_id: string | null; vendor_name: string; bill_date: string; due_date: string | null;
      total: number | null; paid_amount: number | null; currency: string | null; status: string;
    }>((from, to) => supabase.from("vendor_bills")
      .select("id, bill_no, vendor_id, vendor_name, bill_date, due_date, total, paid_amount, currency, status")
      .in("status", ["unpaid", "partial"]).order("id", { ascending: true }).range(from, to)).catch((e) => { throw asError(e); }),
    fetchAllRows<{
      id: string; bill_no: string | null; vendor_id: string | null; vendor_name: string | null; category: string; expense_date: string;
      due_date: string | null; amount: number | null; currency: string | null; paid: boolean;
      tds_amount: number | null; advance_applied: number | null; paid_amount: number | null;
    }>((from, to) => supabase.from("expenses")
      .select("id, bill_no, vendor_id, vendor_name, category, expense_date, due_date, amount, currency, paid, tds_amount, advance_applied, paid_amount")
      .eq("paid", false).is("reconciled_txn_id", null).order("id", { ascending: true }).range(from, to)).catch((e) => { throw asError(e); }),
    // A failed MSME read leaves deadlines blank, as before — it never blocks the payables list.
    fetchAllRows<MsmeRow>((from, to) => supabase.rpc("msme_payables_aging", {})
      .order("source", { ascending: true }).order("doc_id", { ascending: true }).range(from, to) as unknown as PageQuery<MsmeRow>)
      .catch((): MsmeRow[] => []),
  ]);
  const msmeBy = new Map(msmeRows.map((m) => [`${m.source}:${m.doc_id}`, m]));
  const inr = (c: string | null) => !c || c.toUpperCase() === "INR";
  const out: Payable[] = [];
  for (const b of bills) {
    const owed = Math.max(0, Number(b.total ?? 0) - Number(b.paid_amount ?? 0));
    if (!owed || !inr(b.currency)) continue;
    const m = msmeBy.get(`vendor_bill:${b.id}`);
    out.push({ source: "vendor_bill", docId: b.id, docRef: b.bill_no, vendorId: b.vendor_id, vendorName: b.vendor_name,
      billDate: b.bill_date, dueDate: b.due_date, outstanding: owed, msmeDeadline: m?.deadline ?? null, msmeOverLimit: !!m?.over_limit });
  }
  for (const e of exps) {
    /* R-1952: the rest — less TDS, the vendor advance applied and the bank parts paid; the run
       pays exactly this (create_payment_run refuses anything else for an expense bill). */
    const owed = expenseCashDue(e);
    if (!owed || !inr(e.currency)) continue;
    const m = msmeBy.get(`expense:${e.id}`);
    out.push({ source: "expense", docId: e.id, docRef: e.bill_no, vendorId: e.vendor_id, vendorName: e.vendor_name || e.category,
      billDate: e.expense_date, dueDate: e.due_date, outstanding: owed, msmeDeadline: m?.deadline ?? null, msmeOverLimit: !!m?.over_limit });
  }
  return out;
}

export function usePayables() {
  return useQuery({
    queryKey: [...KEY, "payables"],
    queryFn: (): Promise<Payable[]> => fetchPayables(createClient()),
    staleTime: 15_000,
  });
}

export function usePaymentRuns() {
  return useQuery({
    queryKey: [...KEY, "runs"],
    queryFn: async (): Promise<PaymentRun[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("payment_runs")
        .select("*, items:payment_run_items(source, doc_id, doc_ref, vendor_id, vendor_name, amount)")
        .order("created_at", { ascending: false })
        .limit(40);
      if (error) throw new Error(error.message);
      return (data ?? []) as unknown as PaymentRun[];
    },
    staleTime: 10_000,
  });
}

/**
 * Every vendor's bank details — the bank file needs one for each bill in a run.
 * R-1519: paged; `.limit(2000)` came back as 1000 rows, so a run paying vendor no. 1001
 * had no account number for it.
 */
export async function fetchVendorBanks(supabase: Client): Promise<VendorBank[]> {
  return fetchAllRows<VendorBank>((from, to) => supabase.from("vendors")
    .select("id, name, bank_account_name, bank_account_no, bank_ifsc, upi_id")
    .order("id", { ascending: true }).range(from, to)).catch((e) => { throw asError(e); });
}

export function useVendorBanks() {
  return useQuery({
    queryKey: ["vendors", "banks"],
    queryFn: (): Promise<VendorBank[]> => fetchVendorBanks(createClient()),
    staleTime: 30_000,
  });
}

function useRunMutation<TArgs>(fn: (args: TArgs) => Promise<unknown>, done: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      for (const k of [KEY, ["vendor_bills"], ["vendor-bills"], ["vendors"], ["expenses"], ["bank_transactions"], ["bank_accounts"], ["balance-sheet"], ["accounting"], ["aging"]]) {
        qc.invalidateQueries({ queryKey: k as readonly unknown[] });
      }
      toast.success(done);
    },
    /* The database's refusals are written to be read ("VB-12 is already in another open
       payment run"); the description says what to do about the commonest ones. */
    onError: (e) => toastError(e, { description: "Nothing was changed. Refresh the page — a bill may have been paid or put in another run meanwhile." }),
  });
}

const rpc = async (name: string, args: Record<string, unknown>) => {
  const supabase = createClient();
  // The four functions are typed in database.generated.ts; the name is a union there.
  const { data, error } = await supabase.rpc(name as "approve_payment_run", args as { p_run_id: string });
  if (error) throw new Error(error.message);
  return data;
};

export const useCreatePaymentRun = () =>
  useRunMutation(
    (a: { items: { source: PayableSource; doc_id: string; amount: number }[]; bankAccountId: string; payOn: string; note?: string }) =>
      rpc("create_payment_run", { p_items: a.items, p_bank_account_id: a.bankAccountId, p_pay_on: a.payOn, p_note: a.note ?? null }),
    "Payment run created — waiting for approval",
  );
export const useApprovePaymentRun = () => useRunMutation((id: string) => rpc("approve_payment_run", { p_run_id: id }), "Approved — the bank file can be downloaded now");
export const useMarkRunPaid = () =>
  useRunMutation((a: { id: string; paidOn: string }) => rpc("mark_payment_run_paid", { p_run_id: a.id, p_paid_on: a.paidOn }), "Marked paid — bills settled and bank entries added");
export const useCancelPaymentRun = () => useRunMutation((id: string) => rpc("cancel_payment_run", { p_run_id: id }), "Payment run cancelled");
