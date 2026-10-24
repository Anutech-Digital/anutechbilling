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
import { companyGstinStateConflict, stateCodeFromName } from "@/lib/gst/gstin-state";

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
  if (!tenantId) return fail(400, "Workspace id is missing — refresh the Platform page and press Delete again.");

  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return fail(401, "You are not signed in — sign in again and try again.");
  if (!isPlatformAdmin(user.email)) {
    return fail(403, "Only a platform admin can delete a workspace — ask Pardeep.");
  }
  if (!user.email_confirmed_at) {
    return fail(403, "Your email is not verified yet — open the verification link in your inbox, then try again.");
  }

  const body = (await request.json().catch(() => null)) as { confirm?: unknown } | null;
  const confirm = typeof body?.confirm === "string" ? body.confirm.trim() : "";

  const admin = createAdminClient();

  const { data: me } = await admin.from("users").select("tenant_id").eq("id", user.id).maybeSingle();
  const myTenantId = (me as { tenant_id?: string | null } | null)?.tenant_id ?? null;
  if (!myTenantId) {
    return fail(403, "Your account is not linked to any workspace, so the audit log cannot be written — nothing was deleted.");
  }

  const { data: targetTenant, error: fetchErr } = await admin
    .from("tenants")
    .select("id, name")
    .eq("id", tenantId)
    .maybeSingle();
  if (fetchErr || !targetTenant) {
    return fail(404, "This workspace was not found — it may already be deleted. Refresh the Platform page.");
  }

  if (!confirm || confirm !== targetTenant.name.trim()) {
    return fail(400, `To confirm the delete, type the workspace name "${targetTenant.name}" exactly as shown.`);
  }

  if (targetTenant.id === myTenantId || targetTenant.name.toLowerCase().includes("anutech digital")) {
    return fail(400, "The platform's own workspace cannot be deleted.");
  }

  const withData: string[] = [];
  for (const table of PLATFORM_DELETE_DATA_TABLES) {
    const { count, error } = await admin
      .from(table)
      .select("id", { count: "exact", head: true })
      .eq("tenant_id", tenantId);
    if (error || count === null || count === undefined) {
      console.error(`[api/platform/signups/[id]] DELETE: could not count ${table}:`, error?.message);
      return fail(503, "Could not count this workspace's data, so the delete was stopped — nothing was removed. Try again in a little while.");
    }
    if (count > 0) withData.push(`${table} ${count}`);
  }
  if (withData.length > 0) {
    return fail(
      409,
      `This workspace has data (${withData.join(", ")}) — a workspace with data cannot be deleted. Open Edit and turn off "Activated" instead.`,
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
    return fail(503, "Could not write the audit log, so the delete was stopped — nothing was removed. Try again in a little while.");
  }

  const { error: deleteErr } = await admin.from("tenants").delete().eq("id", tenantId);
  if (deleteErr) {
    console.error("[api/platform/signups/[id]] DELETE failed:", deleteErr.message);
    await audit(`Platform: workspace '${targetTenant.name}' (${tenantId}) delete FAILED — nothing was removed`);
    return fail(500, "Workspace was not deleted — nothing was removed. Refresh the Platform page and try again.");
  }
  await audit(`Platform: workspace '${targetTenant.name}' (${tenantId}) deleted`);

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
  if (state !== undefined) {
    updates.state = state ? state.trim() : null;
    /* R-1128: keep state_code with the name (R-250 rule) — the invoice reads only the code. */
    const code = stateCodeFromName(updates.state);
    if (code) updates.state_code = code;
  }

  /* R-1128: the state must be the one the GSTIN was issued in (first 2 digits) — fail closed:
     if the current row cannot be read to check, nothing is saved. */
  if (gstin !== undefined || state !== undefined) {
    const { data: current, error: readErr } = await admin
      .from("tenants").select("gstin, state, state_code").eq("id", tenantId).maybeSingle();
    if (readErr || !current) {
      return NextResponse.json({ error: "Could not read this workspace to check its GSTIN and state, so nothing was saved. Refresh the page and try again." }, { status: 500 });
    }
    const finalGstin = updates.gstin !== undefined ? updates.gstin : current.gstin;
    const finalState = updates.state_code ?? (updates.state !== undefined ? updates.state : current.state_code ?? current.state);
    const conflict = companyGstinStateConflict(finalState, finalGstin);
    if (conflict) return NextResponse.json({ error: conflict.message }, { status: 400 });
  }
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
