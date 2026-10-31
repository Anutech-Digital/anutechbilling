/**
 * R-2175 (G-PERSONAL): may the app shell ask for BUSINESS records right now?
 *
 * The shell (Sidebar badges, the TopBar bell, the attendance reminder) is mounted on every page.
 * For a personal session its business reads — rpc nav_badges / my_attendance_today, holidays,
 * tasks, leads, contacts, subscriptions — are refused by the data gateway's personal allowlist
 * (R-2125): a 403 and a `gateway_refused` log line per call per page, and the help "error was
 * caught" badge lights up. A personal workspace has none of those records, so the shell does
 * not ask.
 *
 *   false while identity loads (the role is not known yet — asking first and finding out later
 *         is exactly the refused call), and for a personal session (lib/workspace/kind.ts
 *         isPersonalSession — the gateway's own either-one rule);
 *   true  for every business role, and when identity failed / has no profile (the shell
 *         behaves as it did before R-2175 — nothing business is hidden on a guess).
 *
 * Role is what useCurrentUser carries; role 'personal' is set together with workspace_kind
 * 'personal' (lib/personal/personal-workspace.server.ts), and the gateway still refuses on
 * either one, so a mismatch can only cost a refused call, never open data.
 */
"use client";

import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isPersonalSession } from "@/lib/workspace/kind";

export function useBusinessShell(): boolean {
  const { data: me, isLoading } = useCurrentUser();
  if (isLoading) return false;
  return !isPersonalSession(me ? { role: me.role } : null);
}
