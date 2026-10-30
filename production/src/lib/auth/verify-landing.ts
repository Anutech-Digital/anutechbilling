/**
 * R-1926 (G-ONBOARD OB-5): where a just-confirmed password signup lands, signed in.
 *
 *   profile row + owner + company setup not finished → /setup?welcome=1  (same as the Google door,
 *                                                         welcome/page.tsx)
 *   profile row, role personal (R-2119, G-PERSONAL)   → /money — never the company wizard
 *   profile row otherwise                             → /dashboard
 *   no profile row (parked on a join request, or none) → null: NO session — they have no
 *                                                         workspace to open yet
 *
 * Reads only the confirmed user's OWN users row (by auth id) and that row's tenant.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { PERSONAL_HOME } from "@/lib/personal/signup-flag";

export const SETUP_WELCOME_PATH = "/setup?welcome=1" as const;

/** Every place landingAfterVerify can send someone. The /verify-email page follows the server's
 *  next ONLY when it is on this list (R-1926 allowlist; R-2119 adds the personal home) — never an
 *  arbitrary URL. One list, so a new landing cannot be returned here and dropped by the page. */
export const VERIFY_LANDINGS = [SETUP_WELCOME_PATH, "/dashboard", PERSONAL_HOME] as const;
export type VerifyLanding = (typeof VERIFY_LANDINGS)[number];

export function isVerifyLanding(next: unknown): next is VerifyLanding {
  return typeof next === "string" && (VERIFY_LANDINGS as readonly string[]).includes(next);
}

export async function landingAfterVerify(
  admin: SupabaseClient,
  userId: string,
): Promise<VerifyLanding | null> {
  const { data: member } = await admin
    .from("users")
    .select("id, tenant_id, role")
    .eq("id", userId)
    .maybeSingle();
  const m = member as { id: string; tenant_id: string | null; role: string | null } | null;
  if (!m?.tenant_id) return null;
  if (m.role === "personal") return PERSONAL_HOME;
  if (m.role !== "owner") return "/dashboard";
  const { data: tenant } = await admin
    .from("tenants")
    .select("id, setup_completed_at")
    .eq("id", m.tenant_id)
    .maybeSingle();
  const t = tenant as { setup_completed_at: string | null } | null;
  return t && !t.setup_completed_at ? SETUP_WELCOME_PATH : "/dashboard";
}
