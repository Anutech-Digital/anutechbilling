/**
 * GET /api/platform/signups — FOUNDER-ONLY cross-tenant signup list.
 *
 * Every other read in the app is RLS-scoped to one tenant. This route is the
 * one deliberate exception: it uses the service-role admin client to list ALL
 * tenants who signed up for ResellerOS. It is gated HARD — the caller must be
 * authenticated AND their email must be in the platform-admin allowlist, or it
 * 403s before the admin client is ever created. No tenant can reach this.
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";

export async function GET() {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const admin = createAdminClient();
  const [{ data: tenants, error: tErr }, { data: users }, { data: customers }] = await Promise.all([
    admin.from("tenants").select("id, name, created_at, tier, gstin, state, setup_completed_at").order("created_at", { ascending: false }),
    admin.from("users").select("tenant_id, role, full_name"),
    admin.from("customers").select("tenant_id"),
  ]);
  if (tErr) return NextResponse.json({ error: tErr.message }, { status: 500 });

  // Owner name + per-tenant counts (small N — aggregate in memory).
  const ownerByTenant = new Map<string, string>();
  const userCount = new Map<string, number>();
  for (const u of users ?? []) {
    userCount.set(u.tenant_id, (userCount.get(u.tenant_id) ?? 0) + 1);
    if (u.role === "owner" && !ownerByTenant.has(u.tenant_id)) ownerByTenant.set(u.tenant_id, u.full_name ?? "—");
  }
  const custCount = new Map<string, number>();
  for (const c of customers ?? []) custCount.set(c.tenant_id, (custCount.get(c.tenant_id) ?? 0) + 1);

  const rows = (tenants ?? []).map((t) => ({
    id: t.id,
    name: t.name,
    owner: ownerByTenant.get(t.id) ?? "—",
    signedUp: t.created_at,
    tier: t.tier,
    gstin: t.gstin,
    state: t.state,
    activated: Boolean(t.setup_completed_at),
    users: userCount.get(t.id) ?? 0,
    customers: custCount.get(t.id) ?? 0,
  }));

  return NextResponse.json({ count: rows.length, tenants: rows });
}
