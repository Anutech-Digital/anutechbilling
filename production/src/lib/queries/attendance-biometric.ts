/**
 * Biometric-attendance setup hooks — read/regenerate the tenant's ingest key and
 * map employees to their device user number (biometric_id). The office bridge
 * uses the key to POST punches to /api/attendance/punch. (migration 0215)
 *
 * R-607: the key is read and rotated through /api/attendance/ingest-key (owner only). It
 * used to be read straight off the tenants row, which every member can read.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient } from "@/lib/supabase/client";

const KEY = ["attendance-ingest"] as const;

export function useAttendanceIngest() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<{ tenantId: string; key: string | null }> => {
      const res = await fetch("/api/attendance/ingest-key");
      const json = (await res.json().catch(() => ({}))) as { tenantId?: string; key?: string | null; error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not load the device key");
      return { tenantId: json.tenantId ?? "", key: json.key ?? null };
    },
  });
}

export function useRegenerateIngestKey() {
  const qc = useQueryClient();
  return useMutation({
    /* The server always uses the owner's own tenant; the argument stays for existing callers. */
    mutationFn: async (_tenantId: string) => {
      void _tenantId;
      const res = await fetch("/api/attendance/ingest-key", { method: "POST" });
      const json = (await res.json().catch(() => ({}))) as { key?: string; error?: string };
      if (!res.ok || !json.key) throw new Error(json.error ?? "Could not make a new key");
      return json.key;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("New key generated — update it in the bridge."); },
    onError: (e) => toastError(e),
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
    onError: (e) => toastError(e),
  });
}
