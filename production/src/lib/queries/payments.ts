/**
 * Payments — dedicated table queries.
 *
 * Each row in `payments` is a single transaction (could be one of multiple installments
 * for the same quote). Partial / refund support built in.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { PAYMENT_COLUMNS } from "@/lib/queries/columns";
import type { Payment, PaymentMethod } from "@/lib/supabase/database.types";
import { oldestInstalmentPerSubscription } from "@/lib/payments/instalment-payment";

// ============================================================
// Read — all payments for a tenant (used by /payments dashboard)
// ============================================================
export function usePayments() {
  return useQuery({
    queryKey: ["payments"],
    queryFn: async (): Promise<Payment[]> => {
      const supabase = createClient();
      /* R-264: PostgREST stops at 1000 rows without saying so — page them all; the order
         ends on id so offset pages never repeat or skip a row (lib/ops/fetch-all.ts). */
      return await fetchAllRows<Payment>((from, to) =>
        supabase
          .from("payments")
          .select(PAYMENT_COLUMNS)
          .order("received_at", { ascending: false })
          .order("id", { ascending: true })
          .range(from, to));
    },
  });
}

// ============================================================
// Read — all payments for one quote (used by quote detail history card)
// ============================================================
export function usePaymentsByQuote(quoteId: string | null | undefined) {
  return useQuery({
    queryKey: ["payments", "by-quote", quoteId],
    enabled: !!quoteId,
    queryFn: async (): Promise<Payment[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("payments")
        .select(PAYMENT_COLUMNS)
        .eq("quote_id", quoteId!)
        .order("received_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Payment[];
    },
  });
}

// ============================================================
// R-1564 — an instalment invoice's subscription + the quote it was sold on
// ============================================================
/**
 * raise_subscription_billing leaves invoices.quote_id NULL on an instalment (the PDF would
 * print the year's quote total); the link is subscription_billings.invoice_id. null = this
 * invoice is not an instalment. quoteId null = the subscription was not sold on a quote.
 */
export function useInstalmentLink(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["invoices", "instalment-link", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<{ subscriptionId: string; quoteId: string | null } | null> => {
      const supabase = createClient();
      const { data: b, error } = await supabase
        .from("subscription_billings")
        .select("subscription_id")
        .eq("invoice_id", invoiceId!)
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      if (!b) return null;
      const { data: s, error: sErr } = await supabase
        .from("subscriptions")
        .select("quote_id")
        .eq("id", b.subscription_id)
        .maybeSingle();
      if (sErr) throw sErr;
      return { subscriptionId: b.subscription_id, quoteId: s?.quote_id ?? null };
    },
  });
}

// ============================================================
// Sum received payments for one quote (active = not refunded)
// ============================================================
export function totalReceived(payments: Payment[]): number {
  return payments
    .filter((p) => p.status === "received")
    .reduce((s, p) => s + p.amount, 0);
}

// ============================================================
// Edit a payment's SAFE fields (method / reference / date / notes)
// ============================================================
// Deliberately does NOT touch amount, quote_id, customer_id or status —
// those drive the receipt voucher value, subscription state and invoice
// linkage. Correcting an amount must go through a reverse + re-record flow
// (GST: you can't silently alter an issued receipt voucher's value), not this.
// The receipt voucher (RV) is rendered on demand from the payment row, so a
// corrected method/reference/date shows up on the RV automatically — the RV
// number stays the same (this is a detail correction, not a new voucher).
export function useUpdatePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id:              string;
      method:          PaymentMethod;
      reference:       string | null;
      received_at:     string;   // ISO timestamp
      notes:           string | null;
      bank_account_id: string | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("payments")
        .update({
          method:          input.method,
          reference:       input.reference,
          received_at:     input.received_at,
          notes:           input.notes,
          bank_account_id: input.bank_account_id,
        })
        .eq("id", input.id);
      if (error) throw error;
      return input.id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["payments", "by-quote"] });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      toast.success("Payment details updated");
    },
    onError: (err) => toastError(err),
  });
}

