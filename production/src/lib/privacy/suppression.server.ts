/**
 * R-2013 (DPDP): who must not get automated messages any more.
 *
 * A confirmed "withdraw my consent" request (privacy_request_verify) does two things in one
 * transaction: a consent_events 'withdrawn' row for each of the person's leads (R-2011's
 * broadcast / campaign filter then skips them) and the email in email_suppressions (the same
 * list the unsubscribe link writes). The crons that message people on their own — birthday
 * greetings and the AI sales follow-up — read these helpers before sending.
 *
 * Both FAIL CLOSED: a failed read throws, and the caller sends nothing.
 */
import "server-only";
import { normaliseEmail } from "@/lib/marketing/unsubscribe-token";
import type { createAdminClient } from "@/lib/supabase/server";

type Admin = ReturnType<typeof createAdminClient>;
type Loose = { from: (t: string) => any }; // eslint-disable-line @typescript-eslint/no-explicit-any
const CHUNK = 200;

export const suppressionKey = (tenantId: string, email: string) => `${tenantId}|${normaliseEmail(email)}`;

/** Keys (tenant|email) of these addresses that are on their company's suppression list. */
export async function suppressedEmailKeys(admin: Admin, pairs: readonly { tenantId: string; email: string | null }[]): Promise<Set<string>> {
  const wanted = new Set(pairs.filter((p) => p.email).map((p) => suppressionKey(p.tenantId, p.email!)));
  const emails = [...new Set([...wanted].map((k) => k.slice(k.indexOf("|") + 1)).filter(Boolean))];
  const out = new Set<string>();
  for (let i = 0; i < emails.length; i += CHUNK) {
    const { data, error } = await (admin as unknown as Loose).from("email_suppressions")
      .select("tenant_id, email").in("email", emails.slice(i, i + CHUNK));
    if (error) throw new Error(`Could not read the suppression list: ${error.message}`);
    for (const r of (data ?? []) as { tenant_id: string; email: string }[]) {
      const k = suppressionKey(r.tenant_id, r.email);
      if (wanted.has(k)) out.add(k);
    }
  }
  return out;
}

/** Lead ids (of these, in one company) whose newest marketing consent row is 'withdrawn'. */
export async function consentWithdrawnLeadIds(admin: Admin, tenantId: string, leadIds: readonly string[]): Promise<Set<string>> {
  const ids = [...new Set(leadIds.filter(Boolean))];
  const latest = new Map<string, string>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    const { data, error } = await (admin as unknown as Loose).from("consent_events")
      .select("lead_id, choice, created_at")
      .eq("tenant_id", tenantId).eq("purpose", "marketing")
      .in("lead_id", ids.slice(i, i + CHUNK))
      .order("created_at", { ascending: false });
    if (error) throw new Error(`Could not read consent: ${error.message}`);
    for (const r of (data ?? []) as { lead_id: string | null; choice: string }[]) {
      if (r.lead_id && !latest.has(r.lead_id)) latest.set(r.lead_id, r.choice);
    }
  }
  return new Set([...latest].filter(([, c]) => c === "withdrawn").map(([id]) => id));
}
