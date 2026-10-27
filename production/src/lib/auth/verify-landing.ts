/**
 * R-1926 (G-ONBOARD OB-5): where a just-confirmed password signup lands, signed in.
 *
 *   profile row + owner + company setup not finished → /setup?welcome=1  (same as the Google door,
 *                                                         welcome/page.tsx)
 *   profile row otherwise                             → /dashboard
 *   no profile row (parked on a join request, or none) → null: NO session — they have no
 *                                                         workspace to open yet
 *
 * Reads only the confirmed user's OWN users row (by auth id) and that row's tenant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export const SETUP_WELCOME_PATH = "/setup?welcome=1";

export async function landingAfterVerify(
  admin: SupabaseClient,
  userId: string,
): Promise<"/setup?welcome=1" | "/dashboard" | null> {
  const { data: member } = await admin
    .from("users")
    .select("id, tenant_id, role")
    .eq("id", userId)
    .maybeSingle();
  const m = member as { id: string; tenant_id: string | null; role: string | null } | null;
  if (!m?.tenant_id) return null;
  if (m.role !== "owner") return "/dashboard";
  const { data: tenant } = await admin
    .from("tenants")
    .select("id, setup_completed_at")
    .eq("id", m.tenant_id)
    .maybeSingle();
  const t = tenant as { setup_completed_at: string | null } | null;
  return t && !t.setup_completed_at ? SETUP_WELCOME_PATH : "/dashboard";
}
