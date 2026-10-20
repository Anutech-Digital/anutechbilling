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
import { bolnaReasons, normalisePostCall } from "@/lib/telecall/inbound";
import { fetchBolnaExecution, placeCall, type TelecallProviderConfig } from "@/lib/telecall/provider";
import type { ItemPrices } from "@/lib/supabase/database.types";
import {
  canCallNow, istDayStart, nextWorkingDayAt, outcomeFromCall, staleCallAction, NO_RESULT_GIVE_UP_MINUTES,
  type CallingListRow, type ColdCallStatus, type SkippedNumber,
} from "@/lib/coldcall/coldcall";
import { normaliseIndianPhone } from "@/lib/ai/telecall";

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
        productName: c.product_name,
        dailyLimit: c.daily_limit, windowStart: c.window_start, windowEnd: c.window_end,
        createdAt: c.created_at.toISOString(), counts,
        calledToday: today.find((t) => t.campaign_id === c.id)?._count._all ?? 0,
      };
    });
  });
}

export async function createCampaign(
  run: Run,
  input: {
    tenantId: string; userId: string; name: string; agentId: string; agentName: string | null; dailyLimit: number;
    productItemId: string | null; productName: string | null;
  },
): Promise<string> {
  const row = await run((tx) => tx.cold_call_campaigns.create({
    data: {
      tenant_id: input.tenantId, created_by: input.userId, name: input.name.trim().slice(0, 120),
      agent_id: input.agentId, agent_name: input.agentName, daily_limit: input.dailyLimit,
      product_item_id: input.productItemId, product_name: input.productName?.slice(0, 200) ?? null,
    },
    select: { id: true },
  }));
  return row.id;
}

