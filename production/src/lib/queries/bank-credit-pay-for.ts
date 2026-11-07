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

import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toastInvoiceIssueError } from "@/lib/queries/invoices";
import { invalidateReceivables } from "@/lib/queries/receivables-refresh";
import type { OldOneOffBooking, OpenItem, PayForResult, SaleLine } from "@/lib/banking/credit-pay-for";
import { saleLinesPayload } from "@/lib/banking/credit-pay-for";
import { ADVANCE_PAYMENT_NOTE_PREFIX, advancePaymentIds, type SplitLinePayment } from "@/lib/banking/bank-row-label";
import type { SplitInput } from "@/lib/banking/credit-pay-for-multi";
import {
  keepZohoNumberOnFirstPart as keepZohoNumberCore, payItemCall as payItemCore, newSaleInCurrency as newSaleInCurrencyCore,
  newSaleCall, splitCall, raiseFirstInstalment, payItemArgs, newSaleArgs,
  type PayItemInput, type NewSaleInput, type SaleFxInput, type ZohoKept,
} from "@/lib/banking/credit-pay-calls";
import { paymentApprovalBlock } from "@/lib/quotes/payment-approval";

/* The generated types do not know the R-1838 functions yet (migration not applied there). */
type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }> };
const rpc = (fn: string, args: Record<string, unknown>) => (createClient() as unknown as RpcClient).rpc(fn, args);

/* R-2535: the booking calls live in lib/banking/credit-pay-calls.ts (server-safe, no "use client") so
   the server's Reconcile-from-Zoho run sends exactly what this sheet sends. Same names kept here. */
export {
  payItemArgs, newSaleArgs, payItemFxArgs, newSaleFxRpcArgs, raiseFirstInstalment,
  type PayItemInput, type NewSaleInput, type SaleFxInput, type ZohoKept,
} from "@/lib/banking/credit-pay-calls";
export function keepZohoNumberOnFirstPart<T extends PayForResult & ZohoKept>(r: T, call: typeof rpc = rpc): Promise<T> {
  return keepZohoNumberCore(r, call);
}
export function payItemCall(input: PayItemInput, call: typeof rpc = rpc): Promise<PayForResult> {
  return payItemCore(input, call);
}
export function newSaleInCurrency(input: NewSaleInput, fx: SaleFxInput, call: typeof rpc = rpc): Promise<PayForResult> {
  return newSaleInCurrencyCore(input, fx, call);
}

export const openItemsKey = (customerId: string | null) => ["bank_credit_open_items", customerId] as const;

/** What this customer still owes: open renewal / add-seats / new quotes and unpaid invoices. */
export function useBankCreditOpenItems(customerId: string | null) {
  return useQuery({
    queryKey: openItemsKey(customerId),
    enabled: Boolean(customerId),
    queryFn: async (): Promise<OpenItem[]> => {
      const { data, error } = await rpc("bank_credit_open_items", { p_customer_id: customerId });
      if (error) throw error;
      const rows = (data ?? []) as OpenItem[];
      /* R-2213: which quotes the DB would refuse money on (below cost, not approved) — read from the
         quote rows, judged by the same rule as the trigger (lib/quotes/payment-approval.ts). */
      const quoteIds = [...new Set(rows.map((r) => r.quote_id).filter((x): x is string => Boolean(x)))];
      const blocks = new Map<string, string>();
      if (quoteIds.length > 0) {
        const { data: qs, error: qErr } = await createClient()
          .from("quotes").select("id, below_cost, approval_status").in("id", quoteIds);
        if (qErr) throw qErr;
        for (const q of qs ?? []) {
          const b = paymentApprovalBlock(q);
          if (b) blocks.set(q.id, b.reason);
        }
      }
      return rows.map((r) => ({
        ...r,
        amount_due: Number(r.amount_due) || 0,
        taxable_value: Number(r.taxable_value) || 0,
        /* R-2466: numeric comes back as a string; absent on a DB before the migration → ₹. */
        currency: r.currency ?? "INR",
        fx_rate: r.fx_rate == null ? null : Number(r.fx_rate) || null,
        approval_block: r.quote_id ? blocks.get(r.quote_id) ?? null : null,
      }));
    },
    staleTime: 15_000,
  });
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
    mutationFn: (input: PayItemInput): Promise<PayForResult> => payItemCall(input),
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
      return newSaleCall(input, rpc);
    },
    onSuccess: after,
    onError: onPayError,
  });
}


/* ─── R-2025 (0): which reconciled bank lines are customer ADVANCES (row badge "Advance") ─── */

