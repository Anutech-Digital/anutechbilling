/**
 * Cold Calling (R-1661/R-1662) — reads, writes and the call runner.
 *
 * Every database touch goes through a `Run` the caller hands in: withTenant(session, …) for a
 * signed-in person (RLS: owner/manager/sales_senior/sales of that tenant), withJobsTenant(…)
 * for the cron (RLS: app_jobs, that tenant only). Nothing here can reach another tenant.
 *
 * Calls to Bolna are made OUTSIDE any transaction: a vendor that takes 15 s must not hold a
 * database connection, and a failed call must still leave its row written.
 */
import "server-only";
import type { Tx } from "@/server/db";
import { catalogueFromRows, type CatalogRow } from "@/lib/ai/sales-agent.server";
import { buildTelecallPrompt } from "@/lib/ai/telecaller-prompt";
import { resolveAutonomy } from "@/lib/ai/autonomy";
import { loadAutonomyPolicy } from "@/lib/ai/autonomy.server";
import { normalisePostCall } from "@/lib/telecall/inbound";
import { fetchBolnaExecution, placeCall, type TelecallProviderConfig } from "@/lib/telecall/provider";
import type { ItemPrices } from "@/lib/supabase/database.types";
import {
  canCallNow, istDayStart, outcomeFromCall, type CallingListRow, type ColdCallStatus,
} from "@/lib/coldcall/coldcall";

export type Run = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

export const COLD_CALL_ROLES = ["owner", "manager", "sales_senior", "sales"] as const;

/** The caller's role, or null when the user row is missing / inactive. */
export async function roleOf(run: Run, userId: string): Promise<string | null> {
  const u = await run((tx) => tx.public_users.findUnique({ where: { id: userId }, select: { role: true, is_active: true } }));
  return u && u.is_active !== false ? String(u.role) : null;
}

/* ── Campaigns ───────────────────────────────────────────────────────────── */

export interface CampaignSummary {
  id: string;
  name: string;
  agentId: string;
  agentName: string | null;
  status: string;
  dailyLimit: number;
  windowStart: number;
  windowEnd: number;
  createdAt: string;
  counts: Record<string, number>;
  calledToday: number;
}

export async function listCampaigns(run: Run, now: Date): Promise<CampaignSummary[]> {
  return run(async (tx) => {
    const campaigns = await tx.cold_call_campaigns.findMany({ orderBy: { created_at: "desc" }, take: 100 });
    if (campaigns.length === 0) return [];
    const ids = campaigns.map((c) => c.id);
    const grouped = await tx.cold_call_contacts.groupBy({
      by: ["campaign_id", "status"], where: { campaign_id: { in: ids } }, _count: { _all: true },
    });
    const today = await tx.cold_call_contacts.groupBy({
      by: ["campaign_id"], where: { campaign_id: { in: ids }, last_called_at: { gte: istDayStart(now) } }, _count: { _all: true },
    });
    return campaigns.map((c) => {
      const counts: Record<string, number> = {};
      for (const g of grouped) if (g.campaign_id === c.id) counts[g.status] = g._count._all;
      return {
        id: c.id, name: c.name, agentId: c.agent_id, agentName: c.agent_name, status: c.status,
        dailyLimit: c.daily_limit, windowStart: c.window_start, windowEnd: c.window_end,
        createdAt: c.created_at.toISOString(), counts,
        calledToday: today.find((t) => t.campaign_id === c.id)?._count._all ?? 0,
      };
    });
  });
}

export async function createCampaign(
  run: Run,
  input: { tenantId: string; userId: string; name: string; agentId: string; agentName: string | null; dailyLimit: number },
): Promise<string> {
  const row = await run((tx) => tx.cold_call_campaigns.create({
    data: {
      tenant_id: input.tenantId, created_by: input.userId, name: input.name.trim().slice(0, 120),
      agent_id: input.agentId, agent_name: input.agentName, daily_limit: input.dailyLimit,
    },
    select: { id: true },
  }));
  return row.id;
}

