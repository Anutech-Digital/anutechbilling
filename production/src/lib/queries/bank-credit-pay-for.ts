/**
 * R-1838 — the money-in "This money is for:" step: its reads and its two writes.
 *
 * Every write is ONE server call, one transaction (migration 20261024131600):
 *   reconcile_bank_credit_to_item   — an open quote / invoice of the customer
 *   reconcile_bank_credit_new_sale  — a new sale (seats × unit price) with no quote yet
 * Both go through record_desk_payment → (generate_invoice) → reconcile_bank_txn. Nothing here
 * computes money: the result the sheet shows is what the database did.
 *
 * R-1863 (migration 20261024144118): reconcile_bank_credit_as_advance (an advance — receipt +
 * customer credit, as record_payment writes an overpayment), bank_old_one_off_bookings (read) and
 * relink_bank_one_off_sale (undo an old one-off bank sale + book one of the three, one transaction).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toastInvoiceIssueError } from "@/lib/queries/invoices";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import type { OldOneOffBooking, OpenItem, PayForResult, SaleLine } from "@/lib/banking/credit-pay-for";
import { saleLinesPayload } from "@/lib/banking/credit-pay-for";
import { ADVANCE_PAYMENT_NOTE_PREFIX, advancePaymentIds, type SplitLinePayment } from "@/lib/banking/bank-row-label";
import { isSplitBilled } from "@/lib/billing/instalments";
import { splitArgs, type SplitInput } from "@/lib/banking/credit-pay-for-multi";
import type { BillingCycle } from "@/lib/supabase/database.types";

/* The generated types do not know the R-1838 functions yet (migration not applied there). */
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };
const rpc = (fn: string, args: Record<string, unknown>) => (createClient() as unknown as RpcClient).rpc(fn, args);

export const openItemsKey = (customerId: string | null) => ["bank_credit_open_items", customerId] as const;

/** What this customer still owes: open renewal / add-seats / new quotes and unpaid invoices. */
export function useBankCreditOpenItems(customerId: string | null) {
  return useQuery({
    queryKey: openItemsKey(customerId),
    enabled: Boolean(customerId),
    queryFn: async (): Promise<OpenItem[]> => {
      const { data, error } = await rpc("bank_credit_open_items", { p_customer_id: customerId });
      if (error) throw error;
      return ((data ?? []) as OpenItem[]).map((r) => ({
        ...r,
        amount_due: Number(r.amount_due) || 0,
        taxable_value: Number(r.taxable_value) || 0,
      }));
    },
    staleTime: 15_000,
  });
}

export interface PayItemInput {
  transactionId: string;
  quoteId: string | null;
  invoiceId: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
  /** null = not a new subscription sale (the server ignores it). */
  createSubscription: boolean | null;
  subStart: string | null;
  /** Sent only when the operator changed it; else the term decides. */
  subRenewal: string | null;
}

export interface NewSaleInput {
  transactionId: string;
  customerId: string;
  lines: readonly SaleLine[];
  createSubscription: boolean;
  subStart: string | null;
  subRenewal: string | null;
  tdsAmount: number;
  tdsRatePct: number | null;
  /** R-2026: how often it is billed (the quote's billing_cycle). Null/absent = the server's
   *  default (yearly; Monthly flex is always monthly). */
  billingCycle?: BillingCycle | null;
}

/** The RPC arguments — exported so the tests pin exactly what reaches the server. */
export function payItemArgs(i: PayItemInput) {
  return {
    p_txn_id: i.transactionId,
    p_quote_id: i.invoiceId ? null : i.quoteId,
    p_invoice_id: i.invoiceId,
    p_tds_amount: Math.max(0, Math.round(i.tdsAmount)),
    p_tds_rate_pct: i.tdsAmount > 0 ? i.tdsRatePct : null,
    p_tds_section: i.tdsAmount > 0 ? "194J" : null,
    p_create_subscription: i.createSubscription,
    p_sub_start: i.createSubscription ? i.subStart : null,
    p_sub_renewal: i.createSubscription ? i.subRenewal : null,
  };
}

export function newSaleArgs(i: NewSaleInput) {
  return {
    p_txn_id: i.transactionId,
    p_customer_id: i.customerId,
    p_lines: saleLinesPayload(i.lines),
    p_create_subscription: i.createSubscription,
    p_sub_start: i.createSubscription ? i.subStart : null,
    p_sub_renewal: i.createSubscription ? i.subRenewal : null,
    p_tds_amount: Math.max(0, Math.round(i.tdsAmount)),
    p_tds_rate_pct: i.tdsAmount > 0 ? i.tdsRatePct : null,
    p_tds_section: i.tdsAmount > 0 ? "194J" : null,
    p_billing_cycle: i.billingCycle ?? null,
  };
}

/**
 * R-2026: a sale paid in parts (annual commitment billed quarterly …) gets its FIRST bill's tax
 * invoice now — the Record payment sheet's own call (R-527: POST /api/quotes/:id/raise-instalments,
 * the billing cron's code; idempotent per period). The payment is already booked; a failure here
 * only says the daily run will raise it.
 */
