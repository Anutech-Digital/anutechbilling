/**
 * AI support SLA sweep — closes tickets the customer never came back to, and shouts when an
 * escalated ticket is still nobody's.
 *
 * Schedule: every 15 minutes, via CLOUD SCHEDULER (scripts/setup-cloud-scheduler.sh). NOT
 * vercel.json — the live deployment is Cloud Run, where Vercel crons do not exist and that file
 * is inert.
 * Local dev: `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/cron/ai-support-sla`.
 *
 * ─── WHY 15 MINUTES AND NOT HOURLY ──────────────────────────────────────────
 * The auto-close is a 48-hour decision and would be happy with a daily run. The other half is a
 * THIRTY-MINUTE promise, and a sweep that runs hourly cannot keep it — the alert would land
 * anywhere between 30 and 90 minutes after the escalation, so the number in the alert would be a
 * fiction and the desk would learn to distrust it. The cheaper half sets the cadence.
 *
 * ─── THE BRAKE DOES NOT APPLY HERE, AND THAT IS DELIBERATE ──────────────────
 * Neither thing this cron does sends anything to a customer. Closing a ticket for silence is a
 * state change on our own row, and the breach alert goes to OUR OWN desk. The autonomy dial
 * exists to stop what the app sends OUT to other people and must never be able to silence what
 * the app says TO US — the same rule that removed `compliance.send` from the registry. A kill
 * switch that also muted "this ticket has waited 40 minutes" would turn one busy morning into a
 * customer discovering we never answered.
 */
import { reportCron } from "@/lib/ops/cron-report";
import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { sendEmail } from "@/lib/email/send";
import { loadOwnerAlert } from "@/lib/email/owner-alert.server";
import { localDateISO } from "@/lib/leads/outcomes";
import { lastCustomerMessageAt } from "@/lib/ai/support-agent.server";
import { shouldAlertUnassigned, shouldAutoClose } from "@/lib/ai/support-sla";
import { gatedCron, cronTenantAllowed } from "@/lib/automation/cron-gate";
import {
  closeTicketForSilence,
  loadEscalatedUnassigned,
  loadTicketsAwaitingReply,
  markSlaAlertSent,
  type SweepTicket,
} from "@/lib/ai/support-sla.server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Bounded so one run cannot become an unbounded fan-out of queries and mail. */
const MAX_PER_RUN = 100;

const FROM_EMAIL =
  process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";
const APP_URL = process.env.NEXT_PUBLIC_APP_URL?.trim() || "https://resellersos.web.app";

interface TicketOutcome {
  ticket_id: string;
  result: string;
}

interface CronResult {
  ran_at: string;
  /** IST calendar date this run belongs to. See the note at the call site. */
  ran_on: string;
  awaiting_reply_examined: number;
  closed: number;
  escalated_examined: number;
  alerted: number;
  failed: number;
  /** Every ticket that was NOT acted on, with the reason. See the note below. */
  skipped: number;
  outcomes: TicketOutcome[];
}

/* R-897: the automation gate runs FIRST — off → 200 {skipped:"off"}, nothing read or sent. */
const gated = gatedCron("ai-support-sla", handle);
export async function GET(req: Request) { return gated(req); }
export async function POST(req: Request) { return gated(req); }

