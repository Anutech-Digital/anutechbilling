/**
 * R-524 — the server half of "Try the demo" (what and why: ./demo-account.ts).
 *
 *  - ensureDemoTenant: creates the ONE sample workspace and its two logins, once. Idempotent —
 *    a second run finds them and changes nothing.
 *  - signInAs: a session for one of those logins WITHOUT a password. The service role mints a
 *    one-time magic-link token and the given client redeems it at once (no mail is sent; the
 *    addresses are on .invalid anyway). The random passwords set at creation are never stored.
 *  - resetDemoData: nightly — clear the sample rows, add a fresh set. Runs as the SEEDER login,
 *    so RLS keeps every write inside the demo tenant; the service role never writes sample rows.
 *
 * Only the cron route and /api/public/demo-session call this file.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { addDemoData, clearDemoData, type DemoCounts, type DemoDb } from "./demo-data.server";
import { DEMO_SEEDER_EMAIL, DEMO_TENANT_NAME, DEMO_VISITOR_EMAIL } from "./demo-account";

export interface DemoTenantRow {
  tenant_id: string;
  visitor_user_id: string;
  seeder_user_id: string;
}

/** The demo workspace's state — Delhi, so the sample invoices show both GST splits. */
export const DEMO_STATE_CODE = "07";

type Result<T> = ({ ok: true } & T) | { ok: false; error: string };

export async function getDemoTenant(admin: SupabaseClient): Promise<DemoTenantRow | null> {
  const { data, error } = await admin
    .from("demo_tenants")
    .select("tenant_id, visitor_user_id, seeder_user_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error || !data) return null;
  return data as DemoTenantRow;
}

async function findAuthUserId(admin: SupabaseClient, email: string): Promise<string | null> {
  for (let page = 1; page <= 50; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) return null;
    const hit = data.users.find((u) => (u.email ?? "").toLowerCase() === email);
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

async function ensureAuthUser(
  admin: SupabaseClient,
  email: string,
  fullName: string,
  appMeta: Record<string, boolean>,
): Promise<Result<{ id: string }>> {
  const password = `${randomBytes(24).toString("base64url")}Aa1!`;
  const created = await admin.auth.admin.createUser({
    email, password, email_confirm: true, app_metadata: appMeta, user_metadata: { full_name: fullName },
  });
  if (created.data.user) return { ok: true, id: created.data.user.id };
  const id = await findAuthUserId(admin, email);
  if (!id) return { ok: false, error: `Could not create the demo login ${email}: ${created.error?.message ?? "unknown"}` };
  const upd = await admin.auth.admin.updateUserById(id, { app_metadata: appMeta });
  if (upd.error) return { ok: false, error: `Could not flag the demo login ${email}: ${upd.error.message}` };
  return { ok: true, id };
}

/** Creates the demo tenant + logins if missing. Never touches any other tenant. */
export async function ensureDemoTenant(admin: SupabaseClient): Promise<Result<{ demo: DemoTenantRow; created: boolean }>> {
  const existing = await getDemoTenant(admin);
  if (existing) return { ok: true, demo: existing, created: false };

  const visitor = await ensureAuthUser(admin, DEMO_VISITOR_EMAIL, "Demo visitor", { demo_visitor: true });
  if (!visitor.ok) return visitor;
  const seeder = await ensureAuthUser(admin, DEMO_SEEDER_EMAIL, "Sample data", { demo_seeder: true });
  if (!seeder.ok) return seeder;

  // A half-finished earlier run may already have made the tenant: reuse the seeder's.
  const { data: prior } = await admin.from("users").select("tenant_id").eq("id", seeder.id).maybeSingle();
  let tenantId = (prior as { tenant_id?: string } | null)?.tenant_id ?? null;
  if (!tenantId) {
    tenantId = crypto.randomUUID();
    const { error } = await admin.from("tenants").insert({
      id: tenantId, name: DEMO_TENANT_NAME, email: DEMO_SEEDER_EMAIL, state_code: DEMO_STATE_CODE,
    });
    if (error) return { ok: false, error: `Could not create the demo workspace: ${error.message}` };
  }

  const people = [
    { id: seeder.id, tenant_id: tenantId, email: DEMO_SEEDER_EMAIL, full_name: "Sample data", initials: "SD", role: "owner", color: "amber" },
    { id: visitor.id, tenant_id: tenantId, email: DEMO_VISITOR_EMAIL, full_name: "Demo visitor", initials: "DV", role: "manager", color: "amber" },
  ];
  const { error: usersErr } = await admin.from("users").upsert(people, { onConflict: "id" });
  if (usersErr) return { ok: false, error: `Could not add the demo logins to the workspace: ${usersErr.message}` };

  const row: DemoTenantRow = { tenant_id: tenantId, visitor_user_id: visitor.id, seeder_user_id: seeder.id };
  const { error: regErr } = await admin.from("demo_tenants").insert(row);
  if (regErr) return { ok: false, error: `Could not register the demo workspace: ${regErr.message}` };
  return { ok: true, demo: row, created: true };
}

/** Signs `client` in as `email` with a one-time token minted by the service role. */
export async function signInAs(admin: SupabaseClient, client: SupabaseClient, email: string): Promise<Result<{ userId: string }>> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  const tokenHash = link.data?.properties?.hashed_token;
  if (link.error || !tokenHash) return { ok: false, error: `Could not open the demo login: ${link.error?.message ?? "no token"}` };
  const { data, error } = await client.auth.verifyOtp({ type: "magiclink", token_hash: tokenHash });
  if (error || !data.user) return { ok: false, error: `Could not open the demo login: ${error?.message ?? "no user"}` };
  return { ok: true, userId: data.user.id };
}

/**
 * The fail-closed check: is the database refusing writes for this session? Anything but 'on'
 * (migration missing, PostgREST pre-request not loaded, an error) = NO.
 */
export async function readOnlyWallUp(client: SupabaseClient): Promise<boolean> {
  const { data, error } = await client.rpc("demo_readonly_probe");
  return !error && data === "on";
}

export interface ResetContext { today: string; stamp: number; newId: () => string }

/** Clear + re-add the sample rows, as the seeder (`seederClient` must be signed in as it). */
export async function resetDemoData(
  seederClient: SupabaseClient,
  demo: DemoTenantRow,
  ctx: ResetContext,
): Promise<Result<{ cleared: DemoCounts; added: DemoCounts; invoicesSkipped: string | null }>> {
  const db = seederClient as unknown as DemoDb;
  const cleared = await clearDemoData(db);
  if (!cleared.ok) return { ok: false, error: cleared.error };
  const added = await addDemoData(db, {
    tenantId: demo.tenant_id, userId: demo.seeder_user_id, tenantStateCode: DEMO_STATE_CODE,
    today: ctx.today, stamp: ctx.stamp, newId: ctx.newId,
  });
  if (!added.ok) return { ok: false, error: added.error };
  if (added.already) return { ok: false, error: "Sample rows were still there after clearing — nothing added." };
  return { ok: true, cleared: cleared.counts, added: added.counts, invoicesSkipped: added.invoicesSkipped };
}
