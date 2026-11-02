import { createClient, createAdminClientFor } from "@/lib/supabase/server";
import { decryptTenantSecrets, sealTenantSecrets } from "@/lib/crypto/tenant-secrets";

type Db = ReturnType<typeof createAdminClientFor>;
type LooseError = { message: string } | null;
type LooseQuery = {
  select: (columns: string) => LooseQuery;
  eq: (column: string, value: string) => LooseQuery;
  maybeSingle: () => Promise<{ data: unknown; error: LooseError }>;
  upsert: (row: Record<string, unknown>, options: { onConflict: string }) => Promise<{ error: LooseError }>;
};
type LooseDb = { from: (table: string) => LooseQuery };

export interface LinkedInCaller { userId: string; tenantId: string; canManage: boolean; admin: Db }
export interface LinkedInConnection { token: string | null; expiresAt: string | null; organizationUrn: string | null; organizationName: string | null }
export interface LinkedInAdsCredentials { clientId: string; clientSecret: string }

export async function resolveLinkedInCaller(): Promise<LinkedInCaller | null> {
  const supabase = createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return null;
  const { data } = await supabase.from("users").select("tenant_id, role").eq("id", user.id).maybeSingle();
  const row = data as { tenant_id?: string | null; role?: string | null } | null;
  if (!row?.tenant_id) return null;
  return { userId: user.id, tenantId: row.tenant_id, canManage: row.role === "owner" || row.role === "manager", admin: createAdminClientFor(user.id) };
}

const COLS = "tenant_id, linkedin_access_token, linkedin_access_expires_at, linkedin_organization_urn, linkedin_organization_name";

export async function readLinkedInConnection(admin: Db, tenantId: string): Promise<LinkedInConnection> {
  const { data, error } = await admin.from("tenant_secrets").select(COLS).eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new Error("Could not read the LinkedIn connection.");
  const raw = data as Record<string, unknown> | null;
  if (!raw || raw.tenant_id !== tenantId) return { token: null, expiresAt: null, organizationUrn: null, organizationName: null };
  const row = decryptTenantSecrets(raw) as Record<string, unknown>;
  return {
    token: row.linkedin_access_token as string | null ?? null,
    expiresAt: row.linkedin_access_expires_at as string | null ?? null,
    organizationUrn: row.linkedin_organization_urn as string | null ?? null,
    organizationName: row.linkedin_organization_name as string | null ?? null,
  };
}

export async function saveLinkedInConnection(admin: Db, tenantId: string, userId: string, token: string, expiresAt: string | null): Promise<void> {
  const { row } = sealTenantSecrets({ tenant_id: tenantId, linkedin_access_token: token, linkedin_access_expires_at: expiresAt, linkedin_connected_at: new Date().toISOString(), linkedin_connected_by: userId });
  const { error } = await admin.from("tenant_secrets").upsert(row, { onConflict: "tenant_id" });
  if (error) throw new Error("Could not save the LinkedIn connection.");
}

export async function saveLinkedInOrganization(admin: Db, tenantId: string, urn: string, name: string | null): Promise<void> {
  const { error } = await admin.from("tenant_secrets").update({ linkedin_organization_urn: urn, linkedin_organization_name: name }).eq("tenant_id", tenantId);
  if (error) throw new Error("Could not save the LinkedIn Company Page.");
}

export async function clearLinkedInConnection(admin: Db, tenantId: string): Promise<void> {
  const { error } = await admin.from("tenant_secrets").update({ linkedin_access_token: null, linkedin_access_expires_at: null, linkedin_organization_urn: null, linkedin_organization_name: null, linkedin_connected_at: null, linkedin_connected_by: null }).eq("tenant_id", tenantId);
  if (error) throw new Error("Could not remove the LinkedIn connection.");
}

/** Per-workspace LinkedIn Advertising API keys. The secret is never returned to the browser. */
export async function readLinkedInAdsCredentials(admin: Db, tenantId: string): Promise<LinkedInAdsCredentials | null> {
  const { data, error } = await (admin as unknown as LooseDb).from("tenant_secrets").select("tenant_id, linkedin_ads_client_id, linkedin_ads_client_secret").eq("tenant_id", tenantId).maybeSingle();
  if (error) throw new Error("Could not read LinkedIn Ads setup.");
  const row = decryptTenantSecrets(data as Record<string, unknown> | null) as Record<string, unknown> | null;
  const clientId = typeof row?.linkedin_ads_client_id === "string" ? row.linkedin_ads_client_id.trim() : "";
  const clientSecret = typeof row?.linkedin_ads_client_secret === "string" ? row.linkedin_ads_client_secret.trim() : "";
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

export async function saveLinkedInAdsCredentials(admin: Db, tenantId: string, clientId: string, clientSecret: string): Promise<void> {
  const { row } = sealTenantSecrets({ tenant_id: tenantId, linkedin_ads_client_id: clientId.trim(), linkedin_ads_client_secret: clientSecret.trim() });
  const { error } = await (admin as unknown as LooseDb).from("tenant_secrets").upsert(row, { onConflict: "tenant_id" });
  if (error) throw new Error("Could not save LinkedIn Ads setup.");
}