/** The payment ids (matched_to_id of "payment" lines) that are R-1863 advances — read-only. */
export function useBankAdvancePaymentIds(paymentIds: readonly string[]) {
  /* R-2524: one query per chunk of the lines on screen (in screen order), all at once — "Load more"
     adds a chunk instead of re-asking for every id, and a save re-reads only the chunk it touched. */
  return useQueries({
    queries: badgeChunks(paymentIds).map((ids) => ({
      queryKey: ["bank_advance_payment_ids", ids] as const,
      staleTime: 30_000,
      queryFn: async (): Promise<Set<string>> => {
        const sb = createClient();
        const { data, error } = await sb.from("payments").select("id, quote_id, notes")
          .in("id", ids).like("notes", `${ADVANCE_PAYMENT_NOTE_PREFIX}%`);
        if (error) throw error;
        const pays = (data ?? []) as Array<{ id: string; quote_id: string | null; notes: string | null }>;
        const quoteIds = [...new Set(pays.map((x) => x.quote_id).filter((q): q is string => Boolean(q)))];
        if (quoteIds.length === 0) return new Set();
        const { data: qs, error: qErr } = await sb.from("quotes").select("id, plan, amount, invoice_id, line_items").in("id", quoteIds);
        if (qErr) throw qErr;
        const quotes = (qs ?? []) as unknown as Array<{ id: string; plan: string | null; amount: number | null; invoice_id: string | null; line_items: unknown }>;
        return advancePaymentIds(pays, quotes.map((q) => ({ ...q, amount: Number(q.amount) || 0 })));
      },
    })),
    combine: (rs) => ({ data: new Set(rs.flatMap((r) => (r.data ? [...r.data] : []))) as Set<string> | undefined }),
  });
}

/** R-2524: the ids of the lines on screen in BADGE_CHUNK runs (screen order, de-duplicated); each run
 *  sorted so the same lines are the same cache entry. */
export const BADGE_CHUNK = 100;
export function badgeChunks(ids: readonly string[]): string[][] {
  const uniq = [...new Set(ids)];
  const out: string[][] = [];
  for (let i = 0; i < uniq.length; i += BADGE_CHUNK) out.push(uniq.slice(i, i + BADGE_CHUNK).sort());
  return out;
}

/* ─── R-2098: one line → several items (+ a new sale), the rest advance / round-off ─────────── */

/** ONE server transaction (reconcile_bank_credit_split, migration 20261029054707). The new sale's
 *  first instalment invoice, when it is billed in parts, is raised as for a single new sale. */
export function useSplitFromBankCredit() {
  const after = useAfterPay();
  return useMutation({
    mutationFn: async (input: SplitInput & { customerName?: string | null }): Promise<PayForResult> => {
      return splitCall(input, rpc);
    },
    onSuccess: after,
    onError: onPayError,
  });
}

/* ─── R-2098: the receipts on lines that paid several items (bank row "N payments") ─── */

/** bank line id → its receipts (payments.bank_txn_id). Read-only; RLS scopes to the company. */
export function useBankSplitLinePayments(txnIds: readonly string[]) {
  /* R-2524: chunked like useBankAdvancePaymentIds. The key stays under "bank_transactions" ON PURPOSE:
     every bank save invalidates that prefix, so a line just split (or un-split) re-reads its receipts
     at once — now that is one chunk of ≤ 100 ids on screen, not every payment line of the account. */
  return useQueries({
    queries: badgeChunks(txnIds).map((ids) => ({
      queryKey: ["bank_transactions", "split_payments", ids] as const,
      staleTime: 30_000,
      queryFn: async (): Promise<Map<string, SplitLinePayment[]>> => {
        const sb = createClient() as unknown as { from: (t: string) => { select: (c: string) => { in: (c: string, v: string[]) => { eq: (c: string, v: string) => PromiseLike<{ data: unknown; error: { message: string } | null }> } } } };
        const out = new Map<string, SplitLinePayment[]>();
        const { data, error } = await sb.from("payments").select("id, amount, quote_id, invoice_id, receipt_voucher_no, bank_txn_id")
          .in("bank_txn_id", ids).eq("status", "received");
        if (error) throw error;
        for (const r of (data ?? []) as Array<SplitLinePayment & { bank_txn_id: string }>) {
          const list = out.get(r.bank_txn_id) ?? [];
          list.push({ id: r.id, amount: Number(r.amount) || 0, quote_id: r.quote_id, invoice_id: r.invoice_id, receipt_voucher_no: r.receipt_voucher_no });
          out.set(r.bank_txn_id, list);
        }
        return out;
      },
    })),
    combine: (rs) => ({ data: new Map(rs.flatMap((r) => (r.data ? [...r.data] : []))) as Map<string, SplitLinePayment[]> | undefined }),
  });
}
