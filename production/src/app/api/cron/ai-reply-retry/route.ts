/**
 * Cron: answer the customers the agent could not answer.
 *
 * ─── THE SILENCE THIS EXISTS FOR ────────────────────────────────────────────
 * 30 Aug 2026, 19:47. A 30-seat quote had been drafted and correctly held, because the
 * mail had not said monthly or annual and the price would have been an assumption. The app
 * asked which. The customer answered "monthly" — the exact word the flow was waiting for —
 * and the reply died:
 *
 *   reply.send / failed — "Gemini ne 15 second me jawab nahi diya, dobara koshish ke baad bhi"
 *
 * A timeout. The webhook had returned; nothing looked at that lead again. Somebody who did
 * what he was asked got silence, and a finished quote sat unsent. The next call minutes
 * later would have worked. There was simply nobody to make it.
 *
 * ─── THE QUEUE IS A QUERY, NOT A TABLE ──────────────────────────────────────
 * `ai_action_log` already records every failed `reply.send`, and `inbound_emails` already
 * holds the message. A lead needing a retry is one with a recent failure and no success
 * after it — so the queue clears itself the moment a reply lands, there is nothing to
 * migrate, and there is no second copy of the truth to drift from the first.
 *
 * Deliberately NOT `ai_sales_loops`, whose own rule is "the customer has written since this
 * was scheduled, so there is nothing to chase". A nudge is cancelled by a customer message;
 * a retry is caused by one. See lib/ai/reply-retry.ts.
 *
 * ─── IT SENDS NOTHING ITSELF ────────────────────────────────────────────────
 * It re-runs `runSalesAgentForLead`, which is the same path the webhook uses — so the
 * autonomy dial, the kill switch, the money guard and the promise guards all apply exactly
 * as they did the first time. A retry cannot say anything the original was not allowed to.
 */