/** What a campaign can be for: the active main catalogue items. */
export async function listProducts(run: Run): Promise<{ id: string; name: string }[]> {
  return run((tx) => tx.items.findMany({
    where: { kind: "main", is_active: true }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 200,
  }));
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
const STATUS_WORDS: Record<string, string> = {
  pending: "waiting to be called", calling: "being called", answered: "talked", interested: "interested",
  callback: "asked for a call back", not_interested: "not interested", no_answer: "did not answer",
  failed: "call failed", skipped_dnd: "DND", moved: "moved to Sales",
};

function shortDate(d: Date): string {
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", timeZone: "Asia/Kolkata" });
}

/**
 * Numbers the business already has in Sales: leads (any stage) and customers, keyed by the
 * normalised +91 number so "98111 22334" and "+919811122334" are one person. Read through RLS —
 * it covers what this user can see.
 */
async function salesPhoneBook(tx: Tx): Promise<Map<string, { leadId: string | null; label: string }>> {
  const book = new Map<string, { leadId: string | null; label: string }>();
  const leads = await tx.leads.findMany({
    where: { contact_phone: { not: null } },
    select: { id: true, company: true, contact_phone: true, stage: true },
  });
  for (const l of leads) {
    const p = normaliseIndianPhone(l.contact_phone);
    if (p && !book.has(p)) book.set(p, { leadId: l.id, label: `lead ${l.company} (${String(l.stage)})` });
  }
  const customers = await tx.customers.findMany({
    where: { OR: [{ contact_phone: { not: null } }, { contact_mobile: { not: null } }] },
    select: { name: true, contact_phone: true, contact_mobile: true },
  });
  for (const c of customers) {
    for (const raw of [c.contact_phone, c.contact_mobile]) {
      const p = normaliseIndianPhone(raw);
      if (p && !book.has(p)) book.set(p, { leadId: null, label: `customer ${c.name}` });
    }
  }
  return book;
}

export interface ImportReport {
  added: number;
  dnd: number;
  alreadyOnThisList: number;
  /** Rung (or queued) in another campaign — never called twice. */
  alreadyCalled: SkippedNumber[];
  /** Already a lead or customer — Sales owns them, the agent does not cold-call them. */
  alreadyInSales: SkippedNumber[];
}

/**
 * Add a file's numbers to a campaign. A number is left out when this campaign already has it,
 * when any other campaign already has it (called, queued, DND or said no — one person is
 * cold-called once), or when it is already a lead or customer.
 */
export async function importContacts(
  run: Run, tenantId: string, campaignId: string, rows: readonly CallingListRow[],
  /** Numbers the person chose to add anyway after seeing why they were left out. */
  force: ReadonlySet<string> = new Set(),
): Promise<ImportReport | null> {
  return run(async (tx) => {
    const c = await tx.cold_call_campaigns.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!c) return null;

    const phones = rows.map((r) => r.phone);
    const known = await tx.cold_call_contacts.findMany({
      where: { phone: { in: phones } },
      select: { phone: true, status: true, campaign_id: true, last_called_at: true },
    });
    const names = new Map((await tx.cold_call_campaigns.findMany({
      where: { id: { in: [...new Set(known.map((k) => k.campaign_id))] } }, select: { id: true, name: true },
    })).map((x) => [x.id, x.name]));
    const onThisList = new Set(known.filter((k) => k.campaign_id === campaignId).map((k) => k.phone));
    const elsewhere = new Map(known.filter((k) => k.campaign_id !== campaignId).map((k) => [k.phone, k]));
    const sales = await salesPhoneBook(tx);

    const report: ImportReport = { added: 0, dnd: 0, alreadyOnThisList: 0, alreadyCalled: [], alreadyInSales: [] };
    const fresh: CallingListRow[] = [];
    for (const r of rows) {
      if (onThisList.has(r.phone)) { report.alreadyOnThisList++; continue; }
      /* DND rows go on the list as "not called" whatever else is true — they are never rung, and
         offering "Add anyway" for one would lose the DND mark. */
      if (r.dnd || force.has(r.phone)) { fresh.push(r); continue; }
      const other = elsewhere.get(r.phone);
      if (other) {
        report.alreadyCalled.push({
          phone: r.phone, name: r.name, company: r.company, city: r.city,
          reason: `On “${names.get(other.campaign_id) ?? "another campaign"}” · ${STATUS_WORDS[other.status] ?? other.status}` +
            (other.last_called_at ? ` · ${shortDate(other.last_called_at)}` : ""),
        });
        continue;
      }
      const inSales = sales.get(r.phone);
      if (inSales) {
        report.alreadyInSales.push({ phone: r.phone, name: r.name, company: r.company, city: r.city, reason: `Already a ${inSales.label}`, leadId: inSales.leadId });
        continue;
      }
      fresh.push(r);
    }

    const created = await tx.cold_call_contacts.createMany({
      data: fresh.map((x) => ({
        tenant_id: tenantId, campaign_id: campaignId, phone: x.phone, name: x.name, company: x.company,
        city: x.city, dnd: x.dnd, status: x.dnd ? "skipped_dnd" : "pending",
      })),
      skipDuplicates: true,
    });
    report.added = created.count;
    report.dnd = fresh.filter((x) => x.dnd).length;
    /* New numbers on a finished campaign: it was "done" with no Start button, so they could
       never be called. Paused instead — the person presses Start again. */
    if (fresh.some((x) => !x.dnd) && created.count > 0) {
      await tx.cold_call_campaigns.updateMany({ where: { id: campaignId, status: "done" }, data: { status: "paused", updated_at: new Date() } });
    }
    return report;
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
  /** Why the agent rated the call as it did, in its own words (quote asked, seats heard…). */
  reasons: string[];
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
    reasons: bolnaReasons(r.extracted).slice(0, 4),
  }));
}

/* ── Into the pipeline (a person pressed the button) ─────────────────────── */

