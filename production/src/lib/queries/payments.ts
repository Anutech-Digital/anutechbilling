/**
 * Payments — dedicated table queries.
 *
 * Each row in `payments` is a single transaction (could be one of multiple installments
 * for the same quote). Partial / refund support built in.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { Payment, PaymentMethod } from "@/lib/supabase/database.types";

// ============================================================
// Read — all payments for a tenant (used by /payments dashboard)
// ============================================================
export function usePayments() {
  return useQuery({
    queryKey: ["payments"],
    queryFn: async (): Promise<Payment[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("payments")
        .select("*")
        .order("received_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Payment[];
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
        .select("*")
        .eq("quote_id", quoteId!)
        .order("received_at", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Payment[];
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
    onError: (err) => toast.error((err as Error).message),
  });
}

// ============================================================
// Refund a payment
// ============================================================
export function useRefundPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, reason }: { id: string; reason: string }) => {
      const supabase = createClient();
      const { error } = await supabase
        .from("payments")
        .update({
          status: "refunded",
          refunded_at: new Date().toISOString(),
          refund_reason: reason || null,
        })
        .eq("id", id);
      if (error) throw error;
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["quotes"] });
      toast.success("Payment marked as refunded");
    },
    onError: (err) => toast.error((err as Error).message),
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
      toast.success("Payment deleted & reversed");
    },
    // When the caller wants to surface blockers in a dialog (dependency-aware
    // delete), route the RPC's block message there instead of a toast.
    onError: (err) => {
      const msg = (err as Error).message;
      if (opts?.onBlocked) opts.onBlocked(msg);
      else toast.error(msg);
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
}

export function useOutstandingReceivables() {
  return useQuery({
    queryKey: ["outstanding-receivables"],
    queryFn: async (): Promise<OutstandingRow[]> => {
      const supabase = createClient();
      // 1. Fetch subscriptions with outstanding balance (excluding written-off/cancelled)
      const { data: subs, error } = await supabase
        .from("subscriptions")
        .select("id, customer_id, customer_name, plan, outstanding_amount, status, last_reminder_at, created_at, written_off_at")
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
    onError: (e) => toast.error((e as Error).message || "Reminder mark nahi hua — dobara try karo"),
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
    onError: (e) => toast.error((e as Error).message || "Pause nahi hua — subscription abhi bhi active hai"),
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
    onError: (e) => toast.error((e as Error).message),
  });
}

export type { Payment, PaymentMethod };
