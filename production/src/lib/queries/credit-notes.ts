/**
 * Credit notes (CGST §34) — reduce a previously-issued invoice.
 * Issuing goes through the atomic `issue_credit_note` RPC (allocates the CN
 * number, freezes the GST split from the invoice, lowers the invoice's net owed).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/queries/keys";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { rupee } from "@/lib/utils";
import type { CreditNoteRow, CreditNoteReasonCode } from "@/lib/supabase/database.types";

export function useCreditNotesByInvoice(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["credit-notes", "by-invoice", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<CreditNoteRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("credit_notes")
        .select("*")
        .eq("invoice_id", invoiceId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CreditNoteRow[];
    },
  });
}

export interface IssueCreditNoteInput {
  invoiceId:  string;
  grossAmount: number;                 // ₹ incl tax
  reasonCode: CreditNoteReasonCode;
  reason?:    string | null;
  notes?:     string | null;
}

export function useIssueCreditNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: IssueCreditNoteInput) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("issue_credit_note", {
        p_invoice_id:   input.invoiceId,
        p_gross_amount: input.grossAmount,
        p_reason_code:  input.reasonCode,
        p_reason:       input.reason ?? null,
        p_notes:        input.notes ?? null,
      });
      if (error) throw error;
      return data as { credit_note_id: string; new_net_payable: number; customer_credit?: number; invoice_paid?: boolean };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["credit-notes"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: queryKeys.aging() });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      /* R-1566: on an invoice already paid, the note's excess is now the customer's credit. */
      qc.invalidateQueries({ queryKey: queryKeys.customerCredits() });
      qc.invalidateQueries({ queryKey: ["payments"] });
      const credit = res.customer_credit ?? 0;
      toast.success(`Credit note ${res.credit_note_id} issued`, credit > 0 ? {
        description: `${rupee(credit)} was already paid on this invoice — it is now the customer's credit: use it on their next quote, or refund it from Payments (Refund on that payment).`,
      } : undefined);
    },
    onError: (e) => toastError(e),
  });
}
