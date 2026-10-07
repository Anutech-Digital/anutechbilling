/**
 * useCurrentUser — fetches the logged-in user + their tenant name.
 * Used by Sidebar and TopBar to show real names instead of hardcoded "Excel Technologies".
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { GstinVerification } from "@/lib/supabase/database.types";
import { isPlatformAdmin } from "@/lib/platform";
import { mustChangePassword } from "@/lib/auth/must-change-password";

export interface CurrentUserInfo {
  userId:        string;
  authEmail:     string;
  /** ResellerOS founder (cross-tenant signups panel). Server re-checks too. */
  isPlatformAdmin: boolean;
  /** R-391: an owner set a temporary password; the member must choose their own first.
   *  Optional so existing fixtures stay valid; absent = false. */
  mustChangePassword?: boolean;
  fullName:      string | null;
  initials:      string | null;
  color:         string | null;
  role:          string | null;
  /** Migration 0045 — sales-role extension flag. Owner/manager ignore this. */
  canViewDeals:  boolean;
  tenantId:      string;
  tenantName:    string;
  tenantLogoUrl: string | null;
  /** Tenant billing identity — used by Receipt Voucher / Invoice PDFs */
  tenantGstin:   string | null;
  tenantEmail:   string | null;
  tenantPhone:   string | null;
  tenantAddress: string | null;
  tenantPinCode: string | null;
  tenantState:   string | null;
  tenantStateCode: string | null;
  /** Owner / signing person on the GST invoice */
  tenantContactName: string | null;
  /** LUT number + validity for zero-rated exports (CGST Rule 96A). */
  tenantLutNumber: string | null;
  tenantLutValidUpto: string | null;
  tenantUpiVpa: string | null;
  tenantUpiPayeeName: string | null;
  /**
   * Remittance details printed on the invoice PDF (R-038, migration 20260930170000).
   * Publication data, not credentials — they go on every invoice this company sends,
   * which is why they sit on `tenants` and not in `tenant_secrets`.
   */
  tenantRemitBankName:      string | null;
  tenantRemitAccountName:   string | null;
  tenantRemitAccountNumber: string | null;
  tenantRemitIfsc:          string | null;
  tenantRemitBranch:        string | null;
  /** Days of buffer between renewal_date and auto-suspend (0–30). */
  tenantGracePeriodDays: number;
  /** When Setup Wizard's final step ran. NULL = wizard never completed. */
  tenantSetupCompletedAt: string | null;
  /** When the GSTIN was last verified against GSTN via 3rd-party API. */
  tenantGstinVerifiedAt: string | null;
  /** Cached verification payload (legal name, status, registration type, …). */
  tenantGstinVerification: GstinVerification | null;
}

/**
 * Who is at the keyboard — and, when nobody useful is, WHY.
 *
 * ─── WHY THIS EXISTS SEPARATELY FROM useCurrentUser ──────────────────────────
 * `useCurrentUser` returns `null` for three completely different situations: no
 * session, a session whose account has no `public.users` row, and a failed query.
 * Every consumer then renders the same `?? "Loading…"` fallback, so all three look
 * identical and look temporary — a spinner that never resolves.
 *
 * The second case is not hypothetical. On 14 Aug 2026 twelve auth accounts could
 * sign in and had no profile. Every one of them would land in the app, see
 * "Loading… / Workspace" forever, and have no way to learn that the fix is for an
 * owner to claim them on /team. An app that cannot say "I don't know who you are"
 * cannot tell you what to do about it.
 *
 * Kept as its own hook so `useCurrentUser`'s return type is unchanged and no
 * existing caller has to be touched.
 */
export type IdentityStatus = "loading" | "anonymous" | "stranded" | "member" | "error";

export function useIdentity(): { status: IdentityStatus; email: string | null } {
  const { data, isLoading, isError } = useCurrentUser();
  const auth = useQuery({
    queryKey: ["current-user", "auth-only"],
    queryFn: async (): Promise<{ email: string | null } | null> => {
      const { data: authData } = await createClient().auth.getUser();
      return authData?.user ? { email: authData.user.email ?? null } : null;
    },
    staleTime: 5 * 60_000,
    /* S16: only needed when there is NO profile to explain. With a profile the answer is
       "member" and this second auth.getUser round trip on every page was waste. */
    enabled: !isLoading && !data,
  });

  if (isLoading || auth.isLoading) return { status: "loading", email: null };
  if (data) return { status: "member", email: data.authEmail };
  /* A failed query is NOT "you have no workspace". Telling a signed-in owner they
   * are stranded because a request errored is precisely the lie that made the
   * PGRST201 bug so hard to see — it blamed the account instead of the request. */
  if (isError) return { status: "error", email: auth.data?.email ?? null };
  // Authenticated, but `useCurrentUser` found no profile → stranded, not anonymous.
  if (auth.data) return { status: "stranded", email: auth.data.email };
  return { status: "anonymous", email: null };
}

