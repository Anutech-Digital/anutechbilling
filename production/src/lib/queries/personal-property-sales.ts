/**
 * R-2393 — Private Vault: property sale deals (tables personal_property_sales /
 * personal_property_sale_receipts, RPCs personal_property_sale_add_receipt / _delete_receipt /
 * _register / _cancel — migration 20261103073146_r2393_personal_property_sales.sql).
 *
 * Same owner-only RLS as every vault table; every insert stamps owner/tenant from the session
 * (requireIdentity), never a prop. Money moves (receipt + its ledger row / owe-hold settle,
 * registry, cancel) are ONE RPC call each (§17b).
 *
 * Its own module so a screen test can mock it in one line. The tables are newer than the
 * generated DB types, so the row shapes are written here and the client is used untyped.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { requireIdentity, invalidateAll } from "@/lib/queries/personal-vault";
import type { ReceiptKind, ReceiptMode, SaleStatus } from "@/lib/vault/personal/property-sale";

export interface PersonalPropertySale {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  holding_id: string;
  /** Whose property it is when not the owner (People contact). Null = the owner. */
  seller_contact_id: string | null;
  /** Buyer (People contact); party keeps the name. */
  contact_id: string | null;
  party: string;
  agreement_date: string;
  agreed_price: number;
  stamp_value: number | null;
  acquired_on: string | null;
  cost_of_acquisition: number;
  improvement_cost: number;
  transfer_expenses: number;
  status: SaleStatus;
  registry_date: string | null;
  tds_deducted: number;
  cancelled_on: string | null;
  refunded: number;
  forfeited: number;
  note: string | null;
  created_at: string;
  updated_at: string;
}

export interface PersonalPropertySaleReceipt {
  id: string;
  sale_id: string;
  kind: ReceiptKind;
  received_on: string;
  amount: number;
  mode: ReceiptMode;
  account_id: string | null;
  owe_hold_id: string | null;
  tx_id: string | null;
  note: string | null;
  created_at: string;
}

export type PersonalPropertySaleInput = Pick<
  PersonalPropertySale,
  | "holding_id" | "seller_contact_id" | "contact_id" | "party" | "agreement_date" | "agreed_price"
  | "stamp_value" | "acquired_on" | "cost_of_acquisition" | "improvement_cost" | "transfer_expenses" | "note"
> & { id?: string };

const SALES = "personal_property_sales";
const RECEIPTS = "personal_property_sale_receipts";
const db = () => createClient() as unknown as SupabaseClient;

export function usePersonalPropertySales() {
  return useQuery({
    queryKey: ["personal-vault", "property-sales"],
    queryFn: async (): Promise<{ sales: PersonalPropertySale[]; receipts: PersonalPropertySaleReceipt[] }> => {
      const [s, r] = await Promise.all([
        db().from(SALES).select("*").order("agreement_date", { ascending: false }),
        db().from(RECEIPTS).select("*").order("received_on").order("created_at"),
      ]);
      if (s.error) throw s.error;
      if (r.error) throw r.error;
      return {
        sales: (s.data ?? []) as PersonalPropertySale[],
        receipts: (r.data ?? []) as PersonalPropertySaleReceipt[],
      };
    },
    staleTime: 30_000,
  });
}

export function useSavePersonalPropertySale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PersonalPropertySaleInput) => {
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;
      if (id) {
        const { error } = await db().from(SALES).update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        return id;
      }
      const { data, error } = await db()
        .from(SALES)
        .insert({ ...fields, tenant_id: tenantId, owner_user_id: userId })
        .select("id")
        .single();
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the sale." }),
  });
}

export function useDeletePersonalPropertySale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from(SALES).delete().eq("id", id).eq("status", "agreement");
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the sale." }),
  });
}

export interface AddReceiptInput {
  sale_id: string;
  kind: ReceiptKind;
  received_on: string | null;
  amount: number | null;
  mode: ReceiptMode;
  account_id: string | null;
  /** Move this open R-2386 advance into the sale (its amount, date and account). */
  owe_hold_id: string | null;
  note: string | null;
}

export function useAddPropertySaleReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (i: AddReceiptInput) => {
      await requireIdentity();
      const { data, error } = await db().rpc("personal_property_sale_add_receipt", {
        p_sale_id: i.sale_id, p_kind: i.kind, p_received_on: i.received_on, p_amount: i.amount,
        p_mode: i.mode, p_account_id: i.account_id, p_owe_hold_id: i.owe_hold_id, p_note: i.note,
      });
      if (error) throw error;
      return data as { receipt_id: string; received_total: number; cash_warning: boolean };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not add the payment." }),
  });
}

export function useDeletePropertySaleReceipt() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().rpc("personal_property_sale_delete_receipt", { p_receipt_id: id });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the payment." }),
  });
}

export interface RegisterSaleInput {
  sale_id: string;
  registry_date: string;
  tds_deducted: number;
  final_amount: number | null;
  final_mode: ReceiptMode;
  final_account_id: string | null;
  note: string | null;
}

export function useRegisterPropertySale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (i: RegisterSaleInput) => {
      await requireIdentity();
      const { data, error } = await db().rpc("personal_property_sale_register", {
        p_sale_id: i.sale_id, p_registry_date: i.registry_date, p_tds_deducted: i.tds_deducted,
        p_final_amount: i.final_amount, p_final_mode: i.final_mode, p_final_account_id: i.final_account_id,
        p_note: i.note,
      });
      if (error) throw error;
      return data as { balance_due: number; received_total: number };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not record the registry." }),
  });
}

export interface CancelSaleInput {
  sale_id: string;
  cancelled_on: string;
  refund: number;
  refund_account_id: string | null;
  note: string | null;
}

export function useCancelPropertySale() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (i: CancelSaleInput) => {
      await requireIdentity();
      const { data, error } = await db().rpc("personal_property_sale_cancel", {
        p_sale_id: i.sale_id, p_cancelled_on: i.cancelled_on, p_refund: i.refund,
        p_refund_account_id: i.refund_account_id, p_note: i.note,
      });
      if (error) throw error;
      return data as { refunded: number; forfeited: number };
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not cancel the sale." }),
  });
}
