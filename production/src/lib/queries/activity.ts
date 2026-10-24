/**
 * Activity Log — "who did what" trail (migration 0222).
 *
 * Read-only for owners/managers. Rows are written by DB triggers (human actions
 * only) + the server's sign-in record (R-1010, src/server/auth/login-log.ts). We join the
 * acting user for a name.
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
  /** 'Customer <name>' when a portal customer (not in `users`) made the change — R-016. */
  actor_label: string | null;
  /** update → { column: { old, new } } · delete → { old: row } (migration 20260927150000). */
  changes: Record<string, unknown> | null;
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
        .select("id, action, entity, entity_id, label, created_at, user_id, actor_label, changes, actor:users!activity_log_user_id_fkey(full_name, initials, color)")
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

/**
 * Fire-and-forget: ask the SERVER to record this sign-in (once per browser session).
 * R-1010: the browser no longer writes the row — POST /api/auth/login-event reads the user,
 * sign-in time, IP and device on the server (with Auth.js it was already recorded at sign-in),
 * and the database ignores log_activity('login') from a browser.
 */
export async function logLoginOnce() {
  if (typeof window === "undefined") return;
  try {
    if (sessionStorage.getItem("ros_login_logged")) return;
    sessionStorage.setItem("ros_login_logged", "1");
    await fetch("/api/auth/login-event", { method: "POST", credentials: "same-origin" });
  } catch { /* non-critical */ }
}
