/**
 * R-1749 — who is asking, and this tenant's stored Zoho Books connection.
 *
 * Tenant isolation, fail-closed:
 *   - the tenant id ALWAYS comes from the signed-in user's own `users` row, never from the
 *     request (no tenant id is accepted from a browser anywhere in these routes);
 *   - every read and write of tenant_secrets below is filtered by that tenant id;
 *   - the database refuses cross-tenant reads by itself too (RLS owner-only of the same tenant,
 *     supabase/tests/zoho_books_connection_r1749.test.sql).
 * The refresh token is sealed (lib/crypto/tenant-secrets.ts) before it is stored and is opened
 * only here, server-side, right before a call to Zoho. No route returns it.
 */
import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { decryptTenantSecrets, sealTenantSecrets } from "@/lib/crypto/tenant-secrets";
import { canManageZohoBooks } from "./config";

type Db = ReturnType<typeof createAdminClientFor>;

export interface ZohoCaller {
  userId: string;
  tenantId: string;
  role: string;
  canManage: boolean;
  admin: Db;
}

/** The signed-in caller with their own tenant, or null (not signed in / no workspace). */
export async function resolveZohoCaller(): Promise<ZohoCaller | null> {
  const supabase = createClient();
  const { data } = await supabase.auth.getUser();
  const user = data?.user;
  if (!user) return null;
  const { data: me } = await supabase
    .from("users")
    .select("tenant_id, role")
    .eq("id", user.id)
    .maybeSingle();
  const row = me as { tenant_id?: string | null; role?: string | null } | null;
  if (!row?.tenant_id) return null;
  const role = row.role ?? "";
  return {
    userId: user.id,
    tenantId: row.tenant_id,
    role,
    canManage: canManageZohoBooks(role),
    admin: createAdminClientFor(user.id),
  };
}

export interface ZohoConnection {
  refreshToken: string | null;
  orgId: string | null;
  orgName: string | null;
  connectedAt: string | null;
}

const COLS = "tenant_id, zoho_books_refresh_token, zoho_books_org_id, zoho_books_org_name, zoho_books_connected_at";

/** This tenant's connection (token decrypted), or an empty one. */
export async function readConnection(admin: Db, tenantId: string): Promise<ZohoConnection> {
  const { data, error } = await admin.from("tenant_secrets").select(COLS).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new Error("Could not read the Zoho Books connection.");
  const raw = data as Record<string, unknown> | null;
  // Fail closed: a row that is not this tenant's is treated as no connection.
  if (!raw || raw.tenant_id !== tenantId) return { refreshToken: null, orgId: null, orgName: null, connectedAt: null };
  const row = decryptTenantSecrets(raw) as Record<string, unknown>;
  return {
    refreshToken: (row.zoho_books_refresh_token as string | null) ?? null,
    orgId: (row.zoho_books_org_id as string | null) ?? null,
    orgName: (row.zoho_books_org_name as string | null) ?? null,
    connectedAt: (row.zoho_books_connected_at as string | null) ?? null,
  };
}

/** Store a fresh connection (sealed token). The organization is chosen next, so it is cleared. */
export async function saveConnection(admin: Db, tenantId: string, userId: string, refreshToken: string): Promise<void> {
  const { row } = sealTenantSecrets({
    tenant_id: tenantId,
    zoho_books_refresh_token: refreshToken,
    zoho_books_org_id: null,
    zoho_books_org_name: null,
    zoho_books_connected_at: new Date().toISOString(),
    zoho_books_connected_by: userId,
  });
  const { error } = await admin.from("tenant_secrets").upsert(row, { onConflict: "tenant_id" });
  if (error) throw new Error("Could not save the Zoho Books connection.");
}

export async function saveOrganization(admin: Db, tenantId: string, org: { id: string; name: string }): Promise<void> {
  const { error } = await admin
    .from("tenant_secrets")
    .update({ zoho_books_org_id: org.id, zoho_books_org_name: org.name })
    .eq("tenant_id", tenantId);
  if (error) throw new Error("Could not save the Zoho Books organization.");
}

export async function clearConnection(admin: Db, tenantId: string): Promise<void> {
  const { error } = await admin
    .from("tenant_secrets")
    .update({
      zoho_books_refresh_token: null,
      zoho_books_org_id: null,
      zoho_books_org_name: null,
      zoho_books_connected_at: null,
      zoho_books_connected_by: null,
    })
    .eq("tenant_id", tenantId);
  if (error) throw new Error("Could not remove the Zoho Books connection.");
}
