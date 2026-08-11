/**
 * Activity Log — "who did what" trail (migration 0222).
 *
 * Read-only for owners/managers. Rows are written by DB triggers (human actions
 * only) + the log_activity RPC (login). We join the acting user for a name.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export type ActivityRow = {
  id: number;
  action: string;
  entity: string;
  entity_id: string | null;
  label: string | null;
  created_at: string;
  user_id: string | null;
  actor: { full_name: string | null; initials: string | null; color: string | null } | null;
};

export function useActivityLog(opts?: { userId?: string; limit?: number }) {
  const limit = opts?.limit ?? 200;
  return useQuery({
    queryKey: ["activity-log", opts?.userId ?? "all", limit],
    queryFn: async (): Promise<ActivityRow[]> => {
      const supabase = createClient();
      let q = supabase
        .from("activity_log")
        .select("id, action, entity, entity_id, label, created_at, user_id, actor:users!activity_log_user_id_fkey(full_name, initials, color)")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (opts?.userId) q = q.eq("user_id", opts.userId);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ActivityRow[];
    },
    staleTime: 15_000,
  });
}

/** Fire-and-forget: record a session login (once per browser session). */
export async function logLoginOnce() {
  if (typeof window === "undefined") return;
  try {
    if (sessionStorage.getItem("ros_login_logged")) return;
    sessionStorage.setItem("ros_login_logged", "1");
    const supabase = createClient();
    await supabase.rpc("log_activity", { p_action: "login", p_entity: "session" });
  } catch { /* non-critical */ }
}
