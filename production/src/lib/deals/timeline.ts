/**
 * Deal detail — "Poori history": everything linked to one deal, as ONE stream (30 Sep 2026).
 *
 * Pardeep: "deal ke click karne par usse related har activity show honi chahiye". The drawer's
 * timeline (lib/leads/timeline.ts) merges activities, quotes and tasks; a deal page needs the
 * rest of the story too — the mail, the quote being sent / opened / signed, the invoice, the
 * money, the subscription, and every stage move. This file merges them. It fetches nothing:
 * lib/queries/deal-history.ts reads the rows, this turns rows into events.
 *
 * ─── RULES ──────────────────────────────────────────────────────────────────
 *   • Newest first, ties broken by group then id — a TOTAL order, so two events in the same
 *     second never swap places between renders.
 *   • An event with no usable timestamp is DROPPED and counted (same rule as the drawer):
 *     a wrongly-placed event invents a sequence that never happened.
 *   • A source that was not loaded is `undefined`; a source that loaded empty is `[]`. The
 *     difference matters for one de-duplication: `email_in` activities are echoes of rows in
 *     inbound_emails (lib/inbound/ingest.ts writes both), so they are skipped only when the
 *     mail rows themselves are present.
 *   • Dates shown are IST (formatIstDateTime), never the browser's zone.
 *
 * ─── WHERE STAGE HISTORY COMES FROM ─────────────────────────────────────────
 * `leads` keeps only the CURRENT stage and when it was entered. Earlier moves are read from
 * activity_log (trigger log_row_change on leads / quotes, whose `changes` carries old → new
 * for updates since 27 Sep 2026) and from 'stage' lead_activities. When neither says how the
 * deal reached its current stage, one derived event marks it at `stage_changed_at`.
 */
import { IST_OFFSET_MS, toIstDate } from "@/lib/dates/ist";
import { STAGE_LABEL } from "@/lib/leads/stage-meta";
import { invoiceAmountDue } from "@/lib/payments/amount-due";
import { backfilledStart } from "@/lib/deals/deal-quotes";
import type { Lead } from "@/lib/supabase/database.types";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";

// ─── Types ───────────────────────────────────────────────────────────────────

/** Which filter chip an event belongs to. Tasks sit with calls & notes: both are "the work". */
export type DealEventGroup = "calls" | "email" | "money" | "stage";
export type DealFilter = "all" | DealEventGroup;

export const DEAL_FILTERS: readonly { id: DealFilter; label: string }[] = [
  { id: "all",   label: "All" },
  { id: "calls", label: "Calls & notes" },
  { id: "email", label: "Email" },
  { id: "money", label: "Quotes & payments" },
  { id: "stage", label: "Stage" },
];

export type DealEventTone = "ink" | "amber" | "indigo" | "emerald" | "rose";

export interface DealEvent {
  /** Source-prefixed, unique across sources. */
  id: string;
  group: DealEventGroup;
  /** ISO instant (UTC). */
  at: string;
  title: string;
  detail?: string | null;
  /** Who did it — a person's name, the customer, or "AI". */
  who?: string | null;
  /** Whole rupees. */
  amount?: number | null;
  /** In-app link to the record. */
  href?: string | null;
  icon: string;
  tone: DealEventTone;
  /** The business date has no time of day (show the date only, not "12:00 am"). */
  dateOnly?: boolean;
  /** When the row was keyed into the app, if that was a later day than `at` (backfilled). */
  addedOn?: string | null;
}

type Id = string;
type Ts = string | null | undefined;

