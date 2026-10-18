/**
 * /api/platform/signups/[id] — FOUNDER-ONLY Tenant Management API (DELETE & PATCH).
 *
 * Gated HARD: Caller must be authenticated AND email must be in `isPlatformAdmin` allowlist.
 * - DELETE: Removes an EMPTY signup workspace — verified admin, typed name, audit, one atomic
 *   statement; a workspace with business data is refused (R-881, see DELETE below).
 * - PATCH: Updates tenant metadata (Name, Tier, GSTIN, State, Phone, Activation status).
 */
import { NextResponse } from "next/server";
import { createClient, createAdminClient } from "@/lib/supabase/server";
import { isPlatformAdmin } from "@/lib/platform";
import type { TablesUpdate } from "@/lib/supabase/database.types";

/**
 * R-881: tables whose rows mean "this workspace has real business data". A workspace with any of
 * them is NOT deleted here — the founder deactivates it instead (Edit → Activated off). Deleting
 * one would erase a company's books, and nothing here can bring them back.
 */
const PLATFORM_DELETE_DATA_TABLES = [
  "customers", "invoices", "quotes", "subscriptions", "payments",
  "credit_notes", "expenses", "bank_transactions",
] as const;

const fail = (status: number, error: string) => NextResponse.json({ success: false, error }, { status });

/**
 * DELETE: remove an EMPTY signup workspace. R-881 — before this, the only gate was the email
 * allowlist (route.ts:22 on 514efbdb), the body needed nothing typed, there was no audit, and
 * five separate deletes could stop half-way and leave a broken workspace.
 *
 * Now, fail closed at every step:
 *   1. Signed in, on the platform allowlist (the existing `isPlatformAdmin` guard) AND the
 *      account's email is VERIFIED — an unverified signup that typed an admin email gets 403.
 *   2. Body `{ confirm }` must equal the workspace's name exactly.
 *   3. Never the caller's own workspace (nor the Anutech Digital one).
 *   4. Any business data (PLATFORM_DELETE_DATA_TABLES) → 409 "has data"; a count that cannot
 *      be read counts as data.
 *   5. An audit line is written to the CALLER's workspace activity_log BEFORE the delete (the
 *      target's own log goes with it); no audit → no delete.
 *   6. ONE `delete from tenants` — every tenant FK is ON DELETE CASCADE, so it is all-or-nothing
 *      in a single statement.
 */
export async function DELETE(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const tenantId = params.id;
  if (!tenantId) return fail(400, "Workspace id nahi mila — Platform page refresh karke dobara Delete dabaiye.");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail(401, "Aap signed in nahi hain — dobara login karke try kariye.");
  if (!isPlatformAdmin(user.email)) {
    return fail(403, "Workspace delete sirf platform admin kar sakte hain — Pardeep se kahiye.");
  }
  if (!user.email_confirmed_at) {
    return fail(403, "Aapka email abhi verify nahi hua — inbox mein verification link kholiye, phir dobara try kariye.");
  }

  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";

  const admin = createAdminClient();

  const { data: me } = await admin.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const myTenantId = (me as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  if (!myTenantId) {
    return fail(403, "Aapka account kisi workspace se juda nahi hai, isliye audit nahi likha ja sakta — delete nahi hua.");
  }

  const { data: targetTenant, error: fetchErr } = await admin
    .from("tenants")
    .select("id, name")
    .eq("id", tenantId)
    .maybeSingle();
  if (fetchErr || !targetTenant) {
    return fail(404, "Ye workspace nahi mila — shayad pehle hi hat chuka hai. Platform page refresh kariye.");
  }

  if (!confirm || confirm !== targetTenant.name.trim()) {
    return fail(400, `Delete pakka karne ke liye workspace ka naam "${targetTenant.name}" bilkul waisa hi type kariye.`);
  }

  if (targetTenant.id === myTenantId || targetTenant.name.toLowerCase().includes("anutech digital")) {
    return fail(400, "Apna (platform) workspace delete nahi ho sakta.");
  }

  const withData: string[] = [];
  for (const table of PLATFORM_DELETE_DATA_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    if (error || count === null || count === undefined) {
      console.error(`[api/platform/signups/[id]] DELETE: could not count ${table}:`, error?.message);
      return fail(503, "Workspace ka data gin nahi paaye, isliye delete roka — kuch nahi hata. Thodi der baad dobara try kariye.");
    }
    if (count > 0) withData.push(`${table} ${count}`);
  }
  if (withData.length > 0) {
    return fail(
      409,
      `Is workspace mein data hai (${withData.join(", ")}) — data wala workspace delete nahi hota. Edit kholkar "Activated" band kariye.`,
    );
  }

  const audit = (label: string) =>
    admin.from("activity_log").insert({
      tenant_id: myTenantId,
      user_id: user.id,
      action: "delete",
      entity: "platform_tenant",
      entity_id: tenantId,
      label,
      actor_label: user.email ?? null,
    });

  const { error: auditErr } = await audit(`Platform: workspace '${targetTenant.name}' (${tenantId}) delete shuru`);
  if (auditErr) {
    console.error("[api/platform/signups/[id]] DELETE: audit write failed:", auditErr.message);
    return fail(503, "Audit log nahi likh paaye, isliye delete roka — kuch nahi hata. Thodi der baad dobara try kariye.");
  }

  const { error: deleteErr } = await admin.from("tenants").delete().eq("id", tenantId);
  if (deleteErr) {
    console.error("[api/platform/signups/[id]] DELETE failed:", deleteErr.message);
    await audit(`Platform: workspace '${targetTenant.name}' (${tenantId}) delete FAIL — kuch nahi hata`);
    return fail(500, "Workspace delete nahi hua — kuch nahi hata. Platform page refresh karke dobara try kariye.");
  }
  await audit(`Platform: workspace '${targetTenant.name}' (${tenantId}) delete ho gaya`);

  return NextResponse.json({ success: true, message: `Workspace '${targetTenant.name}' permanently deleted.` });
}

// PATCH handler: Update reseller workspace details
export async function PATCH(request: Request, props: { params: Promise<{ id: string }> }) {
  const params = await props.params;
  const tenantId = params.id;
  if (!tenantId) return NextResponse.json({ error: "Missing tenant ID." }, { status: 400 });

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  if (!isPlatformAdmin(user.email)) {
    return NextResponse.json({ error: "Not authorized." }, { status: 403 });
  }

  const body = await request.json().catch(() => ({}));
  const { name, tier, gstin, state, phone, activated } = body;

  const admin = createAdminClient();

  const updates: TablesUpdate<"tenants"> = {};
  if (name !== undefined) updates.name = name.trim();
  if (tier !== undefined) updates.tier = tier;
  if (gstin !== undefined) updates.gstin = gstin ? gstin.trim().toUpperCase() : null;
  if (state !== undefined) updates.state = state ? state.trim() : null;
  if (phone !== undefined) updates.phone = phone ? phone.trim() : null;
  if (activated !== undefined) {
    updates.setup_completed_at = activated ? new Date().toISOString() : null;
  }

  const { data: updatedTenant, error: updateErr } = await admin
    .from("tenants")
    .update(updates)
    .eq("id", tenantId)
    .select()
    .single();

  if (updateErr) {
    return NextResponse.json({ error: updateErr.message || "Failed to update tenant." }, { status: 500 });
  }

  return NextResponse.json({ success: true, tenant: updatedTenant, message: "Workspace updated successfully." });
}