export type MoveResult =
  | { ok: true; leadId: string; joined: boolean; followUpAt: string }
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
    if (!["interested", "callback", "answered"].includes(c.status)) {
      return { ok: false, status: 409, error: "Only people who talked to the agent can be moved — this one has not." };
    }

    const now = new Date();
    const who = c.name?.trim() || c.company?.trim() || c.phone;
    const followUp = nextWorkingDayAt(now, 11);
    const campaign = await tx.cold_call_campaigns.findUnique({ where: { id: c.campaign_id }, select: { name: true, product_name: true } });
    const detail = [
      `AI cold call — campaign “${campaign?.name ?? ""}”${campaign?.product_name ? ` · product: ${campaign.product_name}` : ""}`,
      c.summary ? `Summary: ${c.summary}` : null,
      c.seats_heard ? `AI ne suna: ${c.seats_heard} seats` : null,
      c.transcript ? `Transcript:\n${c.transcript.slice(0, 4000)}` : null,
    ].filter(Boolean).join("\n");

    /* The same person already a lead (e.g. came in from the website meanwhile)? Add the call to
       that lead instead of making a second one. */
    const existing = (await salesPhoneBook(tx)).get(c.phone);
    let leadId: string;
    let joined = false;
    if (existing?.leadId) {
      leadId = existing.leadId;
      joined = true;
    } else {
      leadId = newLeadId();
      const company = c.company?.trim() || c.name?.trim() || c.phone;
      await tx.leads.create({
        data: {
          id: leadId, tenant_id: tenantId, company, contact_name: c.name, contact_phone: c.phone,
          stage: "contact", source: "tele-calling", owner_id: userId, created_by: userId,
          seats: c.seats_heard ?? undefined, follow_up_date: followUp,
          notes: `AI cold call (${campaign?.name ?? "Cold Calling"}${campaign?.product_name ? ` · ${campaign.product_name}` : ""})${c.summary ? `: ${c.summary}` : ""}`.slice(0, 2000),
        },
      });
    }
    await tx.lead_activities.create({ data: { tenant_id: tenantId, lead_id: leadId, kind: "note", detail } });
    /* The salesperson's next step, on their Tasks list: a real call the next working morning. */
    await tx.tasks.create({
      data: {
        tenant_id: tenantId, owner_id: userId, lead_id: leadId, kind: "call", due_at: followUp,
        title: `Call ${who} — interested on AI cold call`,
        notes: c.summary ? `AI ne suna: ${c.summary}`.slice(0, 1000) : null,
      },
    });
    await tx.cold_call_contacts.update({
      where: { id: contactId },
      data: { status: "moved", lead_id: leadId, moved_at: now, moved_by: userId, updated_at: now },
    });
    return { ok: true, leadId, joined, followUpAt: followUp.toISOString() };
  });
}

/**
 * Delete a whole campaign and its list (the rows go with it — ON DELETE CASCADE). Refused while
 * a call is ringing. Leads it already made stay in Sales & Pipeline.
 */
export async function deleteCampaign(run: Run, campaignId: string): Promise<{ ok: true } | { ok: false; status: number; error: string; detail?: string }> {
  return run(async (tx) => {
    const c = await tx.cold_call_campaigns.findUnique({ where: { id: campaignId }, select: { id: true } });
    if (!c) return { ok: false, status: 404, error: "That campaign is not here any more.", detail: "Refresh the page." };
    const ringing = await tx.cold_call_contacts.count({ where: { campaign_id: campaignId, status: "calling" } });
    if (ringing > 0) {
      return { ok: false, status: 409, error: "A call from this campaign is going on right now.", detail: "Press Pause, wait two minutes for it to end, then delete." };
    }
    await tx.cold_call_campaigns.delete({ where: { id: campaignId } });
    return { ok: true };
  });
}

export type DeleteResult = { ok: true } | { ok: false; status: number; error: string; detail?: string };

/**
 * Take a number off a campaign's list. Refused while its call is ringing (the result would land
 * on nothing). A lead it already became stays in Sales & Pipeline — only the list row goes.
 */