export async function updateCampaign(
  run: Run,
  id: string,
  patch: { status?: "running" | "paused" | "done"; dailyLimit?: number; agentId?: string; agentName?: string | null },
): Promise<boolean> {
  const r = await run((tx) => tx.cold_call_campaigns.updateMany({
    where: { id },
    data: {
      ...(patch.status ? { status: patch.status } : {}),
      ...(patch.dailyLimit ? { daily_limit: patch.dailyLimit } : {}),
      ...(patch.agentId ? { agent_id: patch.agentId, agent_name: patch.agentName ?? null } : {}),
      updated_at: new Date(),
    },
  }));
  return r.count === 1;
}

/* ── The list ────────────────────────────────────────────────────────────── */

/** Adds numbers to a campaign; a number already on it is skipped (unique campaign_id+phone). */
export async function importContacts(
  run: Run, tenantId: string, campaignId: string, rows: readonly CallingListRow[],
): Promise<{ added: number; dnd: number } | null> {
  return run(async (tx) => {
    const c = await tx.cold_call_campaigns.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!c) return null;
    const r = await tx.cold_call_contacts.createMany({
      data: rows.map((x) => ({
        tenant_id: tenantId, campaign_id: campaignId, phone: x.phone, name: x.name, company: x.company,
        city: x.city, dnd: x.dnd, status: x.dnd ? "skipped_dnd" : "pending",
      })),
      skipDuplicates: true,
    });
    return { added: r.count, dnd: rows.filter((x) => x.dnd).length };
  });
}

export interface ContactRow {
  id: string;
  name: string | null;
  company: string | null;
  city: string | null;
  phone: string;
  status: string;
  attempts: number;
  lastCalledAt: string | null;
  nextAttemptAt: string | null;
  durationSec: number | null;
  summary: string | null;
  transcript: string | null;
  seatsHeard: number | null;
  error: string | null;
  leadId: string | null;
}

export async function listContacts(run: Run, campaignId: string, status: string[] | null): Promise<ContactRow[]> {
  const rows = await run((tx) => tx.cold_call_contacts.findMany({
    where: { campaign_id: campaignId, ...(status ? { status: { in: status } } : {}) },
    orderBy: [{ updated_at: "desc" }],
    take: 500,
  }));
  return rows.map((r) => ({
    id: r.id, name: r.name, company: r.company, city: r.city, phone: r.phone, status: r.status,
    attempts: r.attempts, lastCalledAt: r.last_called_at?.toISOString() ?? null,
    nextAttemptAt: r.next_attempt_at?.toISOString() ?? null, durationSec: r.duration_sec,
    summary: r.summary, transcript: r.transcript, seatsHeard: r.seats_heard, error: r.error, leadId: r.lead_id,
  }));
}

/* ── Into the pipeline (a person pressed the button) ─────────────────────── */

export type MoveResult =
  | { ok: true; leadId: string }
  | { ok: false; status: number; error: string; leadId?: string };

/** Base-36 lead id in the app's existing L-XXXXXXXX shape, plus randomness against same-ms clicks. */
function newLeadId(): string {
  const rand = Math.floor(Math.random() * 36 ** 2).toString(36).padStart(2, "0");
  return `L-${Date.now().toString(36)}${rand}`.toUpperCase();
}

