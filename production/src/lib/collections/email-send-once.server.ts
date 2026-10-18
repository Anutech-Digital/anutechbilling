/**
 * R-1544 — one press of Send = one email to the customer, however often the browser retries.
 * Used by POST /api/collections/reminder/email and POST /api/customers/{id}/pending-dues/email.
 *
 * The dialog makes a requestId (uuid) when it opens. Before sending, the route CLAIMS it in
 * customer_email_sends (unique tenant_id + request_id) — the same claim-before-send as R-1538's
 * lib/invoices/dunning-send.server.ts:
 *   • first request  → row 'sending' → go and send;
 *   • a retry finds  'sent'    → the first answer again, nothing sent ("already sent");
 *                    'sending' → 409, nothing sent (the first one is still on its way, or its
 *                                 result was never recorded — it may have reached the customer);
 *                    'failed'  → re-claimed (failed → sending; only one retry wins) and sent.
 *   • then settleEmailSend writes 'sent' / 'failed'. If that write fails the row stays 'sending'
 *     and is never sent again — a missing record never becomes a second email.
 * Runs on the caller's session: RLS (tenant + customer visibility, created_by = me) applies.
 */
import type { createClient } from "@/lib/supabase/server";
import { RouteError } from "@/lib/api/with-route";

type Db = ReturnType<typeof createClient>;

export type CustomerEmailKind = "payment_reminder" | "pending_dues_statement";

export type EmailSendClaim =
  | { go: true; claimId: string }
  | { go: false; sentTo: string | null; followupId: string | null };

export const STILL_SENDING =
  "This email is already on its way (or its result was not recorded) — it was NOT sent again. " +
  "Wait a minute, reload the page and check the customer's follow-up history before sending a new one.";

const NOT_RECORDED =
  "Nothing was sent — the app could not note the email before sending it. Press Send again.";

interface SendRow {
  id: string;
  status: string;
  customer_id: string;
  kind: string;
  sent_to: string | null;
  followup_id: string | null;
}

export async function claimEmailSend(
  supabase: Db,
  opts: { tenantId: string; requestId: string; customerId: string; kind: CustomerEmailKind },
): Promise<EmailSendClaim> {
  const { data, error } = await supabase
    .from("customer_email_sends")
    .insert({ tenant_id: opts.tenantId, request_id: opts.requestId, customer_id: opts.customerId, kind: opts.kind, status: "sending" })
    .select("id")
    .single();
  if (!error && data) return { go: true, claimId: (data as { id: string }).id };
  if (error?.code !== "23505") throw new RouteError(500, NOT_RECORDED, error ? `${error.code} ${error.message}` : "no row");

  // Someone already pressed Send with this requestId — this is a retry.
  const { data: had, error: readErr } = await supabase
    .from("customer_email_sends")
    .select("id, status, customer_id, kind, sent_to, followup_id")
    .eq("tenant_id", opts.tenantId)
    .eq("request_id", opts.requestId)
    .maybeSingle();
  if (readErr || !had) throw new RouteError(409, STILL_SENDING, readErr?.message);
  const row = had as SendRow;
  if (row.customer_id !== opts.customerId || row.kind !== opts.kind) {
    throw new RouteError(409, "This Send was already used for another email — close the dialog, open it again and send.");
  }
  if (row.status === "sent") return { go: false, sentTo: row.sent_to, followupId: row.followup_id };
  if (row.status === "failed") {
    const { data: reclaimed, error: upErr } = await supabase
      .from("customer_email_sends")
      .update({ status: "sending", updated_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("status", "failed")
      .select("id");
    if (!upErr && Array.isArray(reclaimed) && reclaimed.length === 1) return { go: true, claimId: row.id };
  }
  throw new RouteError(409, STILL_SENDING);
}

/** Record what happened. Never throws: a lost write leaves 'sending', which is never re-sent. */
export async function settleEmailSend(
  supabase: Db,
  claimId: string,
  outcome: { status: "sent"; sentTo: string; followupId?: string | null } | { status: "failed" },
): Promise<void> {
  const patch = outcome.status === "sent"
    ? { status: "sent", sent_to: outcome.sentTo, followup_id: outcome.followupId ?? null, updated_at: new Date().toISOString() }
    : { status: "failed", updated_at: new Date().toISOString() };
  try {
    const { error } = await supabase.from("customer_email_sends").update(patch).eq("id", claimId);
    if (error) console.error(`[email-send-once] could not record ${outcome.status} for ${claimId}:`, error.message);
  } catch (e) {
    console.error(`[email-send-once] could not record ${outcome.status} for ${claimId}:`, e);
  }
}
