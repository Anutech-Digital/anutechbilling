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
import { fetchAllRows, fetchAllRowsIn, type PageQuery } from "@/lib/ops/fetch-all";
import { toOpenBalanceMap, type QuoteOpenBalanceRow } from "@/lib/quotes/open-balances";
import { todayIST } from "@/lib/subscriptions/payment-due";
import { queryKeys } from "@/lib/queries/keys";
import { rupee } from "@/lib/utils";
import { PAYMENT_COLUMNS } from "@/lib/queries/columns";
import { isOpeningInvoice } from "@/lib/accounting/sale-documents";
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
// R-1745 — the customer on the invoices that quote-less payments were recorded on
// ============================================================
/* R-1747: + external_number — the Zoho number the refund flow and the receipt print. */
type InvoiceCustomerRow = { id: string; customer_id: string | null; customer_name: string | null; external_number: string | null };
/** A payment on an imported Zoho invoice (R-1739) has no quote; its customer is the invoice's.
 *  Only those invoice ids are read (lib/payments/payment-customer.ts quotelessInvoiceIds). */
export function usePaymentInvoiceCustomers(invoiceIds: readonly string[]) {
  const ids = [...invoiceIds].sort();
  return useQuery({
    queryKey: ["payments", "invoice-customers", ids],
    enabled: ids.length > 0,
    queryFn: async (): Promise<InvoiceCustomerRow[]> => {
      const supabase = createClient();
      return await fetchAllRowsIn<InvoiceCustomerRow, string>(ids, (run, from, to) =>
        supabase.from("invoices").select("id, customer_id, customer_name, external_number").in("id", run).order("id").range(from, to) as never,
      );
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
      return data as { refund_voucher_no: string; amount: number; opening_invoice?: boolean; invoice_number?: string | null; invoice_due_after?: number };
    },
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      qc.invalidateQueries({ queryKey: ["subscriptions"] });
      qc.invalidateQueries({ queryKey: queryKeys.customerCredits() });
      qc.invalidateQueries({ queryKey: queryKeys.aging() });
      qc.invalidateQueries({ queryKey: ["outstanding-receivables"] });
      // R-1567: the refund gives back credit this payment used and reverses its TDS receivable.
      qc.invalidateQueries({ queryKey: ["tds_receivable"] });
      // R-1563: a refund on an invoiced quote pays out credit-note credit and moves the invoice.
      qc.invalidateQueries({ queryKey: ["invoices"] });
      toast.success(`Refund booked — voucher ${r.refund_voucher_no}`, {
        /* R-1747: a refund on an imported Zoho invoice reopens that invoice — say by how much. */
        description: (r.opening_invoice && r.invoice_number
          ? `${r.invoice_number} has ${rupee(r.invoice_due_after ?? 0)} due again. `
          : "Booked in the accounts. ") + "Send the actual money yourself from Razorpay or the bank.",
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
      qc.invalidateQueries({ queryKey: queryKeys.purchaseOrders() });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      // R-1568: delete removes its open credit, gives back credit it used, reverses its TDS.
      qc.invalidateQueries({ queryKey: queryKeys.customerCredits() });
      qc.invalidateQueries({ queryKey: queryKeys.aging() });
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
/* R-1701 (Pardeep, 20 Oct): every number on a dues row is THAT subscription's, never the
   customer's. Before: Paid = every received payment of the customer (two rows of one customer
   both read "Paid ₹2,46,564"), Age = days since the customer's FIRST EVER payment ("166d" on a
   subscription started 10 days earlier — and Age > 30 offers "Write off"), quote = the
   customer's "latest" partial/invoiced quote (both rows opened the ₹8,424 quote, so money for
   the ₹14,406 row could be recorded on the wrong bill). Now, per subscription:
     quote  = its open renewal quote, else its own open quote (the same rule as R-1697's
              duesPaymentRoute) — null when neither is open; no per-customer guess.
     paid   = received payments on the row's quote (instalment and invoice payments carry the
              quote id too); refunded payments are status 'refunded' and not counted.
     age    = days (IST) since the oldest UNPAID invoice of the subscription fell due (its own
              quote's / renewal quote's invoice, or an instalment invoice), else since its
              agreed payment_due_date, else since it started — never negative. */
export interface OutstandingRow {
  subscription_id:    string;
  customer_id:        string | null;
  customer_name:      string;
  plan:               string;
  outstanding_amount: number;
  /** The amount of the row's quote (open renewal, else own quote); 0 when it has none. */
  total_quote_amount: number;
  /** Received on the row's quote — this subscription's money, not the customer's total. */
  paid_amount:        number;
  status:             "active" | "paused" | "expired" | "cancelled";
  /** When the subscription started (start_date, else created) — used in the reminder email. */
  started_at:         string;
  /** The date the age counts from (YYYY-MM-DD): oldest unpaid invoice due, else due date, else start. */
  age_from:           string;
  last_reminder_at:   string | null;
  /** Whole days since `age_from` in IST, never negative. */
  days_outstanding:   number;
  /** The subscription's OWN open quote (renewal first) — where Record payment records. */
  quote_id:           string | null;
  /** Postpaid credit clock; null when there is no agreed date. */
  payment_due_date:   string | null;
}

export interface DuesSubRow {
  id: string;
  customer_id: string | null;
  customer_name: string;
  plan: string;
  outstanding_amount: number;
  status: string;
  last_reminder_at: string | null;
  created_at: string;
  start_date: string | null;
  payment_due_date: string | null;
  quote_id: string | null;
  renewal_quote_id: string | null;
}
export interface DuesQuoteRow {
  id: string;
  amount: number | null;
  payment_status: string | null;
  /** R-1718: whether the quote is OWED (accepted / invoiced) or only an offer (sent). */
  status?: string | null;
  invoice_id?: string | null;
  superseded_by?: string | null;
}
export interface DuesPaymentRow { quote_id: string; amount: number }
export interface DuesInvoiceRow {
  id: string;
  quote_id: string | null;
  invoice_date: string | null;
  due_date: string | null;
  status: string;
  amount: number;
  net_payable: number | null;
  paid_amount: number | null;
}
export interface DuesBillingRow { subscription_id: string; invoice_id: string | null }

const DAY_MS = 86_400_000;
const ymd = (d: string) => d.slice(0, 10);
/** Whole days from `from` to `today` (both YYYY-MM-DD), never negative. */
export function daysSince(from: string, today: string): number {
  const n = Math.round((Date.parse(`${ymd(today)}T00:00:00Z`) - Date.parse(`${ymd(from)}T00:00:00Z`)) / DAY_MS);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** An issued invoice that still owes money (draft = not issued, void = cancelled). */
const invoiceOwes = (i: DuesInvoiceRow) =>
  (i.status === "pending" || i.status === "overdue") &&
  (i.paid_amount ?? 0) < (i.net_payable ?? i.amount);

/** Pure: the dues rows from the rows read. Exported for the R-1701 tests.
 *  R-1718: `openBalances` = quote_open_balance() per quote (credit notes and refunds counted);
 *  a quote missing from it falls back to amount − received, never to 0. */
export function buildDuesRows(
  subs: DuesSubRow[],
  quotes: DuesQuoteRow[],
  payments: DuesPaymentRow[],
  invoices: DuesInvoiceRow[],
  billings: DuesBillingRow[],
  today: string,
  openBalances?: ReadonlyMap<string, number>,
): OutstandingRow[] {
  const quoteById = new Map(quotes.map((q) => [q.id, q]));
  const paidByQuote = new Map<string, number>();
  for (const p of payments) paidByQuote.set(p.quote_id, (paidByQuote.get(p.quote_id) ?? 0) + (p.amount ?? 0));
  const invoicesByQuote = new Map<string, DuesInvoiceRow[]>();
  const invoiceById = new Map<string, DuesInvoiceRow>();
  for (const i of invoices) {
    invoiceById.set(i.id, i);
    if (i.quote_id) invoicesByQuote.set(i.quote_id, [...(invoicesByQuote.get(i.quote_id) ?? []), i]);
  }
  const instalmentInvoices = new Map<string, string[]>();
  for (const b of billings) {
    if (b.invoice_id) instalmentInvoices.set(b.subscription_id, [...(instalmentInvoices.get(b.subscription_id) ?? []), b.invoice_id]);
  }
  /* A quote the reader cannot see (deleted / other tenant) counts as no quote. */
  const openQuote = (id: string | null) => {
    const q = id ? quoteById.get(id) : undefined;
    return q && q.payment_status !== "received" ? q : undefined;
  };

  /* R-1718: a quote is OWED — part of the subscription's balance — when it was accepted (and
     not replaced) or invoiced, and still has money open. A renewal / extension quote that is
     only `sent` is an offer: R818's ₹1,175 extension offer took the Record payment button while
     the ₹1,180 Balance due was its own accepted quote. Same test record_payment uses for
     R-1703's "what the subscription's other quotes still owe". */
  const openOf = (q: DuesQuoteRow) =>
    openBalances?.get(q.id) ?? Math.max(0, (q.amount ?? 0) - (paidByQuote.get(q.id) ?? 0));
  const owedQuote = (id: string | null) => {
    const q = openQuote(id);
    if (!q || openOf(q) <= 0) return undefined;
    const committed = (q.status === "accepted" && !q.superseded_by) || !!q.invoice_id
      || q.payment_status === "invoiced" || q.payment_status === "partial";
    return committed ? q : undefined;
  };

  return subs.map((s): OutstandingRow => {
    /* Oldest bill first: the subscription's own quote while it still owes, then an owed renewal
       quote, then (nothing owed found) the R-1697 order — open renewal, else own open quote. */
    const actionQuote = owedQuote(s.quote_id) ?? owedQuote(s.renewal_quote_id)
      ?? openQuote(s.renewal_quote_id) ?? openQuote(s.quote_id);
    /* What Paid / "of" describe: the quote money is recorded on, else the subscription's own
       quote even when fully paid (R-1697 then blocks the button and says why). */
    const shownQuote = actionQuote ?? (s.quote_id ? quoteById.get(s.quote_id) : undefined);

    const ownInvoices = new Map<string, DuesInvoiceRow>();
    for (const qid of [s.quote_id, s.renewal_quote_id]) {
      for (const i of qid ? invoicesByQuote.get(qid) ?? [] : []) ownInvoices.set(i.id, i);
    }
    for (const id of instalmentInvoices.get(s.id) ?? []) {
      const i = invoiceById.get(id);
      if (i) ownInvoices.set(i.id, i);
    }
    /* An invoice with no due date fell due the day it was issued. */
    const unpaidDue = [...ownInvoices.values()]
      .filter(invoiceOwes)
      .map((i) => i.due_date ?? i.invoice_date)
      .filter((d): d is string => !!d)
      .map(ymd)
      .sort();
    const startedAt = s.start_date ?? s.created_at;
    const ageFrom = unpaidDue[0] ?? (s.payment_due_date ? ymd(s.payment_due_date) : ymd(startedAt));

    return {
      subscription_id:    s.id,
      customer_id:        s.customer_id,
      customer_name:      s.customer_name,
      plan:               s.plan,
      outstanding_amount: s.outstanding_amount,
      total_quote_amount: shownQuote?.amount ?? 0,
      paid_amount:        shownQuote ? paidByQuote.get(shownQuote.id) ?? 0 : 0,
      status:             s.status as OutstandingRow["status"],
      started_at:         startedAt,
      age_from:           ageFrom,
      last_reminder_at:   s.last_reminder_at,
      days_outstanding:   daysSince(ageFrom, today),
      quote_id:           actionQuote?.id ?? null,
      payment_due_date:   s.payment_due_date ?? null,
    };
  }).sort((a, b) => b.days_outstanding - a.days_outstanding);
}

type DuesClient = ReturnType<typeof createClient>;

/** Every read paged / chunked (R-264, R-1519): six batched reads, however many rows. */
export async function fetchOutstandingReceivables(supabase: DuesClient, today: string): Promise<OutstandingRow[]> {
  // 1. Subscriptions with a balance (written-off ones excluded) — the dues TOTAL rule, unchanged.
  const subs = await fetchAllRows<DuesSubRow>((from, to) =>
    supabase
      .from("subscriptions")
      /* payment_due_date added 10 Sep 2026 — the postpaid credit clock, so the
         Outstanding card can show the same countdown the subscriptions list does. */
      .select("id, customer_id, customer_name, plan, outstanding_amount, status, last_reminder_at, created_at, start_date, payment_due_date, quote_id, renewal_quote_id")
      .gt("outstanding_amount", 0)
      .is("written_off_at", null)
      .order("id")
      .range(from, to) as never,
  );
  if (subs.length === 0) return [];

  const quoteIds = [...new Set(subs.flatMap((s) => [s.quote_id, s.renewal_quote_id]).filter((q): q is string => !!q))];
  // 2. Those subscriptions' own quotes.
  const quotes = await fetchAllRowsIn<DuesQuoteRow, string>(quoteIds, (ids, from, to) =>
    supabase.from("quotes").select("id, amount, payment_status, status, invoice_id, superseded_by").in("id", ids).order("id").range(from, to) as never,
  );
  /* R-1718: what is really still open on each quote (quote_open_balance, R-1707's batched read).
     If it cannot be read the rows still build — buildDuesRows falls back to amount − received. */
  let openBalances: Map<string, number> | undefined;
  try {
    const rpc = supabase.rpc as unknown as (fn: "quote_open_balances") => {
      order: (c: "quote_id", o: { ascending: boolean }) => { range: (from: number, to: number) => PageQuery<QuoteOpenBalanceRow> };
    };
    const wanted = new Set(quoteIds);
    const rows = await fetchAllRows<QuoteOpenBalanceRow>((from, to) =>
      rpc.call(supabase, "quote_open_balances").order("quote_id", { ascending: true }).range(from, to),
    );
    openBalances = new Map(toOpenBalanceMap(rows.filter((r) => wanted.has(r.quote_id))));
  } catch (e) {
    console.warn("[dues] quote_open_balances unavailable — using amount − received:", e);
  }
  // 3. Money received on those quotes (refunded payments have status 'refunded').
  const payments = await fetchAllRowsIn<DuesPaymentRow, string>(quoteIds, (ids, from, to) =>
    supabase.from("payments").select("id, quote_id, amount").in("quote_id", ids).eq("status", "received").order("id").range(from, to) as never,
  );
  // 4. Instalment invoices of these subscriptions (subscription_billings).
  const billings = await fetchAllRowsIn<DuesBillingRow, string>(subs.map((s) => s.id), (ids, from, to) =>
    supabase.from("subscription_billings").select("id, subscription_id, invoice_id").in("subscription_id", ids).not("invoice_id", "is", null).order("id").range(from, to) as never,
  );
  // 5. Their open invoices: the quotes' own invoices, and the instalment invoices.
  const INVOICE_COLS = "id, quote_id, invoice_date, due_date, status, amount, net_payable, paid_amount";
  const byQuote = await fetchAllRowsIn<DuesInvoiceRow, string>(quoteIds, (ids, from, to) =>
    supabase.from("invoices").select(INVOICE_COLS).in("quote_id", ids).in("status", ["pending", "overdue"]).order("id").range(from, to) as never,
  );
  const byId = await fetchAllRowsIn<DuesInvoiceRow, string>(billings.map((b) => b.invoice_id), (ids, from, to) =>
    supabase.from("invoices").select(INVOICE_COLS).in("id", ids).in("status", ["pending", "overdue"]).order("id").range(from, to) as never,
  );

  return buildDuesRows(subs, quotes, payments, [...byQuote, ...byId], billings, today, openBalances);
}

export function useOutstandingReceivables() {
  return useQuery({
    queryKey: ["outstanding-receivables"],
    queryFn: async (): Promise<OutstandingRow[]> => fetchOutstandingReceivables(createClient(), todayIST()),
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
    onError: (e) => toastError(e, { fallback: "Could not mark the reminder — please try again" }),
  });
}

// ============================================================
// Suspend / Cancel / Write-off
// ============================================================
/* R-1681: pausing moved to useSuspendSubscription in
   components/features/subscriptions/suspend-subscription-dialog.tsx (suspend_subscription RPC —
   asks why, links the unpaid invoice). A bare status = 'paused' update kept no reason and never
   came back on payment. */

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
  /** R-1739: imported from Zoho Books (no quote) — record_multi_invoice_payment pays it directly. */
  document_kind?: string | null;
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
          .select("id, invoice_date, due_date, amount, net_payable, paid_amount, status, tax_rate, quote_id, document_kind")
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
      const quoteless = invoices.filter((i) => !i.quote_id && !isOpeningInvoice(i)).map((i) => i.id);
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
        /* R-1739: + invoices imported from Zoho Books (their payment carries the invoice). */
        .filter((i) => isOpeningInvoice(i) || (i.quote_id ? own.has(`${i.quote_id}|${i.id}`) : instalments.has(i.id)))
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
      for (const key of ["payments", "invoices", "quotes", "customers", "outstanding-receivables", "nav-badges", "tds_receivable", "subscriptions"]) {
        qc.invalidateQueries({ queryKey: [key] });
      }
      /* R-1589: was "customer-credits" — no query reads that key, so the excess-to-credit
         balance stayed old. Aging was not refreshed at all. */
      qc.invalidateQueries({ queryKey: queryKeys.customerCredits() });
      qc.invalidateQueries({ queryKey: queryKeys.aging() });
    },
  });
}

export type { Payment, PaymentMethod };
