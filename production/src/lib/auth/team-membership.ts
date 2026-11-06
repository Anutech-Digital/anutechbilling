/**
 * R-2477 (R-2471 slice 3) — the Team page works on MEMBERSHIPS of the selected company.
 * Spec: docs/specs/memberships.md §6.
 *
 * Every rule lives in SQL (update_company_member / remove_company_member: owner only, MFA, never
 * yourself, never the last active owner, this company only). These helpers only decide what the
 * screen OFFERS and carry the server's own words back (CLAUDE.md §24 — the refusal names the next
 * step, so it is never replaced with a vaguer one).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface MembershipPatch {
  role?: string;
  can_view_deals?: boolean;
  manager_id?: string | null;
  gets_new_leads?: boolean;
}

/** The fields update_company_member accepts — anything else is dropped before the call. */
const PATCH_KEYS = ["role", "can_view_deals", "manager_id", "gets_new_leads"] as const;

export function cleanPatch(patch: MembershipPatch): MembershipPatch {
  const out: Record<string, unknown> = {};
  for (const k of PATCH_KEYS) if (k in patch) out[k] = patch[k];
  return out as MembershipPatch;
}

/** Owner edits a member of THIS company (their membership; the users mirror follows). */
export async function updateMembership(
  supabase: Pick<SupabaseClient, "rpc">, userId: string, patch: MembershipPatch,
): Promise<void> {
  const rpc = supabase.rpc as unknown as (
    fn: "update_company_member", args: { p_user_id: string; p_patch: MembershipPatch },
  ) => PromiseLike<{ error: { message: string } | null }>;
  const { error } = await rpc.call(supabase, "update_company_member", { p_user_id: userId, p_patch: cleanPatch(patch) });
  if (error) throw new Error(error.message);
}

/**
 * Show "Remove" on this row? Never on your own row, and never on the only active owner (the
 * server refuses both anyway — a button that can only fail is a dead end).
 */
export function canRemoveMember(
  m: { id: string; role: string; is_active: boolean | null },
  myId: string | undefined,
  activeOwners: number,
): boolean {
  if (!myId || m.id === myId) return false;
  if (m.role === "owner" && m.is_active !== false && activeOwners <= 1) return false;
  return true;
}

/** Remove from this company — DELETE /api/team/members/:id (ends the membership only). */
export async function removeMember(userId: string, fetcher: typeof fetch = fetch): Promise<void> {
  const res = await fetcher(`/api/team/members/${encodeURIComponent(userId)}`, { method: "DELETE", cache: "no-store" });
  if (res.ok) return;
  const body = await res.json().catch(() => null) as { error?: string } | null;
  throw new Error(body?.error ?? "Couldn't remove this member. Refresh the Team page and try again.");
}