export async function raiseFirstInstalment(r: PayForResult, cycle: BillingCycle | null | undefined, post: typeof fetch = fetch): Promise<PayForResult> {
  if (!isSplitBilled(cycle) || !r.quote_id || r.already_recorded || r.invoice_issued) return r;
  try {
    const resp = await post(`/api/quotes/${encodeURIComponent(r.quote_id)}/raise-instalments`, { method: "POST" });
    const body = (await resp.json().catch(() => null)) as
      { raised?: Array<{ invoice_id?: string | null }>; errors?: Array<{ message?: string }>; error?: string } | null;
    if (!resp.ok || !body) return { ...r, instalment_error: body?.error ?? `HTTP ${resp.status}` };
    const first = body.raised?.find((x) => x?.invoice_id)?.invoice_id ?? null;
    if (first) return { ...r, invoice_issued: first };
    const err = body.errors?.[0]?.message ?? null;
    return err ? { ...r, instalment_error: err } : r;
  } catch (e) {
    return { ...r, instalment_error: e instanceof Error ? e.message : String(e) };
  }
}

function useAfterPay() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["bank_transactions"] });
    qc.invalidateQueries({ queryKey: ["bank_credit_open_items"] });
    /* payments, invoices, quotes, subscriptions, credit notes, dues: the one list (R-1634). */
    invalidateReceivables(qc);
  };
}

/** A missing company GSTIN / address (R-1643) gets its one-click fix; anything else is said plainly. */
const onPayError = (err: unknown) => toastInvoiceIssueError(err);

export function usePayItemFromBankCredit() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (input: PayItemInput): Promise<PayForResult> => {
      const { data, error } = await rpc("reconcile_bank_credit_to_item", payItemArgs(input));
      if (error) throw error;
      if (!data) throw new Error("The payment was not confirmed — refresh the page to see whether it was saved.");
      return data as PayForResult;
    },
    onSuccess: after,
    onError: onPayError,
  });
}

/* ─── R-1863: advance, old one-off bookings, relink (migration 20261024144118_r1863_bank_credit_advance) ─────────────────── */

export interface AdvanceInput { transactionId: string; customerId: string }

export function advanceArgs(i: AdvanceInput) {
  return { p_txn_id: i.transactionId, p_customer_id: i.customerId };
}

/** Books the line as the customer's advance (on account) — one transaction on the server. */
export function useAdvanceFromBankCredit() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (input: AdvanceInput): Promise<PayForResult> => {
      const { data, error } = await rpc("reconcile_bank_credit_as_advance", advanceArgs(input));
      if (error) throw error;
      if (!data) throw new Error("The advance was not confirmed — refresh the page to see whether it was saved.");
      return data as PayForResult;
    },
    onSuccess: after,
    onError: onPayError,
  });
}

export const oldOneOffKey = (accountId: string | null) => ["bank_transactions", "old_one_off", accountId] as const;

/** Bank lines booked before R-1838 as a one-off "bank sale" — read only. */
export function useOldOneOffBookings(accountId: string | null, enabled = true) {
  return useQuery({
    queryKey: oldOneOffKey(accountId),
    enabled: Boolean(accountId) && enabled,
    queryFn: async (): Promise<OldOneOffBooking[]> => {
      const { data, error } = await rpc("bank_old_one_off_bookings", { p_bank_account_id: accountId });
      if (error) throw error;
      return ((data ?? []) as OldOneOffBooking[]).map((r) => ({
        ...r,
        amount: Number(r.amount) || 0,
        invoice_amount: Number(r.invoice_amount) || 0,
      }));
    },
    staleTime: 15_000,
  });
}

/** What a relink books the line on — the same three paths, as one JSON target. */
export type RelinkTarget =
  | ({ path: "item" } & PayItemInput)
  | ({ path: "new_sale" } & NewSaleInput)
  | ({ path: "advance" } & AdvanceInput);

/** relink_bank_one_off_sale's p_target: the path's own RPC arguments without the p_ prefix. */
export function relinkArgs(t: RelinkTarget) {
  const args = t.path === "item" ? payItemArgs(t) : t.path === "new_sale" ? newSaleArgs(t) : advanceArgs(t);
  const target: Record<string, unknown> = { path: t.path };
  for (const [k, v] of Object.entries(args)) if (k !== "p_txn_id") target[k.replace(/^p_/, "")] = v;
  return { p_txn_id: t.transactionId, p_target: target };
}

/** Undo the old one-off sale and book the line on what it paid — ONE server transaction. */
export function useRelinkOneOffSale() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (t: RelinkTarget): Promise<PayForResult> => {
      const { data, error } = await rpc("relink_bank_one_off_sale", relinkArgs(t));
      if (error) throw error;
      if (!data) throw new Error("The relink was not confirmed — refresh the page to see whether it was saved.");
      return t.path === "new_sale" ? raiseFirstInstalment(data as PayForResult, t.billingCycle) : (data as PayForResult);
    },
    /* The undone sale's invoice + credit note refresh via invalidateReceivables (["invoices"], ["credit-notes"]). */
    onSuccess: after,
    onError: onPayError,
  });
}

