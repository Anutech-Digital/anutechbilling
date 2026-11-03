/**
 * R-2416 — read / save the online payment fee policy: the company setting (tenants), the
 * customer's "We absorb" (customers) and a bill's waiver (quotes / invoices).
 *
 * Untyped client: the online_fee_* columns are newer than the generated types. Before the
 * migration a missing column reads as "not ready" and the cards say it needs a database update.
 * Who may save is enforced by the database (tenants: owner via RLS; customers: owner / manager /
 * accountant and bills: owner / manager via online_fee_exception_guard) — the cards only mirror it.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import {
  BILL_ONLINE_FEE_COLUMNS,
  CUSTOMER_ONLINE_FEE_COLUMNS,
  DEFAULT_ONLINE_FEE_SETTINGS,
  TENANT_ONLINE_FEE_COLUMNS,
  isOnlineFeeColumnMissing,
  parseOnlineFeeCustomer,
  parseOnlineFeeSettings,
  type OnlineFeeCustomer,
  type OnlineFeeSettings,
} from "@/lib/payments/online-fee";

const untyped = () => createClient() as unknown as SupabaseClient;
const KEY = "online_fee";

export const ONLINE_FEE_NEEDS_DB = "Needs a database update before it can be saved.";
/** Same minimum as the database CHECK constraints. */
export const ONLINE_FEE_REASON_MIN = 3;

export type OnlineFeeBillKind = "quote" | "invoice";

export function useOnlineFeeSettings() {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: [KEY, "settings", tenantId],
    enabled: Boolean(tenantId),
    staleTime: 60_000,
    queryFn: async (): Promise<{ settings: OnlineFeeSettings; ready: boolean }> => {
      const { data, error } = await untyped().from("tenants").select(TENANT_ONLINE_FEE_COLUMNS)
        .eq("id", tenantId as string).maybeSingle();
      if (isOnlineFeeColumnMissing(error)) return { settings: { ...DEFAULT_ONLINE_FEE_SETTINGS }, ready: false };
      if (error) throw new Error(error.message);
      return { settings: parseOnlineFeeSettings(data as Record<string, unknown> | null), ready: true };
    },
  });
}

export function useSaveOnlineFeeSettings() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useMutation({
    mutationFn: async (s: OnlineFeeSettings) => {
      if (!tenantId) throw new Error("Not signed in to a workspace — sign in again.");
      const { data, error } = await untyped().from("tenants").update({
        online_fee_bearer: s.bearer,
        online_fee_rate_pct: s.ratePct,
        online_fee_waive_above: s.waiveAbove,
        online_fee_line_text: s.lineText,
      }).eq("id", tenantId).select("id");
      if (isOnlineFeeColumnMissing(error)) throw new Error(`Online payment fee is not switched on yet. ${ONLINE_FEE_NEEDS_DB}`);
      if (error) throw error;
      // RLS lets only the owner update the tenant row; anyone else gets zero rows, not an error.
      if (!data || data.length === 0) throw new Error("Only the workspace owner can change the online payment fee — ask the owner.");
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      toast.success("Online payment fee saved");
    },
    onError: (err) => toastError(err, { fallback: "Could not save the online payment fee." }),
  });
}

export function useCustomerOnlineFee(customerId: string) {
  return useQuery({
    queryKey: [KEY, "customer", customerId],
    enabled: Boolean(customerId),
    queryFn: async (): Promise<{ ready: boolean } & OnlineFeeCustomer> => {
      const { data, error } = await untyped().from("customers").select(CUSTOMER_ONLINE_FEE_COLUMNS)
        .eq("id", customerId).maybeSingle();
      if (isOnlineFeeColumnMissing(error)) return { ready: false, override: null, reason: null };
      if (error) throw new Error(error.message);
      return { ready: true, ...parseOnlineFeeCustomer(data as Record<string, unknown> | null) };
    },
  });
}

export function useSaveCustomerOnlineFee(customerId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: OnlineFeeCustomer) => {
      const { data, error } = await untyped().from("customers").update({
        online_fee_override: v.override,
        online_fee_override_reason: v.override ? (v.reason ?? "").trim() : null,
      }).eq("id", customerId).select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error("This customer could not be changed — your role may not allow it. Ask an owner, manager or accountant.");
    },
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      toast.success(v.override ? "Saved — we absorb the online fee for this customer" : "Saved — online fee follows the company setting");
    },
    onError: (err) => toastError(err, { fallback: "Could not save who pays the online fee." }),
  });
}

export function useBillOnlineFee(kind: OnlineFeeBillKind, id: string | null | undefined) {
  return useQuery({
    queryKey: [KEY, kind, id],
    enabled: Boolean(id),
    queryFn: async (): Promise<{ ready: boolean; waived: boolean; reason: string | null }> => {
      const { data, error } = await untyped().from(kind === "quote" ? "quotes" : "invoices")
        .select(BILL_ONLINE_FEE_COLUMNS).eq("id", id as string).maybeSingle();
      if (isOnlineFeeColumnMissing(error)) return { ready: false, waived: false, reason: null };
      if (error) throw new Error(error.message);
      const row = (data ?? {}) as { online_fee_waived?: boolean | null; online_fee_waive_reason?: string | null };
      return { ready: true, waived: row.online_fee_waived === true, reason: row.online_fee_waive_reason ?? null };
    },
  });
}

export function useSaveBillOnlineFee(kind: OnlineFeeBillKind, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: { waived: boolean; reason: string | null }) => {
      const { data, error } = await untyped().from(kind === "quote" ? "quotes" : "invoices").update({
        online_fee_waived: v.waived,
        online_fee_waive_reason: v.waived ? (v.reason ?? "").trim() : null,
      }).eq("id", id).select("id");
      if (error) throw error;
      if (!data || data.length === 0) throw new Error(`This ${kind} could not be changed — only an owner or manager can waive the online fee.`);
    },
    onSuccess: (_d, v) => {
      void qc.invalidateQueries({ queryKey: [KEY] });
      toast.success(v.waived ? "Online fee waived for this bill" : "Online fee back to the usual rule");
    },
    onError: (err) => toastError(err, { fallback: "Could not save the online fee waiver." }),
  });
}

/** The customer half for a bill's card (customer id may be null → Default). */
export function useCustomerOnlineFeeMaybe(customerId: string | null | undefined) {
  return useCustomerOnlineFee(customerId ?? "");
}