export interface DealHistorySources {
  lead?: Pick<Lead, "id" | "company" | "stage" | "created_at" | "created_by" | "stage_changed_at" | "lost_at" | "lost_reason" | "lost_note" | "trial_started_at" | "trial_converted_at" | "trial_expired_at" | "source"> | null;
  activities?: ReadonlyArray<{ id: Id; kind: string; detail?: string | null; created_at?: Ts; created_by?: string | null }>;
  /** inbound_emails rows for the lead. `sent` = a reply we sent (lib/inbound/sent.ts). */
  emails?: ReadonlyArray<{ id: Id; subject?: string | null; from_email?: string | null; from_name?: string | null; to_email?: string | null; created_at?: Ts; sent: boolean }>;
  tasks?: ReadonlyArray<{ id: Id; title: string; status?: string | null; due_at?: Ts; created_at?: Ts; completed_at?: Ts; owner_id?: string | null; completed_by?: string | null }>;
  quotes?: ReadonlyArray<{ id: Id; status?: string | null; amount?: number | null; created_at?: Ts; updated_at?: Ts; owner_id?: string | null }>;
  quoteSends?: ReadonlyArray<{ id: Id; quote_id: Id; sent_at?: Ts; recipient_email?: string | null; status?: string | null; sent_by?: string | null }>;
  quoteViews?: ReadonlyArray<{ id: Id; quote_id: Id; viewed_at?: Ts; is_bot?: boolean | null }>;
  quoteSignatures?: ReadonlyArray<{ id: Id; quote_id: Id; signed_at?: Ts; signer_name?: string | null }>;
  invoices?: ReadonlyArray<{ id: Id; amount?: number | null; status?: string | null; invoice_date?: string | null; created_at?: Ts; quote_id?: string | null }>;
  payments?: ReadonlyArray<{ id: Id; amount?: number | null; method?: string | null; status?: string | null; received_at?: Ts; created_at?: Ts; refunded_at?: Ts; quote_id?: string | null; recorded_by?: string | null }>;
  subscriptions?: ReadonlyArray<{ id: Id; plan?: string | null; seats?: number | null; status?: string | null; start_date?: string | null; created_at?: Ts; mrr?: number | null }>;
  whatsapp?: ReadonlyArray<{ id: Id; direction?: string | null; text_body?: string | null; type?: string | null; template_name?: string | null; status?: string | null; created_at?: Ts }>;
  aiCalls?: ReadonlyArray<{ id: Id; status?: string | null; summary?: string | null; duration_sec?: number | null; created_at?: Ts }>;
  /** Project quotation(s) linked on leads.project_id (project_sales), and what hangs off them. */
  projects?: ReadonlyArray<{ id: Id; title?: string | null; status?: string | null; total_amount?: number | null; created_at?: Ts; accepted_at?: Ts; updated_at?: Ts; start_date?: string | null }>;
  projectMilestones?: ReadonlyArray<{ id: Id; project_id: Id; label?: string | null; total_amount?: number | null; invoice_id?: string | null }>;
  /** invoices rows reached through project_milestones.invoice_id. */
  projectInvoices?: ReadonlyArray<{ id: Id; amount?: number | null; net_payable?: number | null; paid_amount?: number | null; status?: string | null; invoice_date?: string | null; created_at?: Ts }>;
  /** project_payments rows (bank receipts, and the TDS the customer withheld as method 'tds'). */
  projectPayments?: ReadonlyArray<{ id: Id; project_id: Id; milestone_id?: string | null; amount?: number | null; method?: string | null; received_at?: string | null; created_at?: Ts }>;
  /** activity_log rows for this lead (entity 'leads') and its quotes (entity 'quotes'). */
  auditLog?: ReadonlyArray<{ id: number | string; entity: string; entity_id?: string | null; action: string; changes?: unknown; created_at?: Ts; user_id?: string | null }>;
}

export interface DealHistory {
  events: DealEvent[];
  /** Rows dropped for having no usable date. */
  undated: number;
  /** Events per filter chip ("all" = every event). */
  counts: Record<DealFilter, number>;
  /** Stages the lead was recorded moving INTO (activity_log) — evidence for the stepper's ✓. */
  stageMoves: string[];
  /** Set when part of the deal happened over a day before the lead was keyed in (backfill):
      the lead's created_at, so the feed can say "added to the app on …". */
  addedToAppOn: string | null;
}

/** id → display name. Unknown / null ids return null (never a bare uuid). */
export type NameOf = (userId: string | null | undefined) => string | null;

// ─── Helpers ────────────────────────────────────────────────────────────────