export async function deleteContact(run: Run, contactId: string): Promise<DeleteResult> {
  return run(async (tx) => {
    const c = await tx.cold_call_contacts.findUnique({ where: { id: contactId }, select: { status: true } });
    if (!c) return { ok: false, status: 404, error: "That number is not on the list any more.", detail: "Refresh the page." };
    if (c.status === "calling") {
      return { ok: false, status: 409, error: "This number is on a call right now.", detail: "Delete it after the call ends — about two minutes." };
    }
    await tx.cold_call_contacts.delete({ where: { id: contactId } });
    return { ok: true };
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

/** The campaign's product item, if it has one — the agent then quotes only that product. */
async function campaignProduct(campaignId: string, tx: Tx): Promise<string | null> {
  const c = await tx.cold_call_campaigns.findUnique({ where: { id: campaignId }, select: { product_item_id: true } });
  return c?.product_item_id ?? null;
}

async function loadCatalogue(tx: Tx, onlyItem: Promise<string | null> = Promise.resolve(null)): Promise<CatalogRow[]> {
  const itemId = await onlyItem;
  const items = await tx.items.findMany({
    where: { kind: "main", is_active: true, msrp: { gt: 0 }, ...(itemId ? { id: itemId } : {}) },
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

  /* 0. Rows stuck on "calling" (20 Oct review): a row claimed by a tick that stopped before
     the call went out has no call id and was never polled — it sat "Calling now" for ever and
     the campaign could never finish. Back in the queue; and a placed call the agent never
     reported on is given up after a while, so nobody waits on it. */
  const stuck = await run((tx) => tx.cold_call_contacts.findMany({
    where: { campaign_id: campaignId, status: "calling" },
    select: { id: true, provider_call_id: true, last_called_at: true },
  }));
  for (const s of stuck) {
    const action = staleCallAction({ providerCallId: s.provider_call_id, lastCalledAt: s.last_called_at }, now);
    if (action === "requeue") {
      await run((tx) => tx.cold_call_contacts.updateMany({
        where: { id: s.id, status: "calling", provider_call_id: null },
        data: { status: "pending", updated_at: now },
      }));
    } else if (action === "give_up") {
      await run((tx) => tx.cold_call_contacts.updateMany({
        where: { id: s.id, status: "calling" },
        data: { status: "failed", error: `No result from the agent ${NO_RESULT_GIVE_UP_MINUTES} minutes after the call.`, updated_at: now },
      }));
    }
  }

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
    /* (next_attempt_at below is overwritten either way, so an answered call back never rings again.) */
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
        campaign_id: campaignId, dnd: false,
        OR: [
          { status: "pending", next_attempt_at: null },
          { status: "pending", next_attempt_at: { lte: now } },
          /* A person who asked to be called back, once their time has come. */
          { status: "callback", next_attempt_at: { lte: now } },
        ],
      },
      orderBy: { created_at: "asc" },
      take: room,
    });
    /* Claimed one by one: a second tick running at the same moment sees a row as "calling" and
       leaves it alone, so nobody is rung twice — and a row this tick claimed is always one it
       rings (an all-or-nothing claim used to strand the claimed ones when another tick won one). */
    const mine: typeof rows = [];
    for (const r of rows) {
      const claimed = await tx.cold_call_contacts.updateMany({
        where: { id: r.id, status: r.status },
        data: { status: "calling", last_called_at: now, updated_at: now, error: null },
      });
      if (claimed.count === 1) mine.push(r);
    }
    const tenant = await tx.tenants.findUnique({ where: { id: tenantId }, select: { name: true } });
    return {
      due: mine,
      catalogue: catalogueFromRows(await loadCatalogue(tx, campaignProduct(campaignId, tx))),
      sellerName: tenant?.name?.trim() || "our team",
    };
  });

  if (due.length === 0) {
    const left = await run((tx) => tx.cold_call_contacts.count({
      where: {
        campaign_id: campaignId,
        OR: [{ status: { in: ["pending", "calling"] } }, { status: "callback", next_attempt_at: { not: null } }],
      },
    }));
    if (left === 0) {
      await run((tx) => tx.cold_call_campaigns.updateMany({ where: { id: campaignId, status: "running" }, data: { status: "done", updated_at: now } }));
      return { ...report, note: "every number on the list has been called" };
    }
    return { ...report, note: "no number is due right now (retries and call backs wait for their time)" };
  }

  const agent = { ...config, agentId: campaign.agent_id };
  for (const c of due) {
    const built = buildTelecallPrompt({
      callType: "lead_qualification", sellerName, customerName: c.name, currentPlan: null, seats: null,
      renewalDate: null, pendingAmount: null, catalogue,
      coldCall: { product: campaign.product_name, callback: c.status === "callback" },
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
