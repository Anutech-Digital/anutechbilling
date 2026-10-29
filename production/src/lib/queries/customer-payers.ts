/**
 * R-2025 — a customer's KNOWN payers (customer_payers, migration 20261027120512) and the payer
 * answer on a money-in bank line. Every write is one server call:
 *   set_bank_line_payer   — the Reconcile sheet's answer, sent just before Save; the save's own
 *                           transaction then writes it on the receipt and learns it (trigger).
 *   save_customer_payer / delete_customer_payer — the customer page (owner / accountant).
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { KnownPayer, NarrationPayer, PayerRelation } from "@/lib/banking/customer-payer";
import type { PayerMemory } from "@/lib/banking/credit-pay-for";

/* The generated types do not know the R-2025 table / functions yet. */
type Loose = {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
  from: (t: string) => {
    select: (cols: string) => {
      order: (c: string, o?: { ascending?: boolean }) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
      eq: (c: string, v: string) => {
        not: (c: string, op: string, v: null) => {
          order: (c: string, o?: { ascending?: boolean }) => PromiseLike<{ data: unknown; error: { message: string } | null }>;
        };
      };
    };
  };
};
const db = () => createClient() as unknown as Loose;

export const CUSTOMER_PAYERS_KEY = ["customer_payers"] as const;

/** Every known payer of the company (small: a few per customer). */
export function useCustomerPayers(enabled = true) {
  return useQuery({
    queryKey: CUSTOMER_PAYERS_KEY,
    enabled,
    queryFn: async (): Promise<KnownPayer[]> => {
      const { data, error } = await db().from("customer_payers")
        .select("id, customer_id, payer_name, payer_name_key, relation, note, ifsc, upi_id, account_tail, uses, first_seen_txn, created_at")
        .order("payer_name", { ascending: true });
      if (error) throw error;
      return ((data ?? []) as KnownPayer[]).map((r) => ({ ...r, uses: Number(r.uses) || 0 }));
    },
    staleTime: 30_000,
  });
}

/** The payer memory the customer guess reads: known payers + our own name(s) (never a payer). */
export function usePayerMemory(): PayerMemory {
  const { data: payers } = useCustomerPayers();
  const { data: me } = useCurrentUser();
  const a = me?.tenantName, b = me?.tenantUpiPayeeName;
  return React.useMemo(() => ({
    payers: payers ?? [],
    ownNames: [a, b].filter((n): n is string => Boolean(n && n.trim() && n !== "Workspace")),
  }), [payers, a, b]);
}

export interface LinePayerAnswer {
  transactionId: string;
  customerId: string;
  payer: NarrationPayer;
  relation: PayerRelation;
  note: string | null;
}

/** The sheet's answer on the line (sent right before Save). */
export function useSetBankLinePayer() {
  return useMutation({
    mutationFn: async (a: LinePayerAnswer) => {
      const { error } = await db().rpc("set_bank_line_payer", {
        p_txn_id: a.transactionId, p_customer_id: a.customerId, p_payer_name: a.payer.name, p_relation: a.relation,
        p_note: a.note, p_ifsc: a.payer.ifsc, p_upi: a.payer.upi, p_account_tail: a.payer.accountTail,
      });
      if (error) throw error;
    },
    onError: (e) => toastError(e),
  });
}

export interface KnownPayerInput {
  id: string | null;
  customerId: string;
  payerName: string;
  relation: PayerRelation;
  note: string | null;
  ifsc: string | null;
  upi: string | null;
  accountTail: string | null;
}

export function useSaveCustomerPayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (i: KnownPayerInput) => {
      const { data, error } = await db().rpc("save_customer_payer", {
        p_id: i.id, p_customer_id: i.customerId, p_payer_name: i.payerName, p_relation: i.relation,
        p_note: i.note, p_ifsc: i.ifsc, p_upi: i.upi, p_account_tail: i.accountTail,
      });
      if (error) throw error;
      return data as string;
    },
    onSuccess: (_d, i) => {
      toast.success(i.id ? "Known payer saved" : "Known payer added");
      qc.invalidateQueries({ queryKey: CUSTOMER_PAYERS_KEY });
    },
    onError: (e) => toastError(e),
  });
}

export function useDeleteCustomerPayer() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().rpc("delete_customer_payer", { p_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success("Known payer removed");
      qc.invalidateQueries({ queryKey: CUSTOMER_PAYERS_KEY });
    },
    onError: (e) => toastError(e),
  });
}

/** A bank line this customer's payers paid on (the answer stored on the line). */
export interface PayerLine { id: string; bank_account_id: string; txn_date: string; credit: number; payer_key: string | null }

/** "Seen on which lines": the reconciled money-in lines answered for this customer. */
export function useCustomerPayerLines(customerId: string | null) {
  return useQuery({
    queryKey: ["customer_payer_lines", customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<PayerLine[]> => {
      const { data, error } = await db().from("bank_transactions")
        .select("id, bank_account_id, txn_date, credit, payer")
        .eq("payer->>customer_id", customerId as string)
        .not("matched_to_type", "is", null)
        .order("txn_date", { ascending: false });
      if (error) throw error;
      return ((data ?? []) as Array<{ id: string; bank_account_id: string; txn_date: string; credit: number; payer: { key?: string } | null }>)
        .map((r) => ({ id: r.id, bank_account_id: r.bank_account_id, txn_date: r.txn_date, credit: Number(r.credit) || 0, payer_key: r.payer?.key ?? null }));
    },
    staleTime: 30_000,
  });
}

/** R-2025 (3): who paid this receipt, when not the customer — read on its own so a database
 *  without the payer columns yet simply shows no line (never breaks the receipt). */
export function usePaymentPayer(paymentId: string | null | undefined) {
  return useQuery({
    queryKey: ["payment_payer", paymentId],
    enabled: Boolean(paymentId),
    retry: false,
    queryFn: async (): Promise<{ payer_name: string | null; payer_relation: string | null } | null> => {
      const q = (createClient() as unknown as {
        from: (t: string) => { select: (c: string) => { eq: (c: string, v: string) => { maybeSingle: () => PromiseLike<{ data: unknown; error: unknown }> } } };
      }).from("payments").select("payer_name, payer_relation").eq("id", paymentId as string);
      const { data, error } = await q.maybeSingle();
      if (error) return null;
      return (data as { payer_name: string | null; payer_relation: string | null } | null) ?? null;
    },
    staleTime: 60_000,
  });
}