function iso(...candidates: Ts[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    /* A bare calendar date ("2026-09-30") is an IST day — place it at IST midnight, not UTC
       midnight (which would be 05:30 IST and sort after a 01:00 IST event of the same day). */
    const s = /^\d{4}-\d{2}-\d{2}$/.test(c) ? `${c}T00:00:00+05:30` : c;
    const t = Date.parse(s);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

/**
 * A business DATE (invoice_date, received_at) carrying the clock time of the row's insert
 * when both fall on the same IST day — else the date alone, at IST midnight. An invoice
 * dated 7 Aug but keyed in on 26 Sep belongs on 7 Aug.
 */
function datedAt(date: string | null | undefined, createdAt: Ts): string | null {
  const day = iso(date);
  const made = iso(createdAt);
  if (!day) return made;
  if (made && date && toIstDate(made) === date.slice(0, 10)) return made;
  return day;
}

/** created_at when it is a LATER IST day than the business date — the row was backfilled. */
function lateAdded(date: string | null | undefined, createdAt: Ts): string | null {
  const made = iso(createdAt);
  if (!date || !made) return null;
  return toIstDate(made) > date.slice(0, 10) ? made : null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "30 Sep 2026" in IST. */
export function formatIstDate(at: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const d = new Date(t + IST_OFFSET_MS);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

/** "30 Sep 2026, 2:05 pm" in IST, whatever the browser's zone. */
export function formatIstDateTime(at: string): string {
  const t = Date.parse(at);
  if (Number.isNaN(t)) return "";
  const d = new Date(t + IST_OFFSET_MS);
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${h12}:${mm} ${h24 < 12 ? "am" : "pm"}`;
}

const stageName = (s: unknown): string =>
  typeof s === "string" && s in STAGE_LABEL ? STAGE_LABEL[s as Lead["stage"]] : String(s ?? "—");

/** `{ col: { old, new } }` → the pair for one column, or null. */
function changeOf(changes: unknown, col: string): { old: unknown; new: unknown } | null {
  if (!changes || typeof changes !== "object") return null;
  const c = (changes as Record<string, unknown>)[col];
  if (!c || typeof c !== "object" || !("new" in c)) return null;
  return c as { old: unknown; new: unknown };
}

const ACTIVITY: Record<string, { title: string; icon: string; group: DealEventGroup; tone: DealEventTone }> = {
  call:      { title: "Call logged",         icon: "phone",    group: "calls", tone: "amber" },
  whatsapp:  { title: "WhatsApp sent",       icon: "whatsapp", group: "calls", tone: "emerald" },
  note:      { title: "Note added",          icon: "edit",     group: "calls", tone: "ink" },
  meeting:   { title: "Meeting held",        icon: "calendar", group: "calls", tone: "indigo" },
  email:     { title: "Email sent",          icon: "mail",     group: "email", tone: "indigo" },
  email_out: { title: "Email sent",          icon: "mail",     group: "email", tone: "indigo" },
  email_in:  { title: "Email received",     icon: "inbox", group: "email", tone: "indigo" },
  quote:     { title: "Quote activity",      icon: "file",     group: "money", tone: "amber" },
  stage:     { title: "Stage changed",       icon: "target",   group: "stage", tone: "indigo" },
};

const QUOTE_STATUS_TITLE: Record<string, string> = {
  sent: "Quote sent", viewed: "Customer ne quote dekha", accepted: "Quote accepted",
  rejected: "Quote rejected", expired: "Quote expire ho gaya", draft: "Quote wapas draft me",
};

// ─── The merge ──────────────────────────────────────────────────────────────

export function buildDealHistory(src: DealHistorySources, nameOf: NameOf = () => null): DealHistory {
  const events: DealEvent[] = [];
  let undated = 0;
  const push = (at: string | null, e: Omit<DealEvent, "at">) => {
    if (!at) { undated++; return; }
    events.push({ ...e, at });
  };
  const quoteHref = (id: string) => `/quotes/${id}`;

  // Lead row: when it was created, lost, trial dates.
  const lead = src.lead ?? null;
  if (lead) {
    push(iso(lead.created_at), {
      id: `lead:created:${lead.id}`, group: "stage", icon: "plus", tone: "ink",
      title: "Lead added", detail: lead.source ? `Source: ${lead.source}` : null, who: nameOf(lead.created_by),
    });
    if (lead.trial_started_at) push(iso(lead.trial_started_at), { id: `lead:trial-start:${lead.id}`, group: "stage", icon: "play", tone: "rose", title: "Trial started" });
    if (lead.trial_converted_at) push(iso(lead.trial_converted_at), { id: `lead:trial-conv:${lead.id}`, group: "stage", icon: "check_circle", tone: "emerald", title: "Trial converted" });
    if (lead.trial_expired_at) push(iso(lead.trial_expired_at), { id: `lead:trial-exp:${lead.id}`, group: "stage", icon: "clock", tone: "rose", title: "Trial expired" });
    if (lead.stage === "lost" && lead.lost_at) {
      push(iso(lead.lost_at), {
        id: `lead:lost:${lead.id}`, group: "stage", icon: "x_circle", tone: "rose", title: "Deal lost",
        detail: [lead.lost_reason, lead.lost_note].filter(Boolean).join(" — ") || null,
      });
    }
  }

  // Lead activities.
  const mailLoaded = src.emails !== undefined;
  for (const a of src.activities ?? []) {
    if (a.kind === "email_in" && mailLoaded) continue;           // echo of an inbound_emails row
    const m = ACTIVITY[a.kind] ?? { title: a.kind, icon: "clock", group: "calls" as const, tone: "ink" as const };
    push(iso(a.created_at), {
      id: `activity:${a.id}`, group: m.group, icon: m.icon, tone: m.tone,
      title: m.title, detail: a.detail ?? null, who: a.kind === "email_in" ? "Customer" : nameOf(a.created_by),
    });
  }

  // Email (both directions).
  for (const e of src.emails ?? []) {
    push(iso(e.created_at), {
      id: `email:${e.id}`, group: "email", icon: e.sent ? "send" : "inbox", tone: "indigo",
      title: e.sent ? `Email sent${e.to_email ? ` → ${e.to_email}` : ""}` : "Email received",
      detail: e.subject || null,
      who: e.sent ? null : (e.from_name || e.from_email || "Customer"),
    });
  }

  // Follow-ups: when created, and when done.
  for (const t of src.tasks ?? []) {
    const due = t.due_at ? ` · due ${formatIstDateTime(iso(t.due_at) ?? t.due_at)}` : "";
    push(iso(t.created_at, t.due_at), {
      id: `task:${t.id}`, group: "calls", icon: "clock", tone: "amber",
      title: `Follow-up set: ${t.title}`, detail: `${t.status === "done" ? "Done" : t.status === "snoozed" ? "Snoozed" : "Pending"}${due}`,
      who: nameOf(t.owner_id),
    });
    if (t.status === "done" && t.completed_at) {
      push(iso(t.completed_at), {
        id: `task-done:${t.id}`, group: "calls", icon: "check", tone: "emerald",
        title: `Follow-up done: ${t.title}`, who: nameOf(t.completed_by ?? t.owner_id),
      });
    }
  }

  // Quotes and their lifecycle.
  const quotes = src.quotes ?? [];
  const sentQuotes = new Set((src.quoteSends ?? []).map((s) => s.quote_id));
  const viewedQuotes = new Set((src.quoteViews ?? []).filter((v) => !v.is_bot).map((v) => v.quote_id));
  const signedQuotes = new Set((src.quoteSignatures ?? []).map((s) => s.quote_id));
  const loggedStatus = new Set<string>();                        // `${quoteId}:${status}` seen in activity_log

  for (const q of quotes) {
    push(iso(q.created_at), {
      id: `quote:${q.id}`, group: "money", icon: "file", tone: "amber",
      title: "Quote created", detail: q.id, amount: q.amount ?? null, href: quoteHref(q.id), who: nameOf(q.owner_id),
    });
  }
  for (const s of src.quoteSends ?? []) {
    const failed = s.status === "failed";
    push(iso(s.sent_at), {
      id: `quote-send:${s.id}`, group: "money", icon: "send", tone: failed ? "rose" : "amber",
      title: failed ? "Quote email failed" : "Quote sent",
      detail: [s.quote_id, s.recipient_email ? `→ ${s.recipient_email}` : null].filter(Boolean).join(" "),
      href: quoteHref(s.quote_id), who: nameOf(s.sent_by),
    });
  }
  /* Views: one event per quote (the first human open), with the count — twelve "viewed"
     rows for one quote would bury everything else. Bot opens (mail scanners) are ignored. */
  const viewsByQuote = new Map<string, string[]>();
  for (const v of src.quoteViews ?? []) {
    if (v.is_bot) continue;
    const at = iso(v.viewed_at);
    if (!at) { undated++; continue; }
    viewsByQuote.set(v.quote_id, [...(viewsByQuote.get(v.quote_id) ?? []), at]);
  }
  for (const [qid, ats] of viewsByQuote) {
    ats.sort();
    events.push({
      id: `quote-view:${qid}`, group: "money", icon: "eye", tone: "indigo", at: ats[0],
      title: "Customer viewed quote",
      detail: ats.length > 1 ? `${qid} · ${ats.length} baar dekha · last ${formatIstDateTime(ats[ats.length - 1])}` : qid,
      href: quoteHref(qid), who: "Customer",
    });
  }
  for (const s of src.quoteSignatures ?? []) {
    push(iso(s.signed_at), {
      id: `quote-sign:${s.id}`, group: "money", icon: "check_circle", tone: "emerald",
      title: "Quote accepted (signed)", detail: s.quote_id, href: quoteHref(s.quote_id), who: s.signer_name || "Customer",
    });
  }

  // activity_log: stage moves on the lead, status moves on its quotes.
  const leadStageMoves: string[] = [];
  for (const r of src.auditLog ?? []) {
    if (r.action !== "update") continue;
    if (r.entity === "leads") {
      const c = changeOf(r.changes, "stage");
      if (!c) continue;
      if (typeof c.new === "string") leadStageMoves.push(c.new);
      push(iso(r.created_at), {
        id: `audit:${r.id}`, group: "stage", icon: "target", tone: c.new === "won" ? "emerald" : c.new === "lost" ? "rose" : "indigo",
        title: `Stage: ${stageName(c.old)} → ${stageName(c.new)}`, who: nameOf(r.user_id),
      });
    } else if (r.entity === "quotes" && r.entity_id) {
      const c = changeOf(r.changes, "status");
      if (!c || typeof c.new !== "string") continue;
      /* The richer sources win: a send-log row names the recipient, a view row is the
         customer's own open, a signature names the signer. */
      if (c.new === "sent" && sentQuotes.has(r.entity_id)) continue;
      if (c.new === "viewed" && viewedQuotes.has(r.entity_id)) continue;
      if (c.new === "accepted" && signedQuotes.has(r.entity_id)) continue;
      loggedStatus.add(`${r.entity_id}:${c.new}`);
      push(iso(r.created_at), {
        id: `audit:${r.id}`, group: "money", icon: c.new === "accepted" ? "check_circle" : c.new === "rejected" ? "x_circle" : "file",
        tone: c.new === "accepted" ? "emerald" : c.new === "rejected" || c.new === "expired" ? "rose" : "amber",
        title: QUOTE_STATUS_TITLE[c.new] ?? `Quote: ${c.new}`, detail: r.entity_id, href: quoteHref(r.entity_id), who: nameOf(r.user_id),
      });
    }
  }

  /* A quote that is accepted / rejected with no dated record of the change (older than the
     audit values, or changed by the system) — placed at its last update and SAID so. */
  for (const q of quotes) {
    const st = q.status ?? "";
    if (st !== "accepted" && st !== "rejected") continue;
    if (loggedStatus.has(`${q.id}:${st}`) || (st === "accepted" && signedQuotes.has(q.id))) continue;
    push(iso(q.updated_at), {
      id: `quote-status:${q.id}`, group: "money", icon: st === "accepted" ? "check_circle" : "x_circle",
      tone: st === "accepted" ? "emerald" : "rose", title: QUOTE_STATUS_TITLE[st],
      detail: `${q.id} · time = quote ka last update`, amount: q.amount ?? null, href: quoteHref(q.id),
    });
  }

  // Current stage, when nothing above explains how the deal got there.
  if (lead && lead.stage_changed_at) {
    /* A 'stage' activity written within 5 minutes of the move (e.g. the project-accept
       trigger's "moved to Won automatically") already says it. */
    const movedAt = Date.parse(lead.stage_changed_at);
    const stageNote = (src.activities ?? []).some((a) =>
      a.kind === "stage" && !!a.created_at && Math.abs(Date.parse(a.created_at) - movedAt) <= 5 * 60_000);
    /* Created straight into this stage — "Lead added" already marks that moment. */
    const bornHere = !!lead.created_at && Math.abs(Date.parse(lead.created_at) - movedAt) <= 5 * 60_000;
    const explained = leadStageMoves.includes(lead.stage)
      || (lead.stage === "lost" && !!lead.lost_at)
      || stageNote || bornHere;
    if (!explained) {
      push(iso(lead.stage_changed_at), {
        id: `lead:stage:${lead.id}`, group: "stage", icon: "target",
        tone: lead.stage === "won" ? "emerald" : lead.stage === "lost" ? "rose" : "indigo",
        title: `Moved to ${stageName(lead.stage)}`,
      });
    }
  }

  // Money after the quote.
  const projectInvoiceIds = new Set((src.projectInvoices ?? []).map((i) => i.id));
  for (const inv of src.invoices ?? []) {
    if (projectInvoiceIds.has(inv.id)) continue;                // shown once, as a project invoice
    push(iso(inv.created_at, inv.invoice_date), {
      id: `invoice:${inv.id}`, group: "money", icon: "receipt", tone: inv.status === "void" ? "rose" : "indigo",
      title: inv.status === "void" ? "Invoice (void)" : "Invoice issued",
      detail: [inv.id, inv.status && inv.status !== "void" ? inv.status : null].filter(Boolean).join(" · "),
      amount: inv.amount ?? null, href: invoiceHref(inv.id),
    });
  }
  for (const p of src.payments ?? []) {
    push(iso(p.received_at, p.created_at), {
      id: `payment:${p.id}`, group: "money", icon: "rupee", tone: "emerald",
      title: "Payment received", detail: [p.method, p.quote_id].filter(Boolean).join(" · ") || null,
      amount: p.amount ?? null, href: p.quote_id ? quoteHref(p.quote_id) : null, who: nameOf(p.recorded_by),
    });
    if (p.refunded_at) {
      push(iso(p.refunded_at), {
        id: `refund:${p.id}`, group: "money", icon: "arrow_left", tone: "rose",
        title: "Payment refunded", amount: p.amount ?? null, href: p.quote_id ? quoteHref(p.quote_id) : null,
      });
    }
  }
  for (const s of src.subscriptions ?? []) {
    push(iso(s.created_at, s.start_date), {
      id: `subscription:${s.id}`, group: "money", icon: "refresh", tone: "emerald",
      title: "Subscription created",
      detail: [s.plan, s.seats ? `${s.seats} seats` : null, s.status].filter(Boolean).join(" · ") || null,
      amount: s.mrr ?? null, href: "/subscriptions",
    });
  }

  // Project quotations (Project Sales): quoted, accepted / declined, invoiced, paid.
  const projectHref = (id: string) => `/projects/${id}`;
  const projectTitle = new Map((src.projects ?? []).map((p) => [p.id, p.title || "Project"]));
  for (const p of src.projects ?? []) {
    const name = p.title || "Project";
    /* create_project_quote writes the row straight as 'quoted' — a project quotation has no
       separate send step or send log, so the moment it was made is the moment it was out. */
    const st = (p.status ?? "").toLowerCase();
    /* 1 Oct 2026, Pardeep: "ye history logical thik ho sakti hai" — Excel Technologies' project
       ran 20 Apr → Aug but was keyed in on 26 Sep, created and accepted in the same second. The
       feed then said "quote banaya 26 Sep 10:41" AFTER "won 9:50" and after Aug payments.
       A project keyed in already accepted, with a start date days earlier, is a backfill: show
       ONE "Project quote accepted" on its start date (date only) and say when it was added. */
    const made = iso(p.created_at);
    if (backfilledStart(p)) {
      push(iso(p.start_date), {
        id: `project-accept:${p.id}`, group: "money", icon: "check_circle", tone: "emerald",
        title: "Project quote accepted", detail: `${name} · project started`, amount: p.total_amount ?? null,
        href: projectHref(p.id), dateOnly: true, addedOn: made,
      });
      continue;
    }
    /* create_project_quote writes the row straight as 'quoted' — a project quotation has no
       separate send step or send log, so the moment it was made is the moment it was out. */
    push(made, {
      id: `project:${p.id}`, group: "money", icon: "file", tone: "amber",
      title: "Project quote created", detail: name, amount: p.total_amount ?? null, href: projectHref(p.id),
    });
    if (st === "cancelled") {
      push(iso(p.updated_at), {
        id: `project-status:${p.id}`, group: "money", icon: "x_circle", tone: "rose",
        title: "Project quote declined", detail: `${name} · no accept date, shown at last update`, href: projectHref(p.id),
      });
    } else if (p.accepted_at || st === "active" || st === "completed") {
      /* accepted_at is stamped by accept_project_quote; older rows lack it — placed at the
         last update then, and said so (lib/projects/quotation-view.ts treats them as accepted). */
      push(iso(p.accepted_at, p.updated_at), {
        id: `project-accept:${p.id}`, group: "money", icon: "check_circle", tone: "emerald",
        title: "Project quote accepted", detail: p.accepted_at ? name : `${name} · no accept date, shown at last update`,
        amount: p.total_amount ?? null, href: projectHref(p.id),
      });
    }
  }
  const milestoneOf = new Map((src.projectMilestones ?? []).map((m) => [m.id, m]));
  const milestoneByInvoice = new Map<string, NonNullable<DealHistorySources["projectMilestones"]>[number]>();
  for (const m of src.projectMilestones ?? []) if (m.invoice_id) milestoneByInvoice.set(m.invoice_id, m);
  for (const inv of dedupeById(src.projectInvoices ?? [])) {
    const ms = milestoneByInvoice.get(inv.id);
    const invLate = lateAdded(inv.invoice_date, inv.created_at);
    push(datedAt(inv.invoice_date, inv.created_at), {
      dateOnly: !!invLate, addedOn: invLate,
      id: `project-invoice:${inv.id}`, group: "money", icon: "receipt", tone: inv.status === "void" ? "rose" : "indigo",
      title: inv.status === "void" ? "Project invoice (void)" : "Project invoice issued",
      detail: [inv.id, ms?.label, inv.status && inv.status !== "void" ? inv.status : null].filter(Boolean).join(" · "),
      amount: inv.amount ?? null, href: invoiceHref(inv.id),
    });
  }
  for (const p of dedupeById(src.projectPayments ?? [])) {
    const tds = p.method === "tds";
    const ms = p.milestone_id ? milestoneOf.get(p.milestone_id) : undefined;
    const payLate = lateAdded(p.received_at, p.created_at);
    push(datedAt(p.received_at, p.created_at), {
      dateOnly: !!payLate, addedOn: payLate,
      id: `project-payment:${p.id}`, group: "money", icon: "rupee", tone: "emerald",
      title: tds ? "TDS deducted by customer" : "Project payment received",
      detail: [projectTitle.get(p.project_id), ms?.label, tds ? null : p.method].filter(Boolean).join(" · ") || null,
      amount: p.amount ?? null, href: projectHref(p.project_id),
    });
  }

  // WhatsApp Cloud API messages and AI calls.
  for (const w of src.whatsapp ?? []) {
    const inbound = w.direction === "inbound";
    push(iso(w.created_at), {
      id: `wa:${w.id}`, group: "calls", icon: "whatsapp", tone: "emerald",
      title: inbound ? "WhatsApp received" : "WhatsApp sent",
      detail: w.text_body || (w.template_name ? `Template: ${w.template_name}` : w.type) || null,
      who: inbound ? "Customer" : null,
    });
  }
  for (const c of src.aiCalls ?? []) {
    push(iso(c.created_at), {
      id: `ai-call:${c.id}`, group: "calls", icon: "phone", tone: "indigo",
      title: "AI call", detail: [c.status, c.duration_sec ? `${Math.round(c.duration_sec / 60)} min` : null, c.summary].filter(Boolean).join(" · ") || null,
      who: "AI",
    });
  }

  events.sort((a, b) => b.at.localeCompare(a.at) || a.group.localeCompare(b.group) || a.id.localeCompare(b.id));

  const counts: Record<DealFilter, number> = { all: events.length, calls: 0, email: 0, money: 0, stage: 0 };
  for (const e of events) counts[e.group]++;
  const leadAt = lead ? iso(lead.created_at) : null;
  const addedToAppOn = leadAt && events.some((e) => Date.parse(e.at) < Date.parse(leadAt) - 86_400_000) ? leadAt : null;
  return { events, undated, counts, stageMoves: leadStageMoves, addedToAppOn };
}

export function filterDealHistory(events: readonly DealEvent[], filter: DealFilter): DealEvent[] {
  return filter === "all" ? [...events] : events.filter((e) => e.group === filter);
}

// ─── Money ──────────────────────────────────────────────────────────────────

export interface DealMoney {
  invoiced: number;
  paid: number;
  /** Still owed on the invoices. Null when nothing is invoiced yet. */
  outstanding: number | null;
  invoiceCount: number;
  paymentCount: number;
  /** Project side only (0 when the deal has no project quotation). */
  project: {
    invoiced: number;
    paid: number;
    /** Part of `paid` that is TDS the customer withheld (project_payments.method 'tds'). */
    tds: number;
    /** Project quotation value (GST-inclusive total), non-declined projects. */
    value: number;
    /** Milestones with no invoice raised yet — the project value still to be billed. */
    notInvoiced: number;
  };
}

/**
 * Invoiced / paid / outstanding for the deal, across both kinds of quote.
 *
 * Subscription quotes (unchanged): paid is read from `payments` (quote_id), not from
 * invoices.paid_amount, so money received before an invoice existed still counts; baaki =
 * invoiced − paid.
 *
 * Project quotations: paid is `project_payments` (record_project_payment writes only there —
 * never to `payments`, so the two sums never overlap), and baaki is each invoice's own
 * balance from lib/payments/amount-due#invoiceAmountDue — the function the invoice PDF uses,
 * which already folds in net_payable, paid_amount (kept by trg_project_payment_sync_invoice)
 * and a paid/void status. A milestone paid before it was invoiced is therefore not "owed".
 *
 * No invoice is counted twice: one that is reachable both through a quote and through a
 * project milestone counts once, on the project side. Void invoices and refunded payments
 * do not count.
 */
export function dealMoney(src: Pick<DealHistorySources, "invoices" | "payments" | "projects" | "projectMilestones" | "projectInvoices" | "projectPayments">): DealMoney {
  const pInvs = dedupeById(src.projectInvoices ?? []).filter((i) => i.status !== "void");
  const pIds = new Set((src.projectInvoices ?? []).map((i) => i.id));
  const qInvs = dedupeById(src.invoices ?? []).filter((i) => i.status !== "void" && !pIds.has(i.id));
  const qPays = dedupeById(src.payments ?? []).filter((p) => !p.refunded_at && p.status !== "refunded");
  const pPays = dedupeById(src.projectPayments ?? []);

  const sum = <T>(rows: readonly T[], f: (r: T) => number | null | undefined) => rows.reduce((s, r) => s + (f(r) ?? 0), 0);
  const qInvoiced = sum(qInvs, (i) => i.amount);
  const qPaid = sum(qPays, (p) => p.amount);
  const pInvoiced = sum(pInvs, (i) => i.amount);
  const pPaid = sum(pPays, (p) => p.amount);
  const pDue = sum(pInvs, (i) => invoiceAmountDue(i));

  const liveProjects = new Set((src.projects ?? []).filter((p) => (p.status ?? "") !== "cancelled").map((p) => p.id));
  const value = sum((src.projects ?? []).filter((p) => liveProjects.has(p.id)), (p) => p.total_amount);
  const notInvoiced = sum((src.projectMilestones ?? []).filter((m) => !m.invoice_id && liveProjects.has(m.project_id)), (m) => m.total_amount);

  const invoiceCount = qInvs.length + pInvs.length;
  return {
    invoiced: qInvoiced + pInvoiced,
    paid: qPaid + pPaid,
    outstanding: invoiceCount > 0 ? (qInvs.length > 0 ? Math.max(0, qInvoiced - qPaid) : 0) + pDue : null,
    invoiceCount,
    paymentCount: qPays.length + pPays.length,
    project: { invoiced: pInvoiced, paid: pPaid, tds: sum(pPays.filter((p) => p.method === "tds"), (p) => p.amount), value, notInvoiced },
  };
}

function dedupeById<T extends { id: string }>(rows: readonly T[]): T[] {
  return [...new Map(rows.map((r) => [r.id, r])).values()];
}