async function handle(req: Request): Promise<NextResponse<CronResult | { error: string }>> {
  /* ── Auth — FAIL CLOSED ──────────────────────────────────────────────────
     503, not 401, when the secret is absent: "this deployment has no cron secret" is a
     missing-infrastructure fact for whoever is deploying, and reporting it as "unauthorized"
     sends them looking for a wrong credential instead of an unset one. Matches the eight
     existing crons. */
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  }
  const provided = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!timingSafeEqualStr(provided, expected)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  /* 503 as well, and for the same reason: with no service-role key both sweeps would read zero
     rows and report a clean run, which is an absence dressed as a success — AGENTS.md L38. */
  if (!process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()) {
    return NextResponse.json(
      {
        error:
          "SUPABASE_SERVICE_ROLE_KEY is not set — the support SLA sweep cannot read its own rows",
      },
      { status: 503 },
    );
  }

  const admin = createAdminClient();
  const now = new Date();

  const result: CronResult = {
    ran_at: now.toISOString(),
    /* The IST calendar date, from local date PARTS — never `toISOString().slice(0,10)`, which
       returns YESTERDAY for any moment before 05:30 IST (AGENTS.md §6). This sweep runs through
       the night, so half its runs would be filed against the wrong day. */
    ran_on: localDateISO(now),
    awaiting_reply_examined: 0,
    closed: 0,
    escalated_examined: 0,
    alerted: 0,
    failed: 0,
    skipped: 0,
    outcomes: [],
  };

  // ── 1. Close what the customer never came back to ──────────────────────
  const awaiting = await loadTicketsAwaitingReply(MAX_PER_RUN);
  result.awaiting_reply_examined = awaiting.length;

  for (const t of awaiting) {
    /* R-897 */ if (!cronTenantAllowed(t.tenantId)) continue;
    try {
      /* The transcript is read per ticket, and it is the query that stops the worst failure this
         sweep could have: closing a ticket underneath the customer's own reply. `shouldAutoClose`
         cannot know it, and `support_tickets.updated_at` cannot either — anybody editing the
         ticket touches that. */
      const facts: SweepTicket = {
        ...t,
        lastCustomerMessageAt: await lastCustomerMessageAt({
          tenantId: t.tenantId,
          ticketId: t.ticketId,
        }),
      };

      const verdict = shouldAutoClose(facts, now);
      if (!verdict.close) {
        result.skipped++;
        result.outcomes.push({ ticket_id: t.ticketId, result: `left open — ${verdict.detail}` });
        continue;
      }

      const closed = await closeTicketForSilence({
        tenantId: t.tenantId,
        ticketId: t.ticketId,
        detail: verdict.detail,
        now,
      });

      if (!closed.ok) {
        result.failed++;
        result.outcomes.push({ ticket_id: t.ticketId, result: `could not close — ${closed.error}` });
        continue;
      }

      result.closed++;
      result.outcomes.push({ ticket_id: t.ticketId, result: "closed — no reply in 48h" });
    } catch (err) {
      /* One bad ticket must not end the sweep. The rest of the queue is behind it, and a throw
         here would leave every one of them for the next run. */
      const why = err instanceof Error ? err.message : "unknown error";
      console.error(`[cron/ai-support-sla] ticket ${t.ticketId} crashed:`, err);
      result.failed++;
      result.outcomes.push({ ticket_id: t.ticketId, result: `crashed — ${why}` });
    }
  }

  // ── 2. Shout about escalations nobody has taken ────────────────────────
  const stranded = await loadEscalatedUnassigned(MAX_PER_RUN);
  result.escalated_examined = stranded.length;

  for (const t of stranded) {
    /* R-897 */ if (!cronTenantAllowed(t.tenantId)) continue;
    try {
      const verdict = shouldAlertUnassigned(t, now);
      if (!verdict.alert) {
        result.skipped++;
        result.outcomes.push({ ticket_id: t.ticketId, result: `no alert — ${verdict.detail}` });
        continue;
      }

      const sent = await alertDesk(admin, t, verdict.waitedMinutes, verdict.detail);
      if (!sent.ok) {
        /* NOT stamped. `sla_alert_sent_at` means "somebody was told", so writing it after a
           failed send would silence the alert forever on the strength of mail that never went —
           the L12 failure (a status field answering a different question from the one its name
           asks), applied to the field that decides whether anyone ever hears about this ticket.
           Left unstamped, the next sweep in 15 minutes tries again. */
        result.failed++;
        result.outcomes.push({
          ticket_id: t.ticketId,
          result: `alert NOT sent, will retry next run — ${sent.error}`,
        });
        continue;
      }

      const stamped = await markSlaAlertSent({ tenantId: t.tenantId, ticketId: t.ticketId, at: now });
      if (!stamped.ok) {
        /* The alert went and the stamp did not, so the next run will send a second one. Reported
           as a failure because a duplicate alert is a real cost — but a duplicate is the right
           side of this to fail on, and saying so here is what stops somebody "fixing" it by
           stamping first. */
        console.error(
          `[cron/ai-support-sla] alerted ${t.ticketId} but could not stamp it — ${stamped.error}. ` +
            "The next run will alert again.",
        );
        result.failed++;
        result.outcomes.push({
          ticket_id: t.ticketId,
          result: `alerted, but the stamp failed (${stamped.error}) — expect a duplicate`,
        });
        continue;
      }

      result.alerted++;
      result.outcomes.push({
        ticket_id: t.ticketId,
        result: `alerted — unassigned for ${verdict.waitedMinutes} min`,
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : "unknown error";
      console.error(`[cron/ai-support-sla] alert for ${t.ticketId} crashed:`, err);
      result.failed++;
      result.outcomes.push({ ticket_id: t.ticketId, result: `alert crashed — ${why}` });
    }
  }

  return NextResponse.json(reportCron("ai-support-sla", result));
}

/**
 * Tell the desk about one stranded ticket.
 *
 * One mail per ticket rather than a digest, deliberately: a digest is a report and this is an
 * interruption. The subject line carries the ticket, the customer and the wait, because that is
 * what somebody reads on a phone before deciding whether to open it.
 */
async function alertDesk(
  admin: ReturnType<typeof createAdminClient>,
  t: SweepTicket,
  waitedMinutes: number,
  detail: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { alert } = await loadOwnerAlert(admin, t.tenantId);
  if (!alert.ok) {
    /* A guessed address is never used — a settings hiccup must not turn into mail addressed to
       somebody else (lib/email/owner-alert.ts). Reported so the run does not read clean. */
    console.error(`[cron/ai-support-sla] no recipient for tenant ${t.tenantId} — ${alert.reason}`);
    return { ok: false, error: alert.reason };
  }

  const lines = [
    detail,
    "",
    `Ticket:    ${t.ticketId}`,
    `Customer:  ${t.customerName} <${t.raisedBy}>`,
    `Subject:   ${t.subject}`,
    `Channel:   ${t.channel ?? "not recorded"}`,
    `Priority:  ${t.priority}`,
    `Escalated: ${t.escalatedAt ? t.escalatedAt.toISOString() : "unknown"} (${waitedMinutes} min ago)`,
    "",
    "The customer has not been answered. Assign it or reply from the Support screen:",
    `${APP_URL}/support`,
  ];

  const res = await sendEmail({
    to: alert.to,
    from: FROM_EMAIL,
    subject: `[SLA] ${t.ticketId} unassigned ${waitedMinutes} min — ${t.customerName}`,
    text: lines.join("\n"),
    route: { tenantId: t.tenantId },
    kind: "ai_support_sla_breach",
    /* NOT marked `automated` — see the file header. This is mail to our own desk about our own
       queue, and the dial must not be able to silence it. */
  });

  if (res.status === "failed") {
    return { ok: false, error: res.errorMessage ?? "the send failed with no reason given" };
  }
  return { ok: true };
}
