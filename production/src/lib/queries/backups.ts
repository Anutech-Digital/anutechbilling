/**
 * In-app data backup — owner takes a snapshot of THEIR tenant's data and
 * downloads a copy. All access is via tenant-scoped SECURITY DEFINER RPCs
 * (migration 0211); snapshots live in the hidden `backup` schema.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient } from "@/lib/supabase/client";

const KEY = ["tenant_backups"] as const;

/**
 * How many snapshots are kept per tenant. Must match the `limit` in
 * `backup._take` (migration 20260928141000 — was 30 until S15, 28 Sep 2026).
 *
 * Exported because this page previously stated the number twice, in two places,
 * and got it wrong both times: one paragraph promised "last 15", another "last
 * 20", and the function actually kept 20. Three numbers for one fact is how a
 * user learns not to trust the screen. One constant, used everywhere it is
 * claimed.
 *
 * S15: 7, not 30. These rows live INSIDE the database they back up — an undo
 * button, not a backup. 30 × 50 tenants made every night's `_take` delete heavier
 * and the DB fatter for no extra safety: the long history is off-site (daily/ 400
 * days, monthly/ 8 years) and in Cloud SQL PITR.
 */
export const SNAPSHOT_RETENTION = 7;

export type BackupRow = { id: string; created_at: string; label: string | null; kind: string; table_count: number; bytes: number };

export function useBackups() {
  return useQuery({
    queryKey: KEY,
    queryFn: async (): Promise<BackupRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("list_tenant_backups");
      if (error) throw error;
      return (data ?? []) as BackupRow[];
    },
  });
}

export function useCreateBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (label?: string) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("create_tenant_backup", { p_label: label ?? null });
      if (error) throw new Error(error.message);
      return data as { id: string; table_count: number; bytes: number; created_at: string };
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); },
    onError: (err) => toastError(err),
  });
}

/** Restore the tenant's data to a chosen point. A "Before restore" safety point
 *  is auto-saved first. All app data changes → invalidate everything. */
export function useRestoreBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("restore_tenant_backup", { p_id: id });
      if (error) throw new Error(error.message);
      return data as { restored_tables: number; restored_at: string };
    },
    onSuccess: (res) => {
      qc.invalidateQueries(); // every screen's data just changed
      toast.success(`Restore ho gaya — ${res.restored_tables} tables wapas is point par. (Pehle wala data "Before restore" point me safe hai.)`);
    },
    onError: (err) => toastError(err),
  });
}

/** Fire-and-forget: create a daily 'auto' restore point if none exists < 20h. */
export async function autoBackupIfStale(): Promise<boolean> {
  try {
    const supabase = createClient();
    const { data, error } = await supabase.rpc("auto_backup_if_stale");
    if (error) return false;
    return !!(data as { created: boolean } | null)?.created;
  } catch { return false; }
}

export function useDeleteBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_tenant_backup", { p_id: id });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("Backup deleted"); },
    onError: (err) => toastError(err),
  });
}

/** Pull a snapshot's full payload and trigger a browser download as JSON. */
export async function downloadBackup(id: string, createdAt: string): Promise<void> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_tenant_backup", { p_id: id });
  if (error || data == null) { toast.error("Backup download fail — dobara try karo."); return; }
  const stamp = createdAt.slice(0, 10);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `resellersos-backup-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