export function useNewSaleFromBankCredit() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (input: NewSaleInput): Promise<PayForResult> => {
      const { data, error } = await rpc("reconcile_bank_credit_new_sale", newSaleArgs(input));
      if (error) throw error;
      if (!data) throw new Error("The sale was not confirmed — refresh the page to see whether it was saved.");
      return raiseFirstInstalment(data as PayForResult, input.billingCycle);
    },
    onSuccess: after,
    onError: onPayError,
  });
}

/* ─── R-2025 (0): which reconciled bank lines are customer ADVANCES (row badge "Advance") ─── */

/** The payment ids (matched_to_id of "payment" lines) that are R-1863 advances — read-only. */
export function useBankAdvancePaymentIds(paymentIds: readonly string[]) {
  const ids = [...new Set(paymentIds)].sort();
  return useQuery({
    queryKey: ["bank_advance_payment_ids", ids] as const,
    enabled: ids.length > 0,
    queryFn: async (): Promise<Set<string>> => {
      const sb = createClient();
      const pays: Array<{ id: string; quote_id: string | null; notes: string | null }> = [];
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await sb.from("payments").select("id, quote_id, notes")
          .in("id", ids.slice(i, i + 150)).like("notes", `${ADVANCE_PAYMENT_NOTE_PREFIX}%`);
        if (error) throw error;
        pays.push(...((data ?? []) as typeof pays));
      }
      const quoteIds = [...new Set(pays.map((p) => p.quote_id).filter((q): q is string => Boolean(q)))];
      if (quoteIds.length === 0) return new Set();
      const quotes: Array<{ id: string; plan: string | null; amount: number | null; invoice_id: string | null; line_items: unknown }> = [];
      for (let i = 0; i < quoteIds.length; i += 150) {
        const { data, error } = await sb.from("quotes").select("id, plan, amount, invoice_id, line_items").in("id", quoteIds.slice(i, i + 150));
        if (error) throw error;
        quotes.push(...((data ?? []) as unknown as typeof quotes));
      }
      return advancePaymentIds(pays, quotes.map((q) => ({ ...q, amount: Number(q.amount) || 0 })));
    },
    staleTime: 30_000,
  });
}

/* ─── R-2098: one line → several items (+ a new sale), the rest advance / round-off ─────────── */

/** ONE server transaction (reconcile_bank_credit_split, migration 20261029054707). The new sale's
 *  first instalment invoice, when it is billed in parts, is raised as for a single new sale. */
export function useSplitFromBankCredit() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (input: SplitInput & { customerName?: string | null }): Promise<PayForResult> => {
      const { data, error } = await rpc("reconcile_bank_credit_split", splitArgs(input));
      if (error) throw error;
      if (!data) throw new Error("The payments were not confirmed — refresh the page to see whether they were saved.");
      const r = data as PayForResult;
      const parts = await Promise.all((r.parts ?? []).map((p) =>
        p.new_quote ? raiseFirstInstalment(p, (input.sale?.billingCycle ?? null) as BillingCycle | null) : Promise.resolve(p)));
      return { ...r, parts, customer_id: input.customerId, customer_name: input.customerName ?? null };
    },
    onSuccess: after,
    onError: onPayError,
  });
}

/* ─── R-2098: the receipts on lines that paid several items (bank row "N payments") ─── */

/** bank line id → its receipts (payments.bank_txn_id). Read-only; RLS scopes to the company. */
export function useBankSplitLinePayments(txnIds: readonly string[]) {
  const ids = [...new Set(txnIds)].sort();
  return useQuery({
    queryKey: ["bank_transactions", "split_payments", ids] as const,
    enabled: ids.length > 0,
    queryFn: async (): Promise<Map<string, SplitLinePayment[]>> => {
      const sb = createClient() as unknown as { from: (t: string) => { select: (c: string) => { in: (c: string, v: string[]) => { eq: (c: string, v: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> } } } };
      const out = new Map<string, SplitLinePayment[]>();
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await sb.from("payments").select("id, amount, quote_id, invoice_id, receipt_voucher_no, bank_txn_id")
          .in("bank_txn_id", ids.slice(i, i + 150)).eq("status", "received");
        if (error) throw error;
        for (const r of (data ?? []) as Array<SplitLinePayment & { bank_txn_id: string }>) {
          const list = out.get(r.bank_txn_id) ?? [];
          list.push({ id: r.id, amount: Number(r.amount) || 0, quote_id: r.quote_id, invoice_id: r.invoice_id, receipt_voucher_no: r.receipt_voucher_no });
          out.set(r.bank_txn_id, list);
        }
      }
      return out;
    },
    staleTime: 30_000,
  });
}
