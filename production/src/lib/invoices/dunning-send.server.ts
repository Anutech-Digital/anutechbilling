/**
 * R-1538 / R-1539 / R-1572 — one customer email of the dunning cron, logged truthfully and
 * never sent twice. Used by the reminder ladder (api/cron/invoice-dunning) and the pause
 * notice (lib/collections/overdue-suspension.server.ts).
 *
 *   no address / no message → one row 'no_recipient', nothing sent.
 *   otherwise:
 *     1. CLAIM  — insert the row as 'sending' FIRST. Insert failed → nothing is sent and the
 *                 caller is told (a send we cannot record would go again tomorrow).
 *     2. SEND   — through lib/messaging (the "Customer messages" switch, the dial, the provider).
 *     3. RESULT — update the row to what really happened: 'sent' only when the provider took
 *                 it; refused / provider error → 'failed' with the reason; practice → 'stubbed'.
 *                 Update failed → the row stays 'sending', which the cron treats as "may have
 *                 gone": never re-sent, never counted as delivered.
 */
import { randomUUID } from "node:crypto";
import type { createAdminClient } from "@/lib/supabase/server";
import { sendCustomerEmail } from "@/lib/messaging";
import { dunningOutcome, type DunningOutcome } from "@/lib/invoices/dunning-log-status";

type Admin = ReturnType<typeof createAdminClient>;

export interface DunningSendInput {
  tenantId: string;
  invoiceId: string;
  step: string;
  daysOverdue: number;
  actionTaken: string;
  to: string | null;
  message: { subject: string; text: string } | null;
  /** The autonomy gate, named at the call site (autonomy-chokepoint.test.ts reads the cron for it). */
  automated: { tenantId: string; action: "dunning.send" };
}

export interface DunningSendResult {
  outcome: DunningOutcome;
  /** A write to invoice_dunning_log failed — the run must report it. */
  logError: string | null;
}

function msgOf(e: unknown): string {
  return e && typeof e === "object" && "message" in e ? String((e as { message: unknown }).message) : String(e);
}

export async function sendDunningEmail(supabase: Admin, i: DunningSendInput): Promise<DunningSendResult> {
  const base = {
    tenant_id: i.tenantId, invoice_id: i.invoiceId, dunning_step: i.step,
    days_overdue: i.daysOverdue, action_taken: i.actionTaken,
    recipient_email: i.to, subject: i.message?.subject ?? null,
    /* Explicit, not the column default: the pause pass dates the notice from this. */
    sent_at: new Date().toISOString(),
  };

  if (!i.to?.trim() || !i.message) {
    const outcome = dunningOutcome({ recipient: i.to, hasMessage: Boolean(i.message), send: null });
    const { error } = await supabase.from("invoice_dunning_log").insert({ ...base, status: outcome.status, error_message: outcome.reason });
    return { outcome, logError: error ? msgOf(error) : null };
  }

  const id = randomUUID();
  const { error: claimErr } = await supabase.from("invoice_dunning_log").insert({ ...base, id, status: "sending", error_message: null });
  if (claimErr) {
    return {
      outcome: { status: "failed", reason: `not sent — could not record it first (${msgOf(claimErr)})`.slice(0, 500) },
      logError: msgOf(claimErr),
    };
  }

  let outcome: DunningOutcome;
  try {
    const r = await sendCustomerEmail({
      route: { tenantId: i.tenantId },
      to: i.to, subject: i.message.subject, text: i.message.text,
      kind: "invoice_dunning",
      automated: i.automated,
    });
    outcome = dunningOutcome({ recipient: i.to, hasMessage: true, send: r });
  } catch (e) {
    outcome = { status: "failed", reason: msgOf(e).slice(0, 500) };
  }

  const { error: updErr } = await supabase.from("invoice_dunning_log")
    .update({ status: outcome.status, error_message: outcome.reason })
    .eq("id", id);
  return {
    outcome,
    logError: updErr ? `result not recorded (row left 'sending', will not be re-sent): ${msgOf(updErr)}` : null,
  };
}