export async function moveToPipeline(run: Run, tenantId: string, userId: string, contactId: string): Promise<MoveResult> {
  return run(async (tx) => {
    const c = await tx.cold_call_contacts.findUnique({ where: { id: contactId } });
    if (!c) return { ok: false, status: 404, error: "That number is not on your list any more — refresh the page." };
    if (c.lead_id) return { ok: false, status: 409, error: "Already in Sales & Pipeline.", leadId: c.lead_id };

    const leadId = newLeadId();
    const company = c.company?.trim() || c.name?.trim() || c.phone;
    await tx.leads.create({
      data: {
        id: leadId, tenant_id: tenantId, company, contact_name: c.name, contact_phone: c.phone,
        stage: "contact", source: "tele-calling", owner_id: userId, created_by: userId,
        seats: c.seats_heard ?? undefined,
        notes: c.summary ? `AI cold call: ${c.summary}`.slice(0, 2000) : null,
      },
    });
    const detail = [
      "AI cold call (Cold Calling)",
      c.summary ? `Summary: ${c.summary}` : null,
      c.seats_heard ? `AI ne suna: ${c.seats_heard} seats` : null,
      c.transcript ? `Transcript:\n${c.transcript.slice(0, 4000)}` : null,
    ].filter(Boolean).join("\n");
    await tx.lead_activities.create({ data: { tenant_id: tenantId, lead_id: leadId, kind: "note", detail } });
    await tx.cold_call_contacts.update({
      where: { id: contactId },
      data: { status: "moved", lead_id: leadId, moved_at: new Date(), moved_by: userId, updated_at: new Date() },
    });
    return { ok: true, leadId };
  });
}

/* ── The runner (R-1662) ─────────────────────────────────────────────────── */

/** At most this many new calls per tick, so a tick stays short and calls go out one by one. */
export const CALLS_PER_TICK = 5;
/** At most this many in-flight calls read back from Bolna per tick. */
export const POLLS_PER_TICK = 20;

export interface TickReport {
  checked: number;
  finished: number;
  placed: number;
  failed: number;
  /** Why no new call went out, when none did — for the page and the cron log. */
  note: string | null;
}

async function loadCatalogue(tx: Tx): Promise<CatalogRow[]> {
  const items = await tx.items.findMany({
    where: { kind: "main", is_active: true, msrp: { gt: 0 } },
    select: { id: true, name: true, vendor: true, msrp: true, wholesale: true, prices: true },
    orderBy: { name: "asc" },
  });
  return items.map((i) => ({
    id: i.id, name: i.name, vendor: String(i.vendor), msrp: i.msrp, wholesale: i.wholesale,
    prices: (i.prices ?? null) as ItemPrices | null,
  }));
}

/**
 * One pass over one campaign: read finished calls back from Bolna, then place the next calls
 * if the campaign is running, inside its window, and under today's limit.
 */
