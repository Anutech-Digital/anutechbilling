/**
 * R-2011 (1 Nov 2026, goal G-DPDP): the marketing opt-in, server side.
 *
 * - recordFormConsent: a website form was sent → ONE consent_events row for the new lead:
 *   purpose 'marketing', granted (box ticked) / denied (left empty — the notice was shown, no
 *   offers asked for), the notice version, source 'form' and which form. Never throws and never
 *   fails the order or enquiry: a lost record is logged.
 * - marketingConsentLeadIds: which of these leads may get offers — the LATEST marketing row per
 *   lead says 'granted'. No row (every lead from before R-2011) = no consent = not sent.
 *   WhatsApp broadcasts and email campaigns send only to these (card R-2011, no override).
 *
 * consent_events is insert-only (R-2010 / GP-03): a later "no" after a "yes" is a new row and
 * wins because it is newer.
 */
import type { createAdminClient } from "@/lib/supabase/server";
import { clientIp } from "@/lib/security/rate-limit";
import { hashIp } from "@/app/api/public/consent/record.server";
import { normaliseEmail } from "@/lib/marketing/unsubscribe-token";
import type { FormConsent } from "./data-notice";

type Admin = ReturnType<typeof createAdminClient>;
/* consent_events is not in database.generated.ts yet (that file is behind the migrations). */
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any

export const MARKETING_PURPOSE = "marketing";
const CHUNK = 200;

export interface FormConsentRow {
  tenant_id: string;
  lead_id: string;
  quote_id: string | null;
  anon_id: null;
  purpose: typeof MARKETING_PURPOSE;
  choice: "granted" | "denied";
  notice_version: string;
  source: "form";
  form: string;
  page: string | null;
  ip_hash: string | null;
  user_agent: string | null;
}

function pagePath(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    const u = new URL(raw, "https://x.invalid");
    return u.pathname.slice(0, 200) || null;
  } catch {
    return null;
  }
}

/** The row for one form send (pure — the tests pin its shape). */
export function formConsentRow(input: {
  tenantId: string; leadId: string; quoteId?: string | null; consent: FormConsent;
  page?: string | null; ip: string | null; userAgent: string | null; secret?: string;
}): FormConsentRow {
  return {
    tenant_id: input.tenantId,
    lead_id: input.leadId,
    quote_id: input.quoteId ?? null,
    anon_id: null,
    purpose: MARKETING_PURPOSE,
    choice: input.consent.marketing ? "granted" : "denied",
    notice_version: input.consent.noticeVersion.slice(0, 40),
    source: "form",
    form: input.consent.form,
    page: pagePath(input.page),
    ip_hash: hashIp(input.ip, input.secret),
    user_agent: input.userAgent ? input.userAgent.slice(0, 400) : null,
  };
}

/**
 * Record the form's notice + opt-in for the lead it created. `consent` null (an old page that sent
 * none) → nothing is recorded. Returns whether a row was written; never throws.
 */
export async function recordFormConsent(
  admin: Admin,
  input: { tenantId: string | null | undefined; leadId: string | null | undefined; quoteId?: string | null; consent: FormConsent | null; headers: Headers; page?: string | null },
): Promise<boolean> {
  try {
    if (!input.consent || !input.tenantId || !input.leadId) return false;
    const row = formConsentRow({
      tenantId: input.tenantId, leadId: input.leadId, quoteId: input.quoteId, consent: input.consent,
      page: input.page ?? input.headers.get("referer"),
      ip: clientIp(input.headers), userAgent: input.headers.get("user-agent"),
    });
    const { error } = await (admin as unknown as Loose).from("consent_events").insert(row);
    if (error) { console.error("[consent] form opt-in not recorded:", error.message); return false; }
    return true;
  } catch (e) {
    console.error("[consent] form opt-in not recorded:", e instanceof Error ? e.message : e);
    return false;
  }
}

/** Lead ids (of these) whose latest marketing consent is 'granted'. */
export async function marketingConsentLeadIds(admin: Admin, tenantId: string, leadIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(leadIds.filter(Boolean))];
  const latest = new Map<string, string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await (admin as unknown as Loose).from("consent_events")
      .select("lead_id, choice, created_at")
      .eq("tenant_id", tenantId).eq("purpose", MARKETING_PURPOSE)
      .in("lead_id", ids.slice(i, i + CHUNK))
      .order("created_at", { ascending: false });
    /* Unknown is never "yes": a failed read sends to nobody rather than to everybody. */
    if (error) throw new Error(`Could not read marketing consent: ${error.message}`);
    for (const r of (data ?? []) as { lead_id: string | null; choice: string }[]) {
      if (r.lead_id && !latest.has(r.lead_id)) latest.set(r.lead_id, r.choice);
    }
  }
  return new Set([...latest].filter(([, c]) => c === "granted").map(([id]) => id));
}

/**
 * Emails (of these) that belong to a lead of this tenant with marketing consent = yes — for the
 * hand-picked list of an email campaign, which carries addresses, not lead ids.
 */
export async function marketingConsentEmails(admin: Admin, tenantId: string, emails: readonly string[]): Promise<Set<string>> {
  /* The address as typed AND lower-cased: leads keep what the visitor typed. */
  const wanted = [...new Set(emails.flatMap((e) => [e.trim(), normaliseEmail(e)]).filter(Boolean))];
  const leadsByEmail = new Map<string, string[]>();
  for (let i = 0; i < wanted.length; i += CHUNK) {
    const part = wanted.slice(i, i + CHUNK);
    const { data, error } = await (admin as unknown as Loose).from("leads")
      .select("id, contact_email").eq("tenant_id", tenantId).in("contact_email", part);
    if (error) throw new Error(`Could not read leads for consent: ${error.message}`);
    for (const l of (data ?? []) as { id: string; contact_email: string | null }[]) {
      const e = normaliseEmail(l.contact_email ?? "");
      if (!e) continue;
      const have = leadsByEmail.get(e) ?? [];
      if (!have.includes(l.id)) leadsByEmail.set(e, [...have, l.id]);
    }
  }
  const allowed = await marketingConsentLeadIds(admin, tenantId, [...leadsByEmail.values()].flat());
  return new Set([...leadsByEmail].filter(([, ids]) => ids.some((id) => allowed.has(id))).map(([e]) => e));
}
