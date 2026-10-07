/**
 * R-346 — reads and the one write behind "Activate now, pay later". Rules live in
 * activate-on-credit.ts; these only fetch. Each read survives the migration not being applied
 * yet: a missing column comes back as `null` ("not available") instead of breaking the screen.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  creditSummary, isMissingDbObject, NeedsDatabaseUpdateError,
  type CreditInvoiceFacts, type CreditSummary, type OpenInvoice,
} from "./activate-on-credit";
import {
  interestDebitNoteGross, interestDebitNoteNote,
  type DatedPayment, type InterestNoteRow,
} from "./late-interest";
import { toIstDate } from "@/lib/dates/ist";

/** Unpaid invoices of one customer — the "already owed" half of the limit check. */
export function useCustomerOpenInvoices(customerId: string | null | undefined, enabled = true) {
  return useQuery({
    queryKey: ["invoices", "customer-open", customerId],
    enabled: Boolean(customerId) && enabled,
    queryFn: async (): Promise<OpenInvoice[]> => {
      const { data, error } = await createClient()
        .from("invoices")
        .select("id, status, amount, net_payable, paid_amount")
        .eq("customer_id", customerId!)
        .in("status", ["pending", "overdue"]);
      if (error) throw error;
      return (data ?? []) as OpenInvoice[];
    },
  });
}

/** The invoice a credit quote raised — for "Active on credit · ₹X due <date>". */
export function useCreditInvoice(invoiceId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["invoices", "credit", invoiceId],
    enabled: Boolean(invoiceId) && enabled,
    queryFn: async (): Promise<CreditInvoiceFacts | null> => {
      const { data, error } = await createClient()
        .from("invoices")
        .select("id, status, amount, net_payable, paid_amount, due_date")
        .eq("id", invoiceId!)
        .maybeSingle();
      if (error) throw error;
      return (data as CreditInvoiceFacts | null) ?? null;
    },
  });
}

/**
 * Receivables strip: subscriptions running on credit whose invoice is still unpaid.
 * null = the database has no credit columns yet (strip hidden, nothing breaks).
 */
export function useCreditSummary() {
  return useQuery({
    queryKey: ["credit", "summary"],
    queryFn: async (): Promise<CreditSummary | null> => {
      const supabase = createClient();
      const { data: quotes, error } = await supabase
        .from("quotes")
        .select("id, invoice_id")
        .not("credit_activated_at", "is", null)
        .limit(1000);
      if (error) {
        if (isMissingDbObject(error)) return null;
        throw error;
      }
      const qs = (quotes ?? []) as { id: string; invoice_id: string | null }[];
      if (qs.length === 0) return { subscriptions: 0, amountDue: 0 };
      const invoiceIds = qs.map((q) => q.invoice_id).filter((x): x is string => Boolean(x));
      const [inv, subs] = await Promise.all([
        invoiceIds.length
          ? supabase.from("invoices").select("id, status, amount, net_payable, paid_amount").in("id", invoiceIds)
          : Promise.resolve({ data: [], error: null }),
        supabase.from("subscriptions").select("quote_id, status").in("quote_id", qs.map((q) => q.id)),
      ]);
      if (inv.error) throw inv.error;
      if (subs.error) throw subs.error;
      return creditSummary(qs, (inv.data ?? []) as OpenInvoice[], (subs.data ?? []) as { quote_id: string | null; status: string }[]);
    },
  });
}

/** Owner-only in the database (trigger); the card shows the controls only to the owner. */
export function useUpdateCustomerCredit() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { customerId: string; allowPayLater: boolean; creditLimit: number | null }) => {
      const { data, error } = await createClient()
        .from("customers")
        .update({ allow_pay_later: input.allowPayLater, credit_limit: input.creditLimit } as never)
        .eq("id", input.customerId)
        .select("id");
      if (error) {
        if (isMissingDbObject(error)) throw new NeedsDatabaseUpdateError();
        throw new Error(error.message);
      }
      if (!data || data.length === 0) throw new Error("The customer was not updated — reopen the page and try again.");
    },
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: ["customers", v.customerId] });
      void qc.invalidateQueries({ queryKey: ["customers"] });
    },
  });
}

// ── R-368: late-payment interest ─────────────────────────────────────────────

export interface LateInterestFacts {
  invoice: { id: string; amount: number; net_payable: number | null; tax_rate: number | null; due_date: string | null };
  payments: DatedPayment[];
  notes: InterestNoteRow[];
}

/**
 * Everything the interest figure needs for one credit quote: its invoice, the dated payments
 * received against the quote (refunded ones excluded) and the invoice's debit notes.
 */
export function useLateInterestFacts(quoteId: string | null | undefined, invoiceId: string | null | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ["credit", "late-interest", quoteId, invoiceId],
    enabled: Boolean(quoteId) && Boolean(invoiceId) && enabled,
    queryFn: async (): Promise<LateInterestFacts | null> => {
      const supabase = createClient();
      const [inv, pays, notes] = await Promise.all([
        supabase.from("invoices").select("id, amount, net_payable, tax_rate, due_date").eq("id", invoiceId!).maybeSingle(),
        supabase.from("payments").select("amount, received_at").eq("quote_id", quoteId!).eq("status", "received"),
        supabase.from("debit_notes").select("amount, taxable_value, notes").eq("invoice_id", invoiceId!),
      ]);
      if (inv.error) throw inv.error;
      if (pays.error) throw pays.error;
      if (notes.error) throw notes.error;
      if (!inv.data) return null;
      return {
        invoice: inv.data as LateInterestFacts["invoice"],
        payments: ((pays.data ?? []) as { amount: number; received_at: string }[])
          .map((p) => ({ amount: p.amount, date: toIstDate(p.received_at) })),
        notes: (notes.data ?? []) as InterestNoteRow[],
      };
    },
  });
}

/**
 * Charge the interest: a debit note on the late invoice (issue_debit_note), gross = interest +
 * GST at the invoice's rate. Only ever from an owner/billing click — never automatic.
 */
export function useAddLateInterest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { invoiceId: string; interest: number; taxRate: number | null; dueDate: string; asOf: string }) => {
      if (!Number.isInteger(input.interest) || input.interest <= 0) throw new Error("There is no interest to add.");
      const { data, error } = await createClient().rpc("issue_debit_note", {
        p_invoice_id: input.invoiceId,
        p_gross_amount: interestDebitNoteGross(input.interest, input.taxRate),
        p_reason_code: "additional_charge",
        p_reason: "Late payment interest",
        p_notes: interestDebitNoteNote({ dueDate: input.dueDate, asOf: input.asOf, interest: input.interest }),
      });
      if (error) throw new Error(error.message);
      return data as { debit_note_id: string; new_net_payable: number };
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ["credit"] });
      void qc.invalidateQueries({ queryKey: ["invoices"] });
      void qc.invalidateQueries({ queryKey: ["debit-notes"] });
      void qc.invalidateQueries({ queryKey: ["aging"] });
    },
  });
}