/**
 * The identity query's select list. Exported ONLY so a test can assert the one
 * thing about it that is easy to get wrong and impossible to notice.
 *
 * ─── `tenants!users_tenant_id_fkey`, NOT `tenants` ───────────────────────────
 * TWO foreign keys connect these tables, so a bare `tenants(…)` embed is
 * ambiguous and PostgREST answers HTTP 300 / PGRST201 instead of choosing:
 *
 *   users_tenant_id_fkey               users.tenant_id -> tenants.id      ← this one
 *   tenants_gmail_sender_user_id_fkey  tenants.gmail_sender_user_id -> users.id
 *
 * The second arrived with 0235 (per-tenant Gmail sender). Adding one column to
 * `tenants` silently broke identity for EVERY user: this query started failing,
 * the hook returned null, and the sidebar showed "Loading… / Workspace" forever —
 * which reads as a slow network, not as a broken query, so it went unnoticed and
 * contributed to the app "looking empty".
 *
 * Naming the constraint pins the meaning, and a third foreign key between these
 * tables cannot re-break it. Verified live by
 * `node scripts/check-embed-ambiguity.mjs`.
 */
/* One unbroken literal with `as const`, deliberately — supabase-js infers the row
 * shape from the select STRING at the type level, so splitting it across
 * concatenated pieces widens it to `string` and the whole result collapses to
 * GenericStringError. Long line, correct types. */
export const USER_WITH_TENANT_SELECT = "id, tenant_id, full_name, initials, color, role, can_view_deals, tenants!users_tenant_id_fkey(name, logo_url, gstin, email, phone, address, pin_code, contact_name, state, state_code, lut_number, lut_valid_upto, upi_vpa, upi_payee_name, remit_bank_name, remit_account_name, remit_account_number, remit_ifsc, remit_branch, grace_period_days, setup_completed_at, gstin_verified_at, gstin_verification)" as const;

export function useCurrentUser() {
  return useQuery({
    queryKey: ["current-user"],
    queryFn: async (): Promise<CurrentUserInfo | null> => {
      const supabase = createClient();

      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) return null;

      const { data: me, error } = await supabase
        .from("users")
        .select(USER_WITH_TENANT_SELECT)
        .eq("id", authData.user.id)
        .maybeSingle();

      /* THROW on a query error. Do not return null.
       *
       * `if (error || !me) return null` is what let the PGRST201 embed break every
       * user's identity in silence: a BROKEN QUERY and a MISSING ROW are not the
       * same fact, and collapsing them into null made the app say "you have no
       * workspace" when the truth was "this request failed". React Query surfaces
       * a thrown error as `isError`, retries it, and it reaches Sentry — none of
       * which happens for a quietly-returned null.
       *
       * PGRST116 ("no rows") is deliberately NOT an error here: `.maybeSingle()`
       * already reports that as `data: null`, which is the genuinely stranded
       * case — an authenticated account with no profile. That one must stay null,
       * because useIdentity() reads it to say "No workspace yet" instead of
       * pretending to load forever. */
      if (error) {
        console.error("[useCurrentUser] identity query failed:", error.code, error.message);
        throw error;
      }
      if (!me) return null;   // authenticated, but no profile → stranded

      const tenant = Array.isArray(me.tenants) ? me.tenants[0] : me.tenants;

      return {
        userId:          me.id,
        authEmail:       authData.user.email ?? "",
        isPlatformAdmin: isPlatformAdmin(authData.user.email),
        mustChangePassword: mustChangePassword(authData.user),
        fullName:        me.full_name,
        initials:        me.initials,
        color:           me.color,
        role:            me.role,
        canViewDeals:    Boolean(me.can_view_deals),
        tenantId:        me.tenant_id,
        tenantName:      tenant?.name ?? "Workspace",
        tenantLogoUrl:   (tenant as { logo_url?: string | null } | null)?.logo_url ?? null,
        tenantGstin:     tenant?.gstin     ?? null,
        tenantEmail:     tenant?.email     ?? null,
        tenantPhone:     tenant?.phone     ?? null,
        tenantAddress:   tenant?.address   ?? null,
        tenantPinCode:   tenant?.pin_code  ?? null,
        tenantState:     tenant?.state     ?? null,
        tenantStateCode: tenant?.state_code ?? null,
        tenantContactName: tenant?.contact_name ?? null,
        tenantLutNumber:    (tenant as { lut_number?: string | null } | null)?.lut_number ?? null,
        tenantLutValidUpto: (tenant as { lut_valid_upto?: string | null } | null)?.lut_valid_upto ?? null,
        tenantUpiVpa:       (tenant as { upi_vpa?: string | null } | null)?.upi_vpa ?? null,
        tenantUpiPayeeName: (tenant as { upi_payee_name?: string | null } | null)?.upi_payee_name ?? null,
        tenantRemitBankName:      tenant?.remit_bank_name      ?? null,
        tenantRemitAccountName:   tenant?.remit_account_name   ?? null,
        tenantRemitAccountNumber: tenant?.remit_account_number ?? null,
        tenantRemitIfsc:          tenant?.remit_ifsc           ?? null,
        tenantRemitBranch:        tenant?.remit_branch         ?? null,
        tenantGracePeriodDays: tenant?.grace_period_days ?? 0,
        tenantSetupCompletedAt: tenant?.setup_completed_at ?? null,
        tenantGstinVerifiedAt:  tenant?.gstin_verified_at  ?? null,
        tenantGstinVerification: (tenant?.gstin_verification as GstinVerification | null) ?? null,
      };
    },
    staleTime: 5 * 60_000,  // 5 min — identity rarely changes
  });
}