// ============================================================
// Refund a payment — atomic via RPC (migration 20260901120000, audit A5b)
// ============================================================
// Pehle ye ek nanga status-flip tha — na quote ka recompute, na subscription
// ka outstanding, na RFV voucher, na overpayment-credit ka band hona. Zero
// callers the, aur wahi uski suraksha thi: jo pehla engineer ise button se
// jodta, ledger corrupt karta. Ab poora ulat-pher ek transaction me RPC ke
// andar hai (test: refund_payment.test.sql — RFV, recompute, credit-close,
// double-guard, invoice-guard). GST-invoice/bank-reconciled wale case RPC
// khud §24-shaili me refuse karta hai — message me agla kadam hota hai.
// Gateway par paisa YE NAHI bhejta — wo operator Razorpay/bank se karta hai.
/**
 * R-1563: the open credit that can pay a refund on an invoiced quote — credit made by credit
 * notes on that invoice (R-1566) and the payment's own open overpayment credit. Read just
 * before the refund dialog; refund_payment checks the same thing again on the click.
 */
export async function fetchRefundCredit(paymentId: string, invoiceId: string): Promise<{ ownOpenCredit: number; creditNoteCredit: number }> {
  const supabase = createClient();
  const [own, cn] = await Promise.all([
    supabase.from("customer_credits").select("amount").eq("source_payment_id", paymentId).eq("status", "open"),
    supabase.from("customer_credits").select("amount").eq("source_invoice_id", invoiceId).eq("source", "credit_note").eq("status", "open"),
  ]);
  if (own.error) throw new Error(own.error.message);
  if (cn.error) throw new Error(cn.error.message);
  const sum = (rows: { amount: number }[] | null) => (rows ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
  return { ownOpenCredit: sum(own.data), creditNoteCredit: sum(cn.data) };
}

export function useRefundPayment(opts?: { onBlocked?: (message: string) => void }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("refund_payment", {
        p_payment_id: id,
        p_reason: reason,
      });
      if (error) throw new Error(error.message);
      return data as { refund_voucher_no: string; amount: number };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["customer_credits"] });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      // R-1567: the refund gives back credit this payment used and reverses its TDS receivable.
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      // R-1563: a refund on an invoiced quote pays out credit-note credit and moves the invoice.
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast.success(`Refund booked — voucher ${r.refund_voucher_no}`, {
        description: "Kitab me darj hua. Asli paisa Razorpay/bank se aapko khud bhejna hai.",
      });
    },
    onError: (err) => {
      const msg = (err as Error).message;
      if (opts?.onBlocked && /credit note|un-reconcile|add-seats/i.test(msg)) {
        opts.onBlocked(msg);
        return;
      }
      toastError(err);
    },
  });
}

// ============================================================
// Delete a payment (correct a wrong entry) — atomic reverse via RPC
// ============================================================
// Reverses record_payment's money effects: recomputes the quote's paid amount +
// status and the subscription's outstanding; on a full reversal (nothing left)
// it also removes the subscription + auto-created PO this sale spun up and
// reverts the won lead. Blocks when a GST invoice was issued, the payment is
// bank-reconciled, or a linked PO has progressed — those must be handled first.
export function useDeletePayment(opts?: { onBlocked?: (message: string) => void }) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_payment", { p_payment_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["purchase-orders"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      // R-1568: delete removes its open credit, gives back credit it used, reverses its TDS.
      qc.invalidateQueries({ queryKey: ["customer_credits"] });
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      toast.success("Payment deleted & reversed");
    },
    // When the caller wants to surface blockers in a dialog (dependency-aware
    // delete), route the RPC's block message there instead of a toast.
    onError: (err) => {
      const msg = (err as Error).message;
      if (opts?.onBlocked) opts.onBlocked(msg);
      else toastError(err);
    },
  });
}

// ============================================================
// Outstanding receivables — subscriptions with unpaid balance
// ============================================================
export interface OutstandingRow {
  subscription_id:    string;
  customer_id:        string | null;
  customer_name:      string;
  plan:               string;
  outstanding_amount: number;
  total_quote_amount: number;
  paid_amount:        number;
  status:             "active" | "paused" | "expired" | "cancelled";
  first_payment_at:   string;
  last_reminder_at:   string | null;
  days_outstanding:   number;
  quote_id:           string | null;
  /** Postpaid credit clock; null when there is no agreed date. */
  payment_due_date:   string | null;
}

