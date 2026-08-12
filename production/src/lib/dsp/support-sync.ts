/**
 * Drains support_sync_outbox (migration 0224) by POSTing each queued event to
 * DSP's existing webhook receiver (POST /api/sync/customer). The outbox is
 * populated by a DB trigger on subscriptions (vendor='support'), so this
 * function doesn't need to know which code path created/changed the
 * subscription — record_payment, a manual edit, the renewal cron, etc.
 *
 * Requires DSP_API_URL + DSP_WEBHOOK_SECRET — the secret must match DSP's own
 * admin_settings.billing_webhook_secret. Left unconfigured, this is a no-op
 * (nothing queues forever; rows just sit pending until configured).
 */
import { createAdminClient } from "@/lib/supabase/server";

const MAX_ATTEMPTS = 5;

export interface SupportSyncResult {
  skipped?: boolean;
  reason?: string;
  total?: number;
  sent?: number;
  failed?: number;
  errors?: { id: string; message: string }[];
}

export async function flushSupportSyncOutbox(limit = 25): Promise<SupportSyncResult> {
  const dspUrl = process.env.DSP_API_URL?.trim().replace(/\/$/, "");
  const secret = process.env.DSP_WEBHOOK_SECRET?.trim();
  if (!dspUrl || !secret) {
    return { skipped: true, reason: "DSP_API_URL or DSP_WEBHOOK_SECRET not configured" };
  }

  const supabase = createAdminClient();
  const { data: rows, error } = await supabase
    .from("support_sync_outbox")
    .select("id, payload, attempts")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) throw error;

  let sent = 0;
  let failed = 0;
  const errors: { id: string; message: string }[] = [];

  for (const row of rows ?? []) {
    try {
      const res = await fetch(`${dspUrl}/api/sync/customer`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-Webhook-Secret": secret },
        body: JSON.stringify(row.payload),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`DSP responded ${res.status}: ${text.slice(0, 200)}`);
      }
      await supabase
        .from("support_sync_outbox")
        .update({ status: "sent", sent_at: new Date().toISOString() })
        .eq("id", row.id);
      sent++;
    } catch (err) {
      const attempts = (row.attempts ?? 0) + 1;
      const message = (err as Error).message;
      await supabase
        .from("support_sync_outbox")
        .update({
          attempts,
          last_error: message,
          status: attempts >= MAX_ATTEMPTS ? "failed" : "pending",
        })
        .eq("id", row.id);
      failed++;
      errors.push({ id: row.id, message });
    }
  }

  return { total: rows?.length ?? 0, sent, failed, errors };
}