import { NextResponse, type NextRequest } from "next/server";
import { createClient as createBareClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/lib/supabase/server";
import { timingSafeEqualStr } from "@/lib/crypto/timing-safe";
import { reportCron } from "@/lib/ops/cron-report";
import { fetchAllRows, fetchAllRowsIn, errorMessage } from "@/lib/ops/fetch-all";
import { shouldRetryReply, GIVE_UP_AFTER_HOURS, type RetryCandidate } from "@/lib/ai/reply-retry";
import { runSalesAgentForLead } from "@/lib/ai/run-sales-agent";
import { stripQuoted } from "@/lib/inbound/strip-quoted";
import { cronDbFailure } from "@/app/api/cron/_lib/db-failure";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const SELLER_NAME = process.env.SELLER_LEGAL_NAME?.trim() || "ANUTECH DIGITAL PVT LTD";
const FROM_EMAIL  = process.env.RESEND_FROM_DEFAULT?.trim() || "ResellerOS <onboarding@resend.dev>";

/**
 * How many leads to re-run in one pass.
 *
 * Each is a Gemini call on the tenant's own quota — the same quota the live inbound path
 * needs. A backlog is drained over several minutes rather than all at once, and whatever is
 * left is reported instead of being silently dropped.
 */
const MAX_PER_RUN = 5;

/** Stages a person drives. A retry here would talk over them. */
const HUMAN_STAGES = new Set(["won", "lost", "negotiation", "closed"]);

async function handle(req: NextRequest) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "cron not configured" }, { status: 503 });
  if (!timingSafeEqualStr(req.headers.get("authorization") ?? "", `Bearer ${secret}`)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const since = new Date(Date.now() - GIVE_UP_AFTER_HOURS * 3_600_000).toISOString();

  /* Every reply.send outcome in the window, both kinds. Read together so "did anything
     answer after the failure" is decided from one consistent picture.

     Untyped client for this one read: `ai_action_log` is missing from database.types.ts, so
     the typed client rejects it at compile time. Same shape lib/ai/autonomy.server.ts and
     the reflection cron already use — a generated types file being stale is not a reason to
     regenerate it in the middle of this. */
  const bare = createBareClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!.trim(), process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
    { auth: { persistSession: false, autoRefreshToken: false } },
  );
  /* WC-scale: paged (lib/ops/fetch-all.ts) — a busy day has more than PostgREST's 1000-row
     cap of reply.send events, and the newest ones (the ones that decide a retry) were the ones
     cut off. */
  let actions: { tenant_id: string; entity_id: string | null; outcome: string; created_at: string }[];
  try {
    actions = await fetchAllRows((from, to) => bare
    .from("ai_action_log")
    .select("tenant_id, entity_id, outcome, created_at")
    .eq("action", "reply.send")
    /* ── EVERY outcome, not a chosen two ─────────────────────────────────────
       This filtered `["failed", "did"]` and left `held` out, and that single omission
       produced a live loop within the hour: the agent handed lead L-MTFW5XKZ over every
       five minutes from 20:45 to 21:16, and none of those handovers was visible here, so
       the 19:47 failure stayed the newest event and the retry never stopped.

       Nothing was sent — a handover emails nobody — so it cost the tenant's Gemini quota
       rather than a customer's patience. An allow-list of outcomes is a bet that no third
       one matters; this is the bet losing. */
    .gte("created_at", since)
    .order("created_at", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  } catch (e) {
    return cronDbFailure("ai-reply-retry", e, errorMessage(e));
  }

  type Seen = { tenantId: string; failedAt: string | null; failures: number; resolvedAt: string | null };
  const byLead = new Map<string, Seen>();
  for (const a of actions) {
    if (!a.entity_id) continue;
    const s = byLead.get(a.entity_id) ?? { tenantId: a.tenant_id, failedAt: null, failures: 0, resolvedAt: null };
    if (a.outcome === "failed") {
      s.failedAt = a.created_at;
      /* Counted since the last conclusion, not for all time — a lead that failed twice last
         week and has worked since must not be treated as exhausted. */
      s.failures += 1;
    } else {
      /* ANY other outcome is a conclusion: `did` (a reply went out) and `held` (the agent
         deliberately fetched a person) both mean this message has been dealt with. Treating
         only `did` as a conclusion is what made the loop above. */
      s.resolvedAt = a.created_at;
      s.failures = 0;
    }
    byLead.set(a.entity_id, s);
  }

  const failing = [...byLead.entries()].filter(([, s]) => s.failedAt !== null);
  if (failing.length === 0) {
    return NextResponse.json(reportCron("ai-reply-retry", { ok: true, candidates: 0, retried: 0, failed: 0 }));
  }

  const leadIds = failing.map(([id]) => id);
  /* 200 lead ids a request, every page read (lib/ops/fetch-all.ts). */
  let leads: { id: string; tenant_id: string; stage: string | null; is_junk: boolean | null; contact_email: string | null }[];
  let mails: { lead_id: string | null; body_text: string | null; created_at: string; from_email: string | null }[];
  try {
    [leads, mails] = await Promise.all([
      fetchAllRowsIn(leadIds, (ids, from, to) => admin
        .from("leads").select("id, tenant_id, stage, is_junk, contact_email")
        .in("id", ids).order("id", { ascending: true }).range(from, to)),
      fetchAllRowsIn(leadIds, (ids, from, to) => admin.from("inbound_emails")
        .select("lead_id, body_text, created_at, from_email")
        .in("lead_id", ids).not("from_email", "is", null)
        .order("created_at", { ascending: false }).order("id", { ascending: false })
        .range(from, to)),
    ]);
  } catch (e) {
    return NextResponse.json({ error: errorMessage(e) }, { status: 500 });
  }

  const leadById = new Map(((leads ?? []) as { id: string; tenant_id: string; stage: string | null; is_junk: boolean | null; contact_email: string | null }[]).map((l) => [l.id, l]));
  /* Newest first from the query, so the FIRST hit per lead is the latest message — which is
     the one to answer, not the one that failed. If two arrived while we were down, the
     later one supersedes. */
  const latestMail = new Map<string, { body_text: string | null; created_at: string; from_email: string | null }>();
  for (const m of (mails ?? []) as { lead_id: string; body_text: string | null; created_at: string; from_email: string | null }[]) {
    if (!latestMail.has(m.lead_id)) latestMail.set(m.lead_id, m);
  }

  const nowISO = new Date().toISOString();
  const due: { leadId: string; tenantId: string; text: string; contact: string }[] = [];
  const skipped: Record<string, number> = {};

  for (const [leadId, s] of failing) {
    const lead = leadById.get(leadId);
    const mail = latestMail.get(leadId);
    const candidate: RetryCandidate = {
      leadId,
      failedAt: s.failedAt!,
      failures: s.failures,
      resolvedAt: s.resolvedAt,
      lastCustomerMessageAt: mail?.created_at ?? null,
      humanTookOver: Boolean(lead?.stage && HUMAN_STAGES.has(lead.stage)),
      isJunk: Boolean(lead?.is_junk),
    };
    const v = shouldRetryReply(candidate, nowISO);
    if (!v.retry) {
      skipped[v.reason] = (skipped[v.reason] ?? 0) + 1;
      continue;
    }
    const contact = mail?.from_email ?? lead?.contact_email ?? "";
    if (!lead || !mail || !contact) {
      skipped.missing_data = (skipped.missing_data ?? 0) + 1;
      continue;
    }
    due.push({
      leadId,
      tenantId: lead.tenant_id ?? s.tenantId,
      /* Quoted thread stripped, exactly as the inbound path does — otherwise the retry
         feeds our own previous message back to the agent as if the customer wrote it. */
      text: stripQuoted(mail.body_text ?? "").text || (mail.body_text ?? ""),
      contact,
    });
  }

  const batch = due.slice(0, MAX_PER_RUN);
  const deferred = due.length - batch.length;
  let retried = 0, failed = 0;
  const errors: string[] = [];

  for (const d of batch) {
    try {
      /* AWAITED, unlike the webhook's fire-and-forget. Nothing here is holding a customer's
         request open, and a cron that returns before its work finishes cannot report what
         happened — which is the failure mode this whole route exists to end. */
      await runSalesAgentForLead({
        admin, tenantId: d.tenantId, leadId: d.leadId,
        incoming: d.text,
        customerContact: d.contact,
        channel: "email",
        senderIsOurs: false,
        isSelfTest: false,
        fromEmail: FROM_EMAIL,
        sellerName: SELLER_NAME,
      });
      retried++;
    } catch (e) {
      failed++;
      errors.push(`${d.leadId}: ${(e as Error).message}`);
    }
  }

  return NextResponse.json(reportCron("ai-reply-retry", {
    ok: failed === 0,
    candidates: failing.length, retried, deferred, failed, skipped, errors,
  }));
}

export const GET = handle;
export const POST = handle;
