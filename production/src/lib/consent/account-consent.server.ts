/**
 * R-2113 / GP-03 (30 Oct 2026, G-PERSONAL): a person's ACCOUNT consent, kept as proof in
 * public.consent_events (insert-only; migration 20261030033952_gp03_consent_account).
 *
 * - recordAccountConsent: one row per purpose (account_terms, personal_finance_processing,
 *   marketing) for the user, with the notice version. Password signup calls it before the
 *   workspace exists → tenant_id null.
 * - attachConsentTenant: at the verify step, fills tenant_id on that user's rows that have none.
 *   The DB lets ONLY this change through (and the FK's ON DELETE SET NULL on tenant erasure).
 *
 * The IP is kept only as the same keyed HMAC the cookie banner uses (record.server.ts hashIp).
 * Neither helper throws: a lost record is logged and reported as `false` so the caller decides.
 * Whether the proof is kept or deleted when the ACCOUNT is erased is the owner's decision (card
 * R-2113 needsDecision) — nothing here deletes it.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/security/rate-limit";
import { hashIp, type ConsentSource } from "@/app/api/public/consent/record.server";

export const ACCOUNT_CONSENT_PURPOSES = ["account_terms", "personal_finance_processing", "marketing"] as const;
export type AccountConsentPurpose = (typeof ACCOUNT_CONSENT_PURPOSES)[number];
/** A bare purpose means "granted"; marketing is optional, so it can be recorded as declined. */
export type AccountConsentChoice = AccountConsentPurpose | { purpose: AccountConsentPurpose; granted: boolean };

export interface AccountConsentRow {
  tenant_id: string | null;
  user_id: string;
  anon_id: null;
  lead_id: null;
  quote_id: null;
  purpose: AccountConsentPurpose;
  choice: "granted" | "denied";
  notice_version: string;
  source: Extract<ConsentSource, "signup" | "upgrade">;
  page: string | null;
  ip_hash: string | null;
  user_agent: string | null;
}

type Admin = ReturnType<typeof createAdminClient>;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID_RE.test(v);
const isPurpose = (v: unknown): v is AccountConsentPurpose =>
  typeof v === "string" && (ACCOUNT_CONSENT_PURPOSES as readonly string[]).includes(v);

/** Pure: the rows to insert. Any bad input → [] (no half-proof). */
export function accountConsentRows(input: {
  userId: string; tenantId: string | null; purposes: readonly AccountConsentChoice[]; version: string;
  source?: "signup" | "upgrade"; page?: string | null; ip: string | null; userAgent: string | null; secret?: string;
}): AccountConsentRow[] {
  const version = (input.version ?? "").trim();
  if (!isUuid(input.userId) || !version || version.length > 40 || input.purposes.length === 0) return [];
  if (input.tenantId !== null && !isUuid(input.tenantId)) return [];
  const choices = input.purposes.map((p) => (typeof p === "string" ? { purpose: p, granted: true } : p));
  if (!choices.every((c) => isPurpose(c.purpose))) return [];
  const ipHash = hashIp(input.ip, input.secret);
  const page = input.page ? input.page.slice(0, 200) : null;
  const userAgent = input.userAgent ? input.userAgent.slice(0, 400) : null;
  return choices.map((c) => ({
    tenant_id: input.tenantId ? input.tenantId.toLowerCase() : null,
    user_id: input.userId.toLowerCase(),
    anon_id: null,
    lead_id: null,
    quote_id: null,
    purpose: c.purpose,
    choice: c.granted ? "granted" : "denied",
    notice_version: version,
    source: input.source ?? "signup",
    page,
    ip_hash: ipHash,
    user_agent: userAgent,
  }));
}

/** Write the account consent rows. Never throws; false = nothing recorded (logged). */
export async function recordAccountConsent(
  admin: Admin,
  input: {
    userId: string; tenantId: string | null; purposes: readonly AccountConsentChoice[]; version: string;
    req: Request; source?: "signup" | "upgrade"; page?: string | null;
  },
): Promise<boolean> {
  try {
    const ip = clientIp(input.req.headers);
    const rows = accountConsentRows({
      userId: input.userId, tenantId: input.tenantId, purposes: input.purposes, version: input.version,
      source: input.source, page: input.page ?? null,
      ip: ip === "unknown" ? null : ip, userAgent: input.req.headers.get("user-agent"),
    });
    if (rows.length === 0) {
      console.error("[consent] account consent not recorded: bad input");
      return false;
    }
    /* consent_events is not in database.generated.ts yet (that file is behind the migrations). */
    const { error } = await admin.from("consent_events" as never).insert(rows as never);
    if (error) {
      console.error("[consent] account consent failed:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[consent] account consent failed:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Verify step: give this user's tenant-less consent rows their workspace. Never throws. */
export async function attachConsentTenant(admin: Admin, userId: string, tenantId: string): Promise<boolean> {
  if (!isUuid(userId) || !isUuid(tenantId)) return false;
  try {
    const { error } = await admin
      .from("consent_events" as never)
      .update({ tenant_id: tenantId.toLowerCase() } as never)
      .eq("user_id" as never, userId.toLowerCase() as never)
      .is("tenant_id" as never, null as never);
    if (error) {
      console.error("[consent] attach tenant failed:", error.message);
      return false;
    }
    return true;
  } catch (e) {
    console.error("[consent] attach tenant failed:", e instanceof Error ? e.message : e);
    return false;
  }
}
