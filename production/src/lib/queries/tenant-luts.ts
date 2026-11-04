/**
 * R-2444 — the company's LUT (Letter of Undertaking, Form RFD-11) per financial year: tenant_luts
 * and its two RPCs (migration 20261104023601_r2444_lut_per_fy). Writes only through
 * save_tenant_lut / delete_tenant_lut (owner or accountant; the RPC checks the role and the dates).
 *
 * Untyped client: the table and functions are newer than database.types.ts.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { toastError } from "@/lib/errors/toast-error";
import { lutFyLabel, type TenantLut } from "@/lib/gst/export-lut";

const untyped = () => createClient() as unknown as SupabaseClient;

export const TENANT_LUTS_KEY = ["tenant_luts"] as const;

interface LutRow { fy_start: string; arn: string; valid_from: string; valid_upto: string }

/** Code deployed before the migration: no table yet → read as "no LUT rows". */
function isTableMissing(message: string): boolean {
  return /tenant_luts/.test(message) && /(does not exist|could not find|schema cache)/i.test(message);
}

/** Every LUT of the company, newest FY first. A failed read is an error (never "no LUT"). */
export function useTenantLuts(enabled = true) {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: [...TENANT_LUTS_KEY, tenantId],
    enabled: enabled && Boolean(tenantId),
    queryFn: async (): Promise<TenantLut[]> => {
      const { data, error } = await untyped().from("tenant_luts")
        .select("fy_start, arn, valid_from, valid_upto").order("fy_start", { ascending: false });
      if (error) {
        if (isTableMissing(error.message)) return [];
        throw new Error(error.message);
      }
      return ((data ?? []) as LutRow[]).map((r) => ({
        fyStart: r.fy_start, arn: r.arn, validFrom: r.valid_from, validUpto: r.valid_upto,
      }));
    },
  });
}

export interface SaveLutInput { fyStart: string; arn: string; validFrom: string | null; validUpto: string | null }

export function useSaveTenantLut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SaveLutInput) => {
      const { error } = await untyped().rpc("save_tenant_lut", {
        p_fy_start: input.fyStart, p_arn: input.arn, p_valid_from: input.validFrom, p_valid_upto: input.validUpto,
      });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, input) => {
      toast.success(`LUT for FY ${lutFyLabel(input.fyStart)} saved`);
      void qc.invalidateQueries({ queryKey: TENANT_LUTS_KEY });
      void qc.invalidateQueries({ queryKey: ["current-user"] });
    },
    onError: (e) => toastError(e, { fallback: "Could not save the LUT" }),
  });
}

export function useDeleteTenantLut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (fyStart: string) => {
      const { error } = await untyped().rpc("delete_tenant_lut", { p_fy_start: fyStart });
      if (error) throw new Error(error.message);
    },
    onSuccess: (_d, fyStart) => {
      toast.success(`LUT for FY ${lutFyLabel(fyStart)} removed`);
      void qc.invalidateQueries({ queryKey: TENANT_LUTS_KEY });
      void qc.invalidateQueries({ queryKey: ["current-user"] });
    },
    onError: (e) => toastError(e, { fallback: "Could not remove the LUT" }),
  });
}