export function useOutstandingReceivables() {
  return useQuery({
    queryKey: ["outstanding-receivables"],
    queryFn: async (): Promise<OutstandingRow[]> => {
      const supabase = createClient();
      // 1. Fetch subscriptions with outstanding balance (excluding written-off/cancelled)
      const { data: subs, error } = await supabase
        .from("subscriptions")
        /* payment_due_date added 10 Sep 2026 — the postpaid credit clock, so the
           Outstanding card can show the same countdown the subscriptions list does. */
        .select("id, customer_id, customer_name, plan, outstanding_amount, status, last_reminder_at, created_at, written_off_at, payment_due_date")
        .gt("outstanding_amount", 0)
        .is("written_off_at", null);
      if (error) throw error;
      if (!subs || subs.length === 0) return [];

      // 2. Find the most-recent paid quote per customer (partial OR invoiced — both have
      //    outstanding balance possible; the invoice-issued case is post-advance pending).
      //    Without this fix, post-invoice quotes returned no row → "Pay" button + paid
      //    amount disappeared from Outstanding card even though balance was still owed.
      const customerIds = subs.map((s) => s.customer_id).filter(Boolean) as string[];
      const { data: quotes } = customerIds.length > 0
        ? await supabase
            .from("quotes")
            .select("id, customer_id, amount, payment_amount, customer_name, payment_status")
            .in("customer_id", customerIds)
            .in("payment_status", ["partial", "invoiced"])
        : { data: [] };

      // 3. Fetch ALL received payments (we need both: earliest date for aging anchor +
      //    accurate per-customer total paid, since payment_amount on the quote can be
      //    stale after invoice generation).
      const { data: receivedPayments } = customerIds.length > 0
        ? await supabase
            .from("payments")
            .select("customer_id, amount, received_at")
            .in("customer_id", customerIds)
            .eq("status", "received")
            .order("received_at", { ascending: true })
        : { data: [] };

      const earliestByCustomer = new Map<string, string>();
      const paidByCustomer     = new Map<string, number>();
      for (const p of receivedPayments ?? []) {
        if (!p.customer_id) continue;
        if (!earliestByCustomer.has(p.customer_id)) {
          earliestByCustomer.set(p.customer_id, p.received_at);
        }
        paidByCustomer.set(p.customer_id, (paidByCustomer.get(p.customer_id) ?? 0) + p.amount);
      }

      const quoteByCustomer = new Map<string, { id: string; amount: number }>();
      for (const q of quotes ?? []) {
        if (q.customer_id) {
          // Keep the latest quote per customer (in case of multiple)
          quoteByCustomer.set(q.customer_id, { id: q.id, amount: q.amount ?? 0 });
        }
      }

      const now = Date.now();
      return subs.map((s) => {
        const firstPaymentAt = earliestByCustomer.get(s.customer_id ?? "") ?? s.created_at;
        const quoteCtx = quoteByCustomer.get(s.customer_id ?? "");
        return {
          subscription_id:    s.id,
          customer_id:        s.customer_id,
          customer_name:      s.customer_name,
          plan:               s.plan,
          outstanding_amount: s.outstanding_amount,
          total_quote_amount: quoteCtx?.amount ?? 0,
          // Compute paid from actual payments ledger (not stale quote.payment_amount)
          paid_amount:        paidByCustomer.get(s.customer_id ?? "") ?? 0,
          status:             s.status as "active" | "paused" | "expired" | "cancelled",
          first_payment_at:   firstPaymentAt,
          last_reminder_at:   s.last_reminder_at,
          days_outstanding:   Math.floor((now - new Date(firstPaymentAt).getTime()) / 86400000),
          quote_id:           quoteCtx?.id ?? null,
          payment_due_date:   s.payment_due_date ?? null,
        };
      }).sort((a, b) => b.days_outstanding - a.days_outstanding);
    },
  });
}

// ============================================================
// Send reminder — stamps last_reminder_at, opens mailto
// ============================================================
export function useMarkReminderSent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (subscriptionId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("subscriptions")
        .update({ last_reminder_at: new Date().toISOString() })
        .eq("id", subscriptionId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
    },
    onError: (e) => toastError(e, { fallback: "Reminder mark nahi hua — dobara try karo" }),
  });
}

// ============================================================
// Suspend / Cancel / Write-off
// ============================================================
export function useSuspendSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (subscriptionId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("subscriptions")
        .update({ status: "paused" })
        .eq("id", subscriptionId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      toast.info("Subscription paused — remember to suspend service via vendor (Google CSP / M365 admin)");
    },
    onError: (e) => toastError(e, { fallback: "Pause nahi hua — subscription abhi bhi active hai" }),
  });
}

export function useResumeSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (subscriptionId: string) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("subscriptions")
        .update({ status: "active" })
        .eq("id", subscriptionId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      toast.success("Subscription resumed");
    },
  });
}

export function useWriteOffSubscription() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("subscriptions")
        .update({
          status: "cancelled",
          write_off_reason: reason,
          written_off_at:   new Date().toISOString(),
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Receivable written off · subscription cancelled");
    },
    onError: (e) => toastError(e),
  });
}

