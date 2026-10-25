/**
 * R-1860 / R-1861 — the ONE place the app reads "What do you sell?" (tenants.sell_mode), the
 * "does this workspace already have subscriptions?" probe, and each user's "Show all modules".
 *
 * Read through an untyped client because sell_mode is newer than the generated types. A missing
 * column (before migration 20261024204624_r1860_tenant_sell_mode.sql) reads as 'both' — today's
 * full menu — and Save says it needs a database update first, like lib/compliance/profile.ts.
 */
"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { DEFAULT_SELL_MODE, parseSellMode, type SellMode } from "@/lib/sell-mode";

const untyped = () => createClient() as unknown as SupabaseClient;

/**
 * R-1862 — the active project sales behind the dashboard's Open projects tile (summed by
 * components/features/dashboard/sell-mode-dashboard.ts). Two columns, paged past PostgREST's
 * 1000-row cap. Only fetched when the dashboard leads with projects.
 */
export function useActiveProjectSales(enabled: boolean) {
  return useQuery({
    queryKey: ["sell_mode", "active_project_sales"],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<{ status: string | null; total_amount: number | null }[]> => {
      const supabase = createClient();
      const rows = await fetchAllRows((from, to) =>
        supabase.from("project_sales").select("id, status, total_amount").eq("status", "active")
          .order("id", { ascending: true }).range(from, to));
      return (rows ?? []).map((r) => ({ status: r.status, total_amount: r.total_amount }));
    },
  });
}

/** Before the migration: PostgREST / Postgres say the column is not there. */
export function isSellModeColumnMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return /sell_mode/.test(err.message ?? "") && /(does not exist|could not find)/i.test(err.message ?? "");
}

export interface SellModeState {
  mode: SellMode;
  /** True before the migration: the setting cannot be saved yet. */
  columnMissing: boolean;
}

export function useSellMode() {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: ["sell_mode", tenantId],
    enabled: Boolean(tenantId),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<SellModeState> => {
      const { data, error } = await untyped()
        .from("tenants")
        .select("sell_mode")
        .eq("id", tenantId as string)
        .maybeSingle();
      if (isSellModeColumnMissing(error)) return { mode: DEFAULT_SELL_MODE, columnMissing: true };
      if (error) throw new Error(error.message);
      return { mode: parseSellMode((data as { sell_mode?: unknown } | null)?.sell_mode), columnMissing: false };
    },
  });
}

export function useSaveSellMode() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useMutation({
    mutationFn: async (mode: SellMode) => {
      if (!tenantId) throw new Error("Not signed in to a workspace");
      const { data, error } = await untyped().from("tenants").update({ sell_mode: mode }).eq("id", tenantId).select("id");
      if (isSellModeColumnMissing(error)) {
        throw new Error("This option is not switched on yet — it needs a database update first.");
      }
      if (error) throw new Error(error.message);
      // RLS lets only the owner update the tenant row; anyone else gets zero rows, not an error.
      if (!data || data.length === 0) throw new Error("Only the workspace owner can change this.");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sell_mode"] });
      toast.success("Saved — the menu and dashboard now follow it");
    },
    onError: (err) => toast.error(`Could not save: ${(err as Error).message}`),
  });
}

/**
 * R-1861: does the workspace have at least one subscription? Then the subscription screens
 * stay in the menu whatever the answer says ("a module with data comes back"). One row at most.
 * Only asked when the answer would hide them. undefined while loading (rows stay hidden, so
 * nothing flashes in and out); a failed read counts as "has data" — never hide on a guess.
 */
export function useHasSubscriptions(enabled: boolean) {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  const q = useQuery({
    queryKey: ["sell_mode", "has_subscriptions", tenantId],
    enabled: enabled && Boolean(tenantId),
    staleTime: 5 * 60 * 1000,
    queryFn: async (): Promise<boolean> => {
      const { data, error } = await createClient().from("subscriptions").select("id").limit(1);
      if (error) return true;
      return (data?.length ?? 0) > 0;
    },
  });
  return q.data;
}

const SHOW_ALL_KEY = "ros_show_all_modules";
const SHOW_ALL_EVENT = "ros-show-all-modules";

/**
 * R-1861 — "Show all modules", per user (Pardeep, R-1841 decision): the company answer is
 * only the default. Kept in this browser under the user's id; storage that throws (private
 * window) just means the toggle starts off.
 */
export function useShowAllModules(): [boolean, (on: boolean) => void] {
  const me = useCurrentUser();
  const key = me.data?.userId ? `${SHOW_ALL_KEY}:${me.data.userId}` : null;
  const [on, setOn] = React.useState(false);
  React.useEffect(() => {
    if (!key) return;
    const read = () => {
      try { setOn(localStorage.getItem(key) === "1"); } catch { setOn(false); }
    };
    read();
    window.addEventListener(SHOW_ALL_EVENT, read);
    return () => window.removeEventListener(SHOW_ALL_EVENT, read);
  }, [key]);
  const set = React.useCallback((next: boolean) => {
    setOn(next);
    if (!key) return;
    try { localStorage.setItem(key, next ? "1" : "0"); } catch { /* per-browser convenience only */ }
    window.dispatchEvent(new Event(SHOW_ALL_EVENT));
  }, [key]);
  return [on, set];
}
