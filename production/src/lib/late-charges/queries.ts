/**
 * R-530 — browser hooks for late payment charges. Every write goes through a SECURITY DEFINER
 * RPC (20261009233000_late_payment_charges.sql) that checks the role and writes the audit row;
 * the tables themselves are read-only to the app.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { istToday, toIstDate } from "@/lib/dates/ist";
import { loadLateCharges, loadLateFeeLevel, TENANT_LATE_FEE_COLUMNS, type LateChargeRow } from "./load";
import { lateFeeSettingsFromRow, type LateFeeLevel, type LateFeeMode, type TenantLateFeeRow } from "./rules";

export const LATE_CHARGES_KEY = ["late-charges"] as const;

const untyped = (): SupabaseClient => createClient() as unknown as SupabaseClient;

export function useLateFeeSettings(tenantId: string | undefined) {
  return useQuery({
    queryKey: [...LATE_CHARGES_KEY, "settings", tenantId],
    enabled: Boolean(tenantId),
    queryFn: async () => {
      const { data, error } = await untyped().from("tenants").select(TENANT_LATE_FEE_COLUMNS).eq("id", tenantId!).maybeSingle();
      if (error) throw error;
      return lateFeeSettingsFromRow(data as TenantLateFeeRow | null, toIstDate);
    },
  });
}

export function useLateFeeLevel(tenantId: string | undefined, level: Exclude<LateFeeLevel, "company">, id: string | null | undefined) {
  return useQuery({
    queryKey: [...LATE_CHARGES_KEY, "level", level, id],
    enabled: Boolean(tenantId) && Boolean(id),
    queryFn: () => loadLateFeeLevel(untyped(), tenantId!, level, id!),
  });
}

export function useLateCharges(scope: { invoiceId?: string; customerId?: string; subscriptionId?: string } | null) {
  return useQuery({
    queryKey: [...LATE_CHARGES_KEY, "charges", scope?.invoiceId ?? null, scope?.customerId ?? null, scope?.subscriptionId ?? null],
    enabled: Boolean(scope && (scope.invoiceId || scope.customerId || scope.subscriptionId)),
    queryFn: (): Promise<LateChargeRow[]> => loadLateCharges(untyped(), {
      invoiceIds: scope?.invoiceId ? [scope.invoiceId] : undefined,
      customerId: scope?.customerId,
      subscriptionId: scope?.subscriptionId,
    }, istToday()),
  });
}

/** Every chargeable invoice in the company (for the monthly bulk bill on Aging). */
export function useAllLateCharges(enabled: boolean) {
  return useQuery({
    queryKey: [...LATE_CHARGES_KEY, "charges", "all"],
    enabled,
    queryFn: (): Promise<LateChargeRow[]> => loadLateCharges(untyped(), {}, istToday()),
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: LATE_CHARGES_KEY });
    void qc.invalidateQueries({ queryKey: ["invoices"] });
    void qc.invalidateQueries({ queryKey: ["debit-notes"] });
    void qc.invalidateQueries({ queryKey: ["aging"] });
    void qc.invalidateQueries({ queryKey: ["credit"] });
  };
}

export function useSaveLateFeeSettings() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (s: { enabled: boolean; interestPct: number; flatFee: number; graceDays: number; interestRegisteredOnly: boolean }) => {
      const { error } = await untyped().rpc("set_late_fee_settings", {
        p_enabled: s.enabled, p_interest_pct: s.interestPct, p_flat_fee: s.flatFee,
        p_grace_days: s.graceDays, p_registered_only: s.interestRegisteredOnly,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: done,
  });
}

export function useSetLateFeeMode() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (v: { level: Exclude<LateFeeLevel, "company">; id: string; mode: LateFeeMode }) => {
      const { error } = await untyped().rpc("set_late_fee_mode", { p_entity_type: v.level, p_entity_id: v.id, p_mode: v.mode });
      if (error) throw new Error(error.message);
    },
    onSuccess: done,
  });
}

export function useWaiveLateCharges() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (v: { invoiceId: string; reason: string }) => {
      const { error } = await untyped().rpc("waive_late_charges", { p_invoice_id: v.invoiceId, p_reason: v.reason });
      if (error) throw new Error(error.message);
    },
    onSuccess: done,
  });
}

export interface BillResult { debit_note_id: string; invoice_id: string; gross: number; taxable: number; tax_rate: number }

/** Bill what one row shows as unbilled. Refuses (before calling) when the invoice has no GST rate. */
export async function billLateChargeRow(row: LateChargeRow): Promise<BillResult> {
  const v = row.view;
  if (!v.applies || v.toBill <= 0) throw new Error(`Nothing to bill on ${row.invoiceId}.`);
  if (v.taxRate === null) {
    throw new Error(`Invoice ${row.invoiceId} has no GST rate stored, so the charges cannot be taxed. Ask your accountant which rate applies.`);
  }
  const { data, error } = await untyped().rpc("bill_late_charges", {
    p_invoice_id: row.invoiceId,
    p_fee: v.feeToBill,
    p_interest: v.interestToBill,
    p_interest_from: v.interestFrom,
    p_interest_to: v.interestTo,
  });
  if (error) throw new Error(error.message);
  return data as BillResult;
}

export function useBillLateCharges() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: billLateChargeRow,
    onSuccess: done,
  });
}

/** The monthly bulk run: bill each row in turn; one failure does not stop the others. */
export function useBillLateChargesBulk() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: async (rows: LateChargeRow[]) => {
      const ok: BillResult[] = [];
      const failed: { invoiceId: string; message: string }[] = [];
      for (const r of rows) {
        try { ok.push(await billLateChargeRow(r)); }
        catch (e) { failed.push({ invoiceId: r.invoiceId, message: e instanceof Error ? e.message : String(e) }); }
      }
      return { ok, failed };
    },
    onSettled: done,
  });
}
