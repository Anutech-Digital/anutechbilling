/**
 * R-2433 (G-NETWORK N1) — browser calls for Settings → Network.
 *
 * Every call is a SECURITY DEFINER function that checks the caller's company, role (owner for
 * any change) and the connection itself; the tenant_connections table has no grant to the
 * browser at all. The functions are newer than the generated Database types, so they are
 * called through a narrow untyped rpc (same shape as zoho-bulk-reconcile.tsx).
 */
import { createClient } from "@/lib/supabase/client";
import { cleanScopes, type NetworkScope } from "./scopes";
import { toOwnership, type GstinOwnership } from "./ownership";

type Rpc = (fn: string, args?: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string } | null }>;

function rpc(): Rpc {
  const c = createClient() as unknown as { rpc: Rpc };
  return (fn, args) => c.rpc(fn, args);
}

export interface NetworkConnection {
  id: string;
  otherTenantId: string;
  otherName: string;
  otherGstin: string | null;
  status: "requested" | "accepted" | "rejected" | "revoked";
  direction: "sent" | "received";
  myScopes: NetworkScope[];
  theirScopes: NetworkScope[];
  relatedParty: boolean;
  origin: "request" | "parent_link";
  requestedAt: string;
  respondedAt: string | null;
  revokedAt: string | null;
  revokedByMe: boolean;
  /** R-2445: the other side still holds the GSTIN it PROVED it owns — needed to accept / share. */
  otherOwnerVerified: boolean;
}

export interface NetworkSuggestion {
  tenantId: string;
  tenantName: string;
  gstin: string;
  matchedAs: "customer" | "vendor";
  matchedName: string;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => (v == null ? null : String(v));

export function toConnection(r: Row): NetworkConnection {
  return {
    id: String(r.id),
    otherTenantId: String(r.other_tenant_id),
    otherName: String(r.other_name ?? ""),
    otherGstin: str(r.other_gstin),
    status: r.status as NetworkConnection["status"],
    direction: r.direction === "received" ? "received" : "sent",
    myScopes: cleanScopes(r.my_scopes as string[] | null),
    theirScopes: cleanScopes(r.their_scopes as string[] | null),
    relatedParty: Boolean(r.related_party),
    origin: r.origin === "parent_link" ? "parent_link" : "request",
    requestedAt: String(r.requested_at),
    respondedAt: str(r.responded_at),
    revokedAt: str(r.revoked_at),
    revokedByMe: Boolean(r.revoked_by_me),
    otherOwnerVerified: Boolean(r.other_owner_verified),
  };
}

export function toSuggestion(r: Row): NetworkSuggestion {
  return {
    tenantId: String(r.tenant_id),
    tenantName: String(r.tenant_name ?? ""),
    gstin: String(r.gstin ?? ""),
    matchedAs: r.matched_as === "vendor" ? "vendor" : "customer",
    matchedName: String(r.matched_name ?? ""),
  };
}

async function call(fn: string, args?: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await rpc()(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

export async function listConnections(): Promise<NetworkConnection[]> {
  return ((await call("network_my_connections")) as Row[] | null ?? []).map(toConnection);
}

export async function listSuggestions(): Promise<NetworkSuggestion[]> {
  return ((await call("network_suggestions")) as Row[] | null ?? []).map(toSuggestion);
}

export async function requestConnection(gstin: string, scopes: NetworkScope[], relatedParty: boolean): Promise<string> {
  return String(await call("network_request_connection", { p_gstin: gstin, p_scopes: scopes, p_related_party: relatedParty }));
}

export async function respondConnection(id: string, accept: boolean, scopes: NetworkScope[]): Promise<string> {
  return String(await call("network_respond_connection", { p_id: id, p_accept: accept, p_scopes: scopes }));
}

export async function revokeConnection(id: string): Promise<string> {
  return String(await call("network_revoke_connection", { p_id: id }));
}

export async function setMyScopes(id: string, scopes: NetworkScope[]): Promise<NetworkScope[]> {
  return cleanScopes((await call("network_set_my_scopes", { p_id: id, p_scopes: scopes })) as string[] | null);
}

/** R-2445: my company's GSTIN ownership status (owner / manager / accountant; null for other roles). */
export async function getMyGstinOwnership(): Promise<GstinOwnership | null> {
  const rows = (await call("network_my_gstin_ownership")) as Row[] | null;
  return rows?.[0] ? toOwnership(rows[0]) : null;
}

/** R-2445: ask ResellerOS to confirm we own our GSTIN (owner only). */
export async function claimGstinOwnership(note: string): Promise<string> {
  return String(await call("network_claim_gstin_ownership", { p_note: note }));
}
