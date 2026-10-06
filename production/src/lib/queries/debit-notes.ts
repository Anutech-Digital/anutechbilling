/**
 * Debit notes (CGST §34) — the mirror of a credit note; they RAISE an invoice
 * (undercharge correction / additional charge). Issuing goes through the atomic
 * `issue_debit_note` RPC (allocates the DN number, freezes the GST split from
 * the invoice, raises the invoice's net owed).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { DebitNoteRow, DebitNoteReasonCode } from "@/lib/supabase/database.types";

export function useDebitNotesByInvoice(invoiceId: string | null | undefined) {
  return useQuery({
    queryKey: ["debit-notes", "by-invoice", invoiceId],
    enabled: !!invoiceId,
    queryFn: async (): Promise<DebitNoteRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("debit_notes")
        .select("*")
        .eq("invoice_id", invoiceId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DebitNoteRow[];
    },
  });
}

export interface IssueDebitNoteInput {
  invoiceId:   string;
  grossAmount: number;                 // ₹ incl tax
  reasonCode:  DebitNoteReasonCode;
  reason?:     string | null;
  notes?:      string | null;
}

export function useIssueDebitNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: IssueDebitNoteInput) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("issue_debit_note", {
        p_invoice_id:   input.invoiceId,
        p_gross_amount: input.grossAmount,
        p_reason_code:  input.reasonCode,
        p_reason:       input.reason ?? null,
        p_notes:        input.notes ?? null,
      });
      if (error) throw error;
      return data as { debit_note_id: string; new_net_payable: number };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["debit-notes"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["aging"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(`Debit note ${res.debit_note_id} issued`);
    },
    onError: (e) => toastError(e),
  });
}