export async function runCampaignTick(
  run: Run, tenantId: string, campaignId: string, config: TelecallProviderConfig, now: Date,
): Promise<TickReport> {
  const report: TickReport = { checked: 0, finished: 0, placed: 0, failed: 0, note: null };

  /* 1. Results. Bolna is asked directly, so this works where its webhook cannot reach. */
  const inFlight = await run((tx) => tx.cold_call_contacts.findMany({
    where: { campaign_id: campaignId, status: "calling", provider_call_id: { not: null } },
    select: { id: true, provider_call_id: true, attempts: true },
    take: POLLS_PER_TICK,
  }));
  for (const c of inFlight) {
    report.checked++;
    const got = await fetchBolnaExecution(config, c.provider_call_id as string);
    if (!got.ok) continue;
    const call = normalisePostCall(got.execution);
    if (!call) continue; // still ringing / in progress
    const outcome = outcomeFromCall(call.signals, c.attempts, now);
    await run((tx) => tx.cold_call_contacts.update({
      where: { id: c.id },
      data: {
        status: outcome.status, next_attempt_at: outcome.nextAttemptAt,
        call_status: call.signals.disposition, duration_sec: call.signals.durationSec,
        transcript: call.signals.transcript || null, summary: call.signals.summary || null,
        seats_heard: call.signals.seatsDiscussed,
        extracted: (got.execution.extracted_data ?? {}) as object,
        provider_call_id: outcome.status === "pending" ? null : c.provider_call_id,
        updated_at: now,
      },
    }));
    report.finished++;
  }

  /* 2. New calls. */
  const campaign = await run((tx) => tx.cold_call_campaigns.findUnique({ where: { id: campaignId } }));
  if (!campaign) return { ...report, note: "campaign not found" };
  if (campaign.status !== "running") return { ...report, note: "campaign is not running" };
  if (!canCallNow(now, campaign.window_start, campaign.window_end)) {
    return { ...report, note: `outside calling hours (Mon–Fri ${campaign.window_start}:00–${campaign.window_end}:00 IST)` };
  }

  /* The workspace AI kill switch outranks a running campaign. Starting the campaign is the
     person's approval for each call (as pressing "AI call" is), so "hold" does not stop it —
     "off" does. */
  const verdict = resolveAutonomy("telecall.place", await loadAutonomyPolicy(tenantId));
  if (verdict.mode === "off") return { ...report, note: `AI calls are switched off — ${verdict.reason}` };

  const calledToday = await run((tx) => tx.cold_call_contacts.count({
    where: { campaign_id: campaignId, last_called_at: { gte: istDayStart(now) } },
  }));
  const room = Math.min(CALLS_PER_TICK, campaign.daily_limit - calledToday);
  if (room <= 0) return { ...report, note: `today's limit of ${campaign.daily_limit} calls is reached` };

  const { due, catalogue, sellerName } = await run(async (tx) => {
    const rows = await tx.cold_call_contacts.findMany({
      where: {
        campaign_id: campaignId, status: "pending", dnd: false,
        OR: [{ next_attempt_at: null }, { next_attempt_at: { lte: now } }],
      },
      orderBy: { created_at: "asc" },
      take: room,
    });
    /* Claimed in the same transaction: a second tick running at the same moment sees them as
       "calling" and leaves them alone, so nobody is rung twice. */
    const claimed = await tx.cold_call_contacts.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, status: "pending" },
      data: { status: "calling", last_called_at: now, updated_at: now, error: null },
    });
    const tenant = await tx.tenants.findUnique({ where: { id: tenantId }, select: { name: true } });
    return {
      due: claimed.count === rows.length ? rows : [],
      catalogue: catalogueFromRows(await loadCatalogue(tx)),
      sellerName: tenant?.name?.trim() || "our team",
    };
  });

  if (due.length === 0) {
    const left = await run((tx) => tx.cold_call_contacts.count({
      where: { campaign_id: campaignId, status: { in: ["pending", "calling"] } },
    }));
    if (left === 0) {
      await run((tx) => tx.cold_call_campaigns.updateMany({ where: { id: campaignId, status: "running" }, data: { status: "done", updated_at: now } }));
      return { ...report, note: "every number on the list has been called" };
    }
    return { ...report, note: "no number is due right now (retries wait about a day)" };
  }

  const agent = { ...config, agentId: campaign.agent_id };
  for (const c of due) {
    const built = buildTelecallPrompt({
      callType: "lead_qualification", sellerName, customerName: c.name, currentPlan: null, seats: null,
      renewalDate: null, pendingAmount: null, catalogue,
    });
    const placed = await placeCall(agent, {
      toNumber: c.phone,
      systemPrompt: built.systemPrompt,
      dynamicVariables: { ...built.dynamicVariables } as unknown as Record<string, string>,
      metadata: { tenant_id: tenantId, cold_call_contact_id: c.id, call_type: "cold_call" },
    });
    await run((tx) => tx.cold_call_contacts.update({
      where: { id: c.id },
      data: placed.ok
        ? { provider_call_id: placed.providerCallId, attempts: { increment: 1 }, updated_at: new Date() }
        : { status: "failed", error: placed.error.slice(0, 500), attempts: { increment: 1 }, updated_at: new Date() },
    }));
    if (placed.ok) report.placed++; else report.failed++;
  }
  return report;
}

export function isColdCallStatus(s: string): s is ColdCallStatus {
  return ["pending", "calling", "answered", "interested", "callback", "not_interested",
    "no_answer", "failed", "skipped_dnd", "moved"].includes(s);
}