// ============================================================
// R-1525 — one receipt over several invoices of one customer
// ============================================================

/** An open invoice the multi-invoice sheet can apply money to (its own quote is set). */
export interface MultiPayInvoiceRow {
  id: string;
  invoice_date: string;
  due_date: string | null;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
  status: string;
  tax_rate: number | null;
  quote_id: string | null;
  /** R-1564: a subscription instalment (no quote of its own) — record_instalment_payment. */
  instalment?: boolean;
}

/**
 * The customer's invoices that still owe money AND are either the invoice their own quote
 * points at (quotes.invoice_id = invoices.id) or, R-1564, a subscription instalment
 * (subscription_billings.invoice_id) — the ones record_multi_invoice_payment accepts.
 * Paged (R-264): no silent 1000-row stop.
 */
export function useCustomerOpenInvoices(customerId: string | null | undefined) {
  return useQuery({
    queryKey: ["invoices", "open-for-multi-pay", customerId],
    enabled: !!customerId,
    queryFn: async (): Promise<MultiPayInvoiceRow[]> => {
      const supabase = createClient();
      const invoices = await fetchAllRows<MultiPayInvoiceRow>((from, to) =>
        supabase
          .from("invoices")
          .select("id, invoice_date, due_date, amount, net_payable, paid_amount, status, tax_rate, quote_id")
          .eq("customer_id", customerId!)
          .not("status", "in", "(paid,void)")
          .order("invoice_date", { ascending: true })
          .order("id", { ascending: true })
          .range(from, to));
      const quoteIds = [...new Set(invoices.map((i) => i.quote_id).filter((q): q is string => !!q))];
      const own = new Set<string>();
      for (let i = 0; i < quoteIds.length; i += 200) {
        const { data, error } = await supabase
          .from("quotes")
          .select("id, invoice_id")
          .in("id", quoteIds.slice(i, i + 200));
        if (error) throw error;
        for (const q of data ?? []) if (q.invoice_id) own.add(`${q.id}|${q.invoice_id}`);
      }
      /* R-1564: quote-less invoices that are subscription instalments — the OLDEST open one
         of each subscription only. Two instalments of one subscription share its quote, and
         quote + reference is the replay key, so the server takes one per receipt; anything
         over that instalment's due is recorded from the invoice page, where it goes to the
         next instalment by itself. */
      const quoteless = invoices.filter((i) => !i.quote_id).map((i) => i.id);
      const billing: Array<{ invoice_id: string | null; subscription_id: string; term_start: string; period_index: number }> = [];
      for (let i = 0; i < quoteless.length; i += 200) {
        const { data, error } = await supabase
          .from("subscription_billings")
          .select("invoice_id, subscription_id, term_start, period_index")
          .in("invoice_id", quoteless.slice(i, i + 200));
        if (error) throw error;
        billing.push(...(data ?? []));
      }
      const instalments = new Set(oldestInstalmentPerSubscription(billing));
      return invoices
        .filter((i) => (i.quote_id ? own.has(`${i.quote_id}|${i.id}`) : instalments.has(i.id)))
        .map((i) => (instalments.has(i.id) ? { ...i, instalment: true } : i));
    },
  });
}

export interface MultiInvoicePaymentInput {
  customerId: string;
  receivedOn: string;
  method: PaymentMethod;
  bankAccountId: string | null;
  reference: string;
  received: number;
  allocations: Array<{ invoice_id: string; amount: number; tds_amount?: number; tds_section?: string; tds_rate_pct?: number }>;
  excessToCredit: boolean;
  notes: string | null;
}

/** record_multi_invoice_payment — all lines or none (§17b). Errors are the RPC's own words. */
export function useRecordMultiInvoicePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: MultiInvoicePaymentInput) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("record_multi_invoice_payment", {
        p_customer_id:      input.customerId,
        p_received_on:      input.receivedOn,
        p_method:           input.method,
        p_bank_account_id:  input.bankAccountId,
        p_reference:        input.reference.trim(),
        p_received:         input.received,
        p_allocations:      input.allocations,
        p_excess_to_credit: input.excessToCredit,
        p_notes:            input.notes,
      });
      if (error) throw error;
      if (!data) throw new Error("The payment was not confirmed — refresh Payments to see whether it was saved.");
      return data;
    },
    onSuccess: () => {
      for (const key of ["payments", "invoices", "quotes", "customers", "customer-credits", "outstanding-receivables", "nav-badges", "tds_receivable", "subscriptions"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

export type { Payment, PaymentMethod };
