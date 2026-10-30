/**
 * R-2119 (GP-05, goal G-PERSONAL): create a person's free PERSONAL workspace — only after the
 * email is verified — from either door:
 *
 *   password  POST /api/auth/signup kind 'personal' makes only the login + consent proof
 *             (tenant null); POST /api/auth/verify-email then calls createPersonalWorkspace +
 *             finishPersonalWorkspace.
 *   Google    POST /api/auth/onboarding/new-tenant kind 'personal' (signed in, email confirmed).
 *
 * The tenant is workspace_kind 'personal', named after the person, with NO GSTIN / state /
 * business type and NO domain claim (a personal account never routes colleagues anywhere). The
 * users row has role 'personal'. Both are written with the ADMIN client: the R-720 guard
 * (r720_tenants_column_guard, GP-01) refuses a non-default workspace_kind from any session /
 * app_runtime client, so this cannot be done from a browser.
 *
 * Rollback (same order as signup/route.ts): a failed users insert deletes the tenant just made,
 * so no ownerless tenant is left. users.id is the primary key, so two racing requests for the
 * same login create one workspace — the loser's tenant is rolled back.
 *
 * finishPersonalWorkspace = attachConsentTenant (GP-03) + link_personal_identity (GP-16a, D4:
 * Anutech individual customer + DMS panel account + Free support desk). Both are best-effort and
 * idempotent: the workspace stands even if one of them fails (logged; a retry is safe).
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { initials } from "@/lib/utils";
import { attachConsentTenant, type AccountConsentChoice } from "@/lib/consent/account-consent.server";
import { linkPersonalIdentity, type IdentityLinkResult } from "@/lib/personal/identity-link.server";

type Admin = ReturnType<typeof createAdminClient>;

/** Version of the personal signup notice (Terms + Privacy + financial-records processing). */
export const PERSONAL_CONSENT_VERSION = "2026-10-30";

/** The consent rows a personal signup records: the two required purposes, marketing as chosen. */
export function personalConsentChoices(marketing: boolean): AccountConsentChoice[] {
  return ["account_terms", "personal_finance_processing", { purpose: "marketing", granted: marketing === true }];
}

export type PersonalWorkspaceResult =
  | { ok: true; created: true; tenantId: string }
  | { ok: true; created: false; tenantId: string; role: string | null }
  | { ok: false; code: "tenant_failed" | "user_failed"; error: string };

/** The tenant row of a personal workspace. Pure. */
export function personalTenantRow(input: { tenantId: string; fullName: string; email: string }) {
  return {
    id: input.tenantId,
    name: input.fullName,
    email: input.email,
    gstin: null,
    business_type: null,
    workspace_kind: "personal" as const,
  };
}

/** Display name for a person: the name they gave, else the mailbox part of the email. */
export function personalName(fullName: string | null | undefined, email: string): string {
  const n = (fullName ?? "").trim();
  return n || email.split("@")[0] || "Me";
}

export async function createPersonalWorkspace(
  admin: Admin,
  input: { userId: string; email: string; fullName: string },
): Promise<PersonalWorkspaceResult> {
  // Already in a workspace (personal or business)? Never a second one.
  const { data: existing } = await admin
    .from("users")
    .select("tenant_id, role")
    .eq("id", input.userId)
    .maybeSingle();
  const ex = existing as { tenant_id: string | null; role: string | null } | null;
  if (ex?.tenant_id) return { ok: true, created: false, tenantId: ex.tenant_id, role: ex.role };

  const tenantId = crypto.randomUUID();
  /* workspace_kind / business_type are newer than the generated types, so the row is built first. */
  const { error: tenantErr } = await admin.from("tenants").insert(personalTenantRow({ tenantId, fullName: input.fullName, email: input.email }) as never);
  if (tenantErr) {
    console.error("[personal-workspace] tenant insert failed:", tenantErr.message);
    return { ok: false, code: "tenant_failed", error: tenantErr.message };
  }

  const { error: userErr } = await admin.from("users").insert({
    id: input.userId,
    tenant_id: tenantId,
    email: input.email,
    full_name: input.fullName,
    initials: initials(input.fullName),
    role: "personal",
    color: "amber",
  } as never);
  if (userErr) {
    await admin.from("tenants").delete().eq("id", tenantId);
    console.error("[personal-workspace] users insert failed:", userErr.message);
    return { ok: false, code: "user_failed", error: userErr.message };
  }
  return { ok: true, created: true, tenantId };
}

export interface FinishResult { consentAttached: boolean; link: IdentityLinkResult | null }

/** After the workspace exists: give the consent proof its tenant, and link the identity (D4). */
export async function finishPersonalWorkspace(admin: Admin, userId: string, tenantId: string): Promise<FinishResult> {
  const consentAttached = await attachConsentTenant(admin, userId, tenantId);
  let link: IdentityLinkResult | null = null;
  try {
    link = await linkPersonalIdentity(userId, tenantId);
    if (!link.ok) console.warn("[personal-workspace] identity link not made:", link.code, link.error);
  } catch (e) {
    console.warn("[personal-workspace] identity link failed:", e instanceof Error ? e.message : e);
  }
  return { consentAttached, link };
}
