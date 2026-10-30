/**
 * R-2010 (27 Oct 2026, G-DPDP): rows of public.consent_events — the server record of a
 * visitor's cookie choice (insert-only; the browser keeps its own copy in localStorage).
 *
 * The IP is never stored: only an HMAC of it, keyed from SECRETS_MASTER_KEY, so the same visitor
 * can be grouped without the address being recoverable (a bare sha256 of an IPv4 address can be
 * reversed by trying all 4 billion). No key on the server → no hash (null), never a weak one.
 */
import { createHmac } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/server";

export const CONSENT_PURPOSE_META = "meta_ads";
/** consent_events.source CHECK (R-2010 banner/checkout; GP-03 signup/upgrade for account consent). */
export type ConsentSource = "banner" | "checkout" | "signup" | "upgrade";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ConsentRow {
  tenant_id: string;
  anon_id: string;
  lead_id: string | null;
  quote_id: string | null;
  purpose: string;
  choice: "granted" | "denied";
  notice_version: string;
  source: Extract<ConsentSource, "banner" | "checkout">;
  page: string | null;
  ip_hash: string | null;
  user_agent: string | null;
}

export function hashIp(ip: string | null, secret: string = process.env.SECRETS_MASTER_KEY ?? ""): string | null {
  const key = secret.trim();
  if (!ip || ip === "unknown" || !key) return null;
  return createHmac("sha256", key).update(`consent-ip:v1:${ip}`).digest("hex");
}

export function isAnonId(v: unknown): v is string {
  return typeof v === "string" && UUID_RE.test(v);
}

/** The checkout's row: ties this browser's consent id to the lead + quote, with the choice in force. */
export function consentCheckoutRow(input: {
  tenantId: string; anonId: unknown; leadId: string; quoteId: string; metaConsent: boolean;
  ip: string | null; userAgent: string | null; secret?: string; noticeVersion?: string;
}): ConsentRow | null {
  if (!input.tenantId || !isAnonId(input.anonId)) return null;
  return {
    tenant_id: input.tenantId,
    anon_id: input.anonId.toLowerCase(),
    lead_id: input.leadId,
    quote_id: input.quoteId,
    purpose: CONSENT_PURPOSE_META,
    choice: input.metaConsent ? "granted" : "denied",
    notice_version: (input.noticeVersion ?? "checkout").slice(0, 40),
    source: "checkout",
    page: "/buy/workspace",
    ip_hash: hashIp(input.ip, input.secret),
    user_agent: input.userAgent ? input.userAgent.slice(0, 400) : null,
  };
}

/** Write the checkout row. Never throws and never fails the order — a lost record is logged. */
export async function recordCheckoutConsent(
  admin: ReturnType<typeof createAdminClient>,
  input: { tenantId: string; anonId: unknown; leadId: string; quoteId: string; metaConsent: boolean; ip: string | null; userAgent: string | null },
): Promise<void> {
  try {
    const row = consentCheckoutRow(input);
    if (!row) return;
    /* consent_events is not in database.generated.ts yet (that file is behind the migrations). */
    const { error } = await admin.from("consent_events" as never).insert(row as never);
    if (error) console.error("[consent] checkout link failed:", error.message);
  } catch (e) {
    console.error("[consent] checkout link failed:", e instanceof Error ? e.message : e);
  }
}
