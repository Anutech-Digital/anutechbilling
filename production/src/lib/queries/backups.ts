/**
 * In-app data backup — owner takes a snapshot of THEIR tenant's data and
 * downloads a copy. All access is via tenant-scoped SECURITY DEFINER RPCs
 * (migration 0211); snapshots live in the hidden `backup` schema.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";

const KEY = ["tenant_backups"] as const;

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
    onError: (err) => toast.error((err as Error).message),
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
    onError: (err) => toast.error((err as Error).message),
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
    onError: (err) => toast.error((err as Error).message),
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
