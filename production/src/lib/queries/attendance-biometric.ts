/**
 * Biometric-attendance setup hooks — read/regenerate the tenant's ingest key and
 * map employees to their device user number (biometric_id). The office bridge
 * uses the key to POST punches to /api/attendance/punch. (migration 0215)
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";

const KEY = ["attendance-ingest"] as const;

export function useAttendanceIngest() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<{ tenantId: string; key: string | null }> => {
      const supabase = createClient();
      // RLS returns only the caller's tenant row.
      const { data, error } = await supabase.from("tenants").select("id, attendance_ingest_key").limit(1).maybeSingle();
      if (error) throw error;
      return { tenantId: (data?.id as string) ?? "", key: (data?.attendance_ingest_key as string | null) ?? null };
    },
  });
}

export function useRegenerateIngestKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (tenantId: string) => {
      const supabase = createClient();
      const fresh = (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}${Math.round(Math.random() * 1e9)}`).replace(/-/g, "");
      const { error } = await supabase.from("tenants").update({ attendance_ingest_key: fresh }).eq("id", tenantId);
      if (error) throw error;
      return fresh;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("New key generated — update it in the bridge."); },
    onError: (e) => toast.error((e as Error).message),
  });
}

/** Set (or clear) an employee's device user number. */
export function useSetEmployeeBiometricId() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { employeeId: string; biometricId: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.from("employees")
        .update({ biometric_id: input.biometricId?.trim() || null }).eq("id", input.employeeId);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); },
    onError: (e) => toast.error((e as Error).message),
  });
}
