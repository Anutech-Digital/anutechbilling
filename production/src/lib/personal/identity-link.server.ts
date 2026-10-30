/**
 * R-2118 (GP-16a, goal G-PERSONAL) — link a verified personal login to Anutech.
 *
 * At a verified personal signup (decision D4) the person gets, together: ONE individual
 * customer in the website company (BUY_PAGE_TENANT_ID — gst_treatment consumer), a customer
 * panel (DMS) account request and a Free support desk. All of it is one atomic RPC,
 * `link_personal_identity` (migration 20261030053741_gp16a_personal_identity_link.sql), which
 * only service_role may run and which refuses an unconfirmed email itself — this wrapper adds
 * nothing to that check and must never be the only one.
 *
 * GP-05 calls this from BOTH signup doors (verify-email and the Google/Auth.js new-tenant
 * branch). It is idempotent: a second call returns `already_linked` and writes nothing.
 *
 * `needs_decision`: the email already belongs to a COMPANY customer of Anutech. What to do then
 * is the owner's open decision on R-2118 (link to it / separate individual / ask the person), so
 * nothing is created or queued yet; the login is remembered in personal_identity_link.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { websiteTenantId, WEBSITE_TENANT_MISSING_MESSAGE } from "@/lib/website-tenant";

export type IdentityLinkResult =
  | { ok: true; status: "linked"; customerId: string; customerCreated: boolean; panelQueued: boolean; supportQueued: boolean }
  | { ok: true; status: "already_linked"; customerId: string | null }
  | { ok: true; status: "needs_decision"; reason: "company_customer_email" }
  | { ok: false; code: "WEBSITE_TENANT_MISSING" | "EMAIL_NOT_CONFIRMED" | "NOT_PERSONAL" | "FAILED"; error: string };

interface RpcClient {
  rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: { message: string; code?: string } | null }>;
}

export interface IdentityLinkDeps {
  db?: RpcClient;
  env?: Record<string, string | undefined>;
}

type RpcRow = {
  status?: string;
  customer_id?: string | null;
  customer_created?: boolean;
  panel_queued?: boolean;
  support_queued?: boolean;
  reason?: string;
};

export async function linkPersonalIdentity(
  userId: string,
  personalTenantId: string,
  deps: IdentityLinkDeps = {},
): Promise<IdentityLinkResult> {
  const seller = websiteTenantId(deps.env ?? process.env);
  if (!seller) return { ok: false, code: "WEBSITE_TENANT_MISSING", error: WEBSITE_TENANT_MISSING_MESSAGE };

  /* The RPC is newer than the generated types (database.generated.ts). */
  const db = deps.db ?? (createAdminClient() as unknown as SupabaseClient as unknown as RpcClient);
  const { data, error } = await db.rpc("link_personal_identity", {
    p_user: userId,
    p_tenant: personalTenantId,
    p_seller_tenant: seller,
  });

  if (error) {
    const msg = error.message ?? "";
    if (/not confirmed/i.test(msg)) {
      return { ok: false, code: "EMAIL_NOT_CONFIRMED", error: "Confirm your email first — your account is linked once it is confirmed." };
    }
    if (/not a personal workspace|not a member/i.test(msg)) {
      return { ok: false, code: "NOT_PERSONAL", error: msg };
    }
    return { ok: false, code: "FAILED", error: msg || "Could not link the personal account." };
  }

  const row = (data ?? {}) as RpcRow;
  switch (row.status) {
    case "linked":
      return {
        ok: true,
        status: "linked",
        customerId: String(row.customer_id),
        customerCreated: row.customer_created === true,
        panelQueued: row.panel_queued === true,
        supportQueued: row.support_queued === true,
      };
    case "already_linked":
      return { ok: true, status: "already_linked", customerId: row.customer_id ?? null };
    case "needs_decision":
      return { ok: true, status: "needs_decision", reason: "company_customer_email" };
    default:
      return { ok: false, code: "FAILED", error: `Unexpected answer from link_personal_identity: ${JSON.stringify(data)}` };
  }
}
