/**
 * R-2403 — Renewals as ONE work queue (Pardeep, 3 Nov 2026: "renewal page ke liye deep audit and
 * analysis karke ise aur improve karo take user ko aur team ko kaam karne me aasani ho").
 *
 * Audit on staging (Anutech-HQ/drafts/RENEWALS-AUDIT/page-audit.md), what this file fixes:
 *  - the At risk TAB listed the same rows as Urgent → Expired (classify.ts atRisk ⊇ expired), so
 *    the team checked them twice. Tabs are now time windows only — Overdue · ≤7 days · 8–30 ·
 *    31–60 · 61–90 — and every row is in exactly one; "At risk" is a filter chip.
 *  - one row showed "Expired 2d" + "Renewed" + "Grace over" + "1 month due" + "Renewed — nothing
 *    to send" (Ravi Shankar, billed monthly). A row now has ONE status, from renewalRowStatus().
 *  - a subscription billed in parts read "Expired 33d" (REDOQ): its real state is "Oct bill not
 *    raised" — the action is the part's bill, not a renewal quote.
 *  - every expired row said "Grace over" at 2 days, because the company grace is 0–1 day: the
 *    grace line now shows only when there IS a grace (> 0 days) to be in or out of.
 *  - the amount was MRR "/mo" even for a yearly renewal: the row shows what the customer will be
 *    asked to pay for the term — the open renewal quote's total (incl. GST), else the term amount
 *    (+ GST).
 *
 * No second copy of the rules: buckets/grace/at-risk come from classify.ts, the paid rule from
 * reminders.ts (isTerminalRenewal), the parts-due count from lib/renewals/split-billed-next-part,
 * the row's action from row-action.ts / renewal-actions-rules.ts, the term amount from
 * lib/billing/subscription-schedule (termAmountOf). Pure — tested in queue.test.ts.
 */
import { effectiveGraceDays } from "@/lib/renewals/cadence";
import { partsDue } from "@/lib/renewals/split-billed-next-part";
import { isSplitBilled } from "@/lib/billing/instalments";
import { termAmountOf } from "@/lib/billing/subscription-schedule";
import { nonRenewingLabel } from "@/lib/subscriptions/non-renewing";
import { rupee, formatDate } from "@/lib/utils";
import { RENEWAL_URGENT_DAYS, RENEWAL_UPCOMING_DAYS, RENEWAL_FUTURE_DAYS, RENEWAL_EXCLUDED_STATUS } from "@/lib/renewals/buckets";
import type { BillingCycle } from "@/lib/supabase/database.types";
import { expiredGraceText, isStopped, type RenewalGroups } from "./classify";
import { isSettledRenewed } from "./row-action";
import { renewalDueText } from "./last-docs";
import { renewalActionSet, type RenewalActionSub } from "@/components/features/renewals/renewal-actions-rules";
import { bulkSendDecision, type RenewalStage, type StageKey } from "@/lib/renewals/stage";

// ─── Tabs ───────────────────────────────────────────────────────────────────

/**
 * The time windows. Order = the tab order. R-2586 (Pardeep, 8 Nov 2026: "annual commitment ka
 * koi bhi renewal show nahi kar raha hai"): "later" lists every renewal past 90 days — an annual
 * subscription renewing next year was on no tab while a flex sub's next monthly part always was.
 */
export const QUEUE_TABS = ["overdue", "due7", "d30", "d60", "d90", "later"] as const;
export type QueueTab = (typeof QUEUE_TABS)[number];

/**
 * R-2586: the tabs the tiles add up — the 90-day work window. Later is a look-ahead list only:
 * tiles, the forecast and the sidebar badge keep the 90-day rule.
 */
export const TILE_TABS = ["overdue", "due7", "d30", "d60", "d90"] as const satisfies readonly QueueTab[];

/** 31–60 / 61–90 split of the Future window (lib/renewals/buckets.ts keeps 31–90 as one). */
export const RENEWAL_D60_DAYS = 60;

export const QUEUE_TAB_LABEL: Record<QueueTab, string> = {
  overdue: "Overdue",
  due7: "≤7 days",
  d30: "8–30",
  d60: "31–60",
  d90: "61–90",
  later: "Later (91+ days)",
};

/** The tab for a row that is due (not overdue): by IST days to the renewal date. */
export function windowTab(daysUntil: number): QueueTab {
  if (daysUntil < 0) return "overdue";
  if (daysUntil <= RENEWAL_URGENT_DAYS) return "due7";
  if (daysUntil <= RENEWAL_UPCOMING_DAYS) return "d30";
  if (daysUntil <= RENEWAL_D60_DAYS) return "d60";
  if (daysUntil <= RENEWAL_FUTURE_DAYS) return "d90";
  return "later";
}

/**
 * R-2586: subscriptions the queue cannot place — no renewal_date (and not cancelled). They were
 * dropped from Renewals with no word; the page now names them, by customer, to be fixed.
 */
export function noRenewalDate<T extends { status: string; renewal_date: string | null; customer_name: string }>(subs: readonly T[]): T[] {
  return subs
    /* an ended (expired) subscription needs no renewal date — only live ones are work to fix */
    .filter((s) => s.renewal_date === null && s.status !== RENEWAL_EXCLUDED_STATUS && s.status !== "expired")
    .sort((a, b) => a.customer_name.localeCompare(b.customer_name));
}

/**
 * Every listed row in exactly ONE tab, built from classify.ts's groups (each row is in at most
 * one of them): Overdue = expired + service stopped; the windows = Next 7 days / upcoming /
 * future + the Won't-renew rows still running, split by date. R-2422: a flex (monthly-commitment)
 * subscription is a renewal like any other (R-2232's exclusion reversed by the owner, 3 Nov).
 */
export function queueTabs<T extends { daysUntil: number }>(g: RenewalGroups<T>): Record<QueueTab, T[]> {
  const out: Record<QueueTab, T[]> = { overdue: [], due7: [], d30: [], d60: [], d90: [], later: [] };
  out.overdue.push(...g.expired, ...g.stopped);
  /* R-2586: g.later = chased renewals past 90 days (classify.ts); a far Won't renew row lands in later too. */
  for (const r of [...g.due7, ...g.upcoming, ...g.future, ...g.later, ...g.nonRenewing]) {
    const t = windowTab(r.daysUntil);
    if (t !== "overdue") out[t].push(r);
  }
  return out;
}

/** ?bucket= values from before R-2403 (sidebar badge, old links) → the tab, + the At risk chip. */
export const LEGACY_BUCKETS = ["urgent", "upcoming", "future", "risk"] as const;
export type LegacyBucket = (typeof LEGACY_BUCKETS)[number];

/**
 * The tab a ?bucket= value opens. "urgent" (the sidebar badge = Overdue + ≤7 days, R-1541) opens
 * Overdue when anything is overdue, else ≤7 days; "risk" opens Overdue with the At risk chip on.
 */
export function resolveBucket(
  raw: QueueTab | LegacyBucket,
  counts: Record<QueueTab, number>,
): { tab: QueueTab; atRisk: boolean } {
  switch (raw) {
    case "urgent":   return { tab: counts.overdue > 0 ? "overdue" : "due7", atRisk: false };
    case "upcoming": return { tab: "d30", atRisk: false };
    case "future":   return { tab: "d60", atRisk: false };
    case "risk":     return { tab: counts.overdue > 0 ? "overdue" : "due7", atRisk: true };
    default:         return { tab: raw, atRisk: false };
  }
}

// ─── One status per row ─────────────────────────────────────────────────────

/* R-2728: "quote-sent" — the renewal quote (or the renewal's part proforma) is with the customer, unpaid. */
export type RowStatusKey = "stopped" | "non-renewing" | "renewed" | "quote-sent" | "bills-not-raised" | "overdue" | "due";

export interface RowStatus {
  key: RowStatusKey;
  /** The ONE chip on the row. */
  label: string;
  tone: "danger" | "warning" | "info" | "success" | "muted";
  /** A second line only when it adds information (grace stop date, grace over). */
  note: string | null;
}

/** R-2728: the row status (and status filter value) once the renewal quote / part bill went to the customer. */
export const RENEWAL_QUOTE_SENT = "Renewal quote sent";

/** Status filter options (the chip labels are per row; the filter groups them). */
export const STATUS_FILTER_LABEL: Record<RowStatusKey, string> = {
  overdue: "Overdue",
  "quote-sent": RENEWAL_QUOTE_SENT,
  "bills-not-raised": "Bill not raised",
  due: "Due",
  renewed: "Renewed",
  "non-renewing": "Non-renewing",
  stopped: "Service stopped",
};

/**
 * R-2760 (R-2738 followUp): the status filter on the row's ONE stage (lib/renewals/stage.ts) — the
 * words the chip says. Tiles still add up by time window (tiles.ts).
 */
export const STAGE_FILTER_LABEL: Record<StageKey, string> = {
  due: "Not sent",
  "part-due": "Part not billed",
  draft: "Draft part quote",
  sent: "Quote sent",
  "quote-closed": "Quote closed",
  invoiced: "Invoiced",
  renewed: "Renewed",
  ending: "Won't renew",
  stopped: "Stopped",
};
export const STAGE_FILTER_ORDER = Object.keys(STAGE_FILTER_LABEL) as StageKey[];

export interface StatusSub {
  status?: string | null;
  renewal_state?: string | null;
  renewal_date: string | null;
  term_months?: number | null;
  billing_cycle?: string | null;
  start_date?: string | null;
  auto_renew?: boolean | null;
  grace_until?: string | null;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * The row's ONE status. First match wins:
 *   Service stopped → Non-renewing · ends <date> → Renewed (its renewal quote is paid) →
 *   R-2728 "Renewal quote sent" for the renewal's part proforma that Bill next part raised and is
 *   unpaid (it beats the 'renewed' state Bill next part's roll leaves — the money is not in) →
 *   Renewed (settled — a stale open renewal quote does not undo it) → billed in parts and a part
 *   is due → R-2728 "Renewal quote sent" (the renewal quote is with the customer, unpaid; past the
 *   date it keeps the grace line, and the date cell says "Overdue Nd"): "<Mon> bill not raised" / "N bills not raised"
 *   → past the date: "Overdue Nd" (+ the grace line only when the grace is > 0 days)
 *   → "Due today" / "Due in Nd".
 * A stale 'renewed' state on a row whose date has passed is NOT "Renewed": the new term was not
 * paid (record_payment rolls renewal_date on when it is) — Ravi Shankar's case.
 */
export function renewalRowStatus(
  sub: StatusSub,
  daysUntil: number,
  opts: { tenantGraceDays: number; today?: Date; renewalPaid?: boolean; quoteSent?: { quoteId: string; kind: "renewal" | "part" } | null },
): RowStatus {
  const today = opts.today ?? new Date();
  if (isStopped({ ...sub, mrr: 0 })) return { key: "stopped", label: "Service stopped", tone: "danger", note: null };
  if (sub.auto_renew === false) return { key: "non-renewing", label: nonRenewingLabel(sub), tone: "warning", note: null };
  if (opts.renewalPaid) return { key: "renewed", label: "Renewed", tone: "success", note: null };
  /* R-2728: past the date and in / out of grace — the overdue line, also under "Renewal quote sent". */
  const graceNote = (): string | null => {
    if (daysUntil >= 0 || !sub.renewal_date) return null;
    const grace = effectiveGraceDays({ tenantGraceDays: opts.tenantGraceDays, renewalDate: sub.renewal_date, graceUntil: sub.grace_until ?? null });
    /* R-2403: with no grace at all, "Grace over" on every row was noise (audit problem 2). */
    return grace > 0 ? expiredGraceText(sub, daysUntil, opts.tenantGraceDays) : null;
  };
  const sent: RowStatus = { key: "quote-sent", label: RENEWAL_QUOTE_SENT, tone: "info", note: null };
  /* R-2728: Bill next part's roll leaves renewal_state 'renewed' while the part proforma is unpaid — not Renewed. */
  if (opts.quoteSent?.kind === "part") return sent;
  if (isSettledRenewed(sub, today)) return { key: "renewed", label: "Renewed", tone: "success", note: null };

  const behind = billsNotRaised(sub, today);
  /* R-2095 kept: more than one part behind → Bill next part bills them one by one, oldest first. */
  if (behind) return { key: "bills-not-raised", label: behind.label, tone: "danger", note: behind.count > 1 ? `From ${formatDate(behind.from)} — billed oldest first` : null };

  if (opts.quoteSent) return { ...sent, note: graceNote() };
  if (daysUntil < 0) return { key: "overdue", label: renewalDueText(daysUntil), tone: "danger", note: graceNote() };
  if (daysUntil === 0) return { key: "due", label: renewalDueText(0), tone: "danger", note: null };
  return {
    key: "due",
    label: renewalDueText(daysUntil),
    tone: daysUntil <= RENEWAL_URGENT_DAYS ? "danger" : daysUntil <= RENEWAL_UPCOMING_DAYS ? "warning" : "muted",
    note: null,
  };
}

/**
 * A subscription billed in parts whose parts after renewal_date have started unbilled:
 * one → "Oct bill not raised" (the month the part starts), more → "3 bills not raised".
 */
export function billsNotRaised(sub: StatusSub, today: Date = new Date()): { count: number; from: string; label: string } | null {
  if (!isSplitBilled((sub.billing_cycle ?? null) as BillingCycle | null) || !sub.renewal_date) return null;
  const todayISO = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kolkata" }).format(today);
  const due = partsDue({
    billing_cycle: (sub.billing_cycle ?? null) as BillingCycle | null,
    term_months: sub.term_months ?? 12,
    start_date: sub.start_date ?? null,
    renewal_date: sub.renewal_date,
  }, todayISO);
  if (!due) return null;
  const label = due.count === 1 ? `${MONTHS[Number(due.from.slice(5, 7)) - 1]} bill not raised` : `${due.count} bills not raised`;
  return { count: due.count, from: due.from, label };
}

// ─── The renewal amount ─────────────────────────────────────────────────────

export interface AmountSub {
  mrr: number;
  term_months?: number | null;
  term_amount?: number | null;
  billing_cycle?: string | null;
}

export interface RenewalQuoteInfo {
  id: string;
  amount: number | null;
  status: string | null;
  payment_status?: string | null;
}

const CLOSED_QUOTE = new Set(["rejected", "expired", "cancelled", "void", "invoiced"]);

/** "/yr", "/mo", "/qtr", "/6 mo", "/2 yr", "/N mo" — the term the amount covers. */
export function termSuffix(termMonths: number | null | undefined): string {
  const m = Math.max(1, termMonths ?? 12);
  if (m === 12) return "/yr";
  if (m === 1) return "/mo";
  if (m === 3) return "/qtr";
  if (m % 12 === 0) return `/${m / 12} yr`;
  return `/${m} mo`;
}

export interface RenewalAmount {
  /** Rupees, for sorting and the bulk total. */
  value: number;
  /** "₹78,000/yr" or "₹92,040". */
  text: string;
  /** "+ GST" (term amount, ex-GST) or "incl. GST · Q-x" (the renewal quote's total). */
  gst: string;
  fromQuote: boolean;
}

/**
 * What the customer is asked to pay for the term: the linked open renewal quote's total
 * (incl. GST) when there is one, else the term amount (ex-GST, "+ GST") — the same choice
 * Payment Follow-up makes for its renewal rows (lib/queries/collections.ts, R-2401).
 */
export function renewalAmount(sub: AmountSub & { renewal_quote_id?: string | null }, quote: RenewalQuoteInfo | null | undefined): RenewalAmount {
  /* R-2422: how it is paid ("Annual · paid quarterly · ₹19,500 each") is frequency.ts — one wording. */
  const q = quote && sub.renewal_quote_id === quote.id && !CLOSED_QUOTE.has(quote.status ?? "") && (quote.amount ?? 0) > 0
    ? quote : null;
  if (q) {
    const v = Math.round(q.amount ?? 0);
    return { value: v, text: rupee(v), gst: `incl. GST · ${q.id}`, fromQuote: true };
  }
  const v = termAmountOf({ mrr: sub.mrr, term_months: sub.term_months ?? 12, term_amount: sub.term_amount ?? null });
  return { value: v, text: `${rupee(v)}${termSuffix(sub.term_months)}`, gst: "+ GST", fromQuote: false };
}

/** A renewal quote that is paid — the row is renewed even if its date has not moved yet. */
export function isPaidRenewalQuote(sub: { renewal_quote_id?: string | null }, quote: RenewalQuoteInfo | null | undefined): boolean {
  /* R-2404: quotes.payment_status is none / awaiting / partial / received / invoiced — there is no
     "paid" (R-2403 asked for it, so no paid renewal ever left Overdue). "received" = the money is
     in; "invoiced" is not proof of payment (an invoice can be raised on an accepted, unpaid quote). */
  return !!quote && sub.renewal_quote_id === quote.id && quote.payment_status === "received";
}

// ─── Sort + filter ──────────────────────────────────────────────────────────

export type QueueSort = "date" | "amount";

export interface QueueRow {
  id: string;
  daysUntil: number;
  amount: number;
  plan: string | null;
  vendor: string | null;
  statusKey: RowStatusKey;
  /** R-2760: the row's stage (null while its documents load — it matches no stage filter until then). */
  stageKey?: StageKey | null;
  atRisk: boolean;
  customer: string;
  /** R-2422: Annual / Monthly (flex) commitment (frequency.ts renewalCommitment); null = unknown. */
  commitment?: "annual" | "monthly" | null;
}

/** Date = soonest (most overdue) first; amount = largest first. Ties by customer name. */
export function sortQueue<T extends QueueRow>(rows: readonly T[], by: QueueSort): T[] {
  return [...rows].sort((a, b) => {
    const d = by === "amount" ? b.amount - a.amount : a.daysUntil - b.daysUntil;
    return d !== 0 ? d : a.customer.localeCompare(b.customer);
  });
}

export interface QueueFilters {
  product: string;   // "" = all
  /** R-2760: a stage (STAGE_FILTER_LABEL); "" = all. */
  status: StageKey | "";
  vendor: string;    // "" = all
  atRisk: boolean;
  /** R-2422: All · Annual · Monthly. */
  commitment: "all" | "annual" | "monthly";
}

export const NO_FILTERS: QueueFilters = { product: "", status: "", vendor: "", atRisk: false, commitment: "all" };

export function filterQueue<T extends QueueRow>(rows: readonly T[], f: QueueFilters): T[] {
  return rows.filter((r) =>
    (!f.product || (r.plan ?? "") === f.product)
    && (!f.status || r.stageKey === f.status)
    && (!f.vendor || (r.vendor ?? "") === f.vendor)
    && (!f.atRisk || r.atRisk)
    && (f.commitment === "all" || r.commitment === f.commitment));
}

/** The distinct, sorted values for a filter's options. */
export function filterOptions(values: readonly (string | null | undefined)[]): string[] {
  return [...new Set(values.filter((v): v is string => !!v && v.trim() !== ""))].sort((a, b) => a.localeCompare(b));
}

// ─── Bulk: Send renewal (R-2760, on the stage) ──────────────────────────────

/** R-2738 followUp: stage.ts has no input for it — a row with no customer email cannot be sent a renewal. */
export const NO_EMAIL_REASON = "no email on file — add one on the customer first";

/**
 * R-2760: bulk Send renewal takes exactly the rows whose ONE stage says the whole-term renewal is
 * still to send (bulkSendDecision — never a split row, R-808; never one sent / invoiced / renewed,
 * R-2232; not 91+ days out, R-2586) AND that have an email to send to. Every other row is named
 * with its reason. A row still loading its documents is skipped (never sent on a half-known stage).
 */
export function bulkStageTargets<T extends { stage: RenewalStage | null }>(
  rows: readonly T[],
  /** undefined = contacts not read yet; null / "" = none on file. */
  emailOf: (row: T) => string | null | undefined,
): { send: T[]; skipped: { row: T; reason: string }[] } {
  const send: T[] = [];
  const skipped: { row: T; reason: string }[] = [];
  for (const r of rows) {
    if (!r.stage) { skipped.push({ row: r, reason: "still loading — try again in a moment" }); continue; }
    const d = bulkSendDecision(r.stage);
    if (!d.send) { skipped.push({ row: r, reason: d.reason }); continue; }
    const email = emailOf(r);
    if (email === undefined) { skipped.push({ row: r, reason: "contact details still loading — try again in a moment" }); continue; }
    if (!(email ?? "").trim()) { skipped.push({ row: r, reason: NO_EMAIL_REASON }); continue; }
    send.push(r);
  }
  return { send, skipped };
}

// ─── Bulk: Send renewal quote (older rule, kept for its callers) ────────────

/** R-2586: why bulk Send renewal quote skips a Later row — named in its confirm. */
export const LATER_SKIP_REASON = "renews in 91+ days — too early to send";

/**
 * Which selected rows "Send renewal quote" can email: those whose own row button is the
 * send-now action (renewal-actions-rules.ts) — never a renewed, Won't-renew or stopped row, and
 * never one billed in parts (a whole-term quote would bill twice, R-808: its button is Bill next
 * part). The rest are named as skipped in the confirm.
 */
export function bulkQuoteTargets<T extends { sub: RenewalActionSub & { customer_name: string }; daysUntil: number }>(
  rows: readonly T[],
  quoteStatus: (quoteId: string | null) => string | null,
  tenantGraceDays: number,
): { send: T[]; skipped: { row: T; reason: string }[] } {
  const send: T[] = [];
  const skipped: { row: T; reason: string }[] = [];
  for (const r of rows) {
    const set = renewalActionSet(r.sub, quoteStatus(r.sub.renewal_quote_id), {
      daysUntil: r.daysUntil, tenantGraceDays, canEndSubscription: false,
    });
    /* R-2586: a Later row (91+ days) is a look-ahead — a bulk renewal quote that early is never sent. */
    if (set.primary?.kind === "send-now" && r.daysUntil > RENEWAL_FUTURE_DAYS) { skipped.push({ row: r, reason: LATER_SKIP_REASON }); continue; }
    if (set.primary?.kind === "send-now") { send.push(r); continue; }
    const reason = set.primary?.kind === "generate"
      ? `billed in parts — use ${set.primary.label}` /* R-2548: the row's own button name */
      : set.row.text ?? (r.sub.auto_renew === false ? "won't renew" : "nothing to send");
    skipped.push({ row: r, reason });
  }
  return { send, skipped };
}

export function bulkQuoteConfirm(
  send: readonly { sub: { customer_name: string } }[],
  skipped: readonly { row: { sub: { customer_name: string } }; reason: string }[],
): { title: string; body: string } {
  const n = send.length;
  const names = send.slice(0, 5).map((r) => r.sub.customer_name).join(", ");
  const more = n > 5 ? `, and ${n - 5} more` : "";
  const skip = skipped.length > 0
    ? `\nNot sent (${skipped.length}): ${skipped.slice(0, 5).map((s) => `${s.row.sub.customer_name} — ${s.reason}`).join("; ")}${skipped.length > 5 ? `; and ${skipped.length - 5} more` : ""}.`
    : "";
  return {
    title: `Send the renewal quote to ${n} customer${n === 1 ? "" : "s"}?`,
    body: `Each gets the renewal email with its renewal quote and accept / pay link (the quote is created first where there is none).\n${names}${more}.${skip}`,
  };
}

// ─── Desktop table column budget (fits a 1280px laptop) ─────────────────────

/**
 * R-2403: the queue table shows from xl (1280px). With the sidebar open its card is ~944px wide
 * (measured for /subscriptions, R-2263), so: fixed columns + a readable minimum for the two
 * flexible ones (Customer with its contact line, Product with seats + vendor) stay inside it,
 * and the Actions column is always on screen. `table-fixed` keeps these widths.
 * R-2422: Actions is ONE next-step button + ⋯ now (was up to six stacked buttons), so it gives
 * 24px back to Customer, which also carries the "Last paid" line.
 */
/* R-2759 (R-2739b, 14 Nov): the table now shows from a 1260px window (QUEUE_TABLE_MIN_VIEWPORT_PX) — a
   1280 laptop has a 1264–1276px inner width, so the old xl (1280px) switch showed it the card list.
   Measured (R-2759 card spec): the table box is 974px at a 1280 window with an overlay scrollbar; a
   classic Windows scrollbar takes ~17px and a 1260 window 20px more → ~936px is the budget. Eight
   columns, every cell at most two lines:
   ☐ · Customer · Product & period · Due · Amount · Status · Last invoice · Action. */
export const QUEUE_TABLE_MIN_VIEWPORT_PX = 1260;
export const QUEUE_TABLE_BUDGET_PX = 936;
export const QUEUE_FLEX_MIN_PX = 108;
export type QueueColKey = "select" | "customer" | "product" | "due" | "amount" | "status" | "invoice" | "actions";
export const QUEUE_TABLE_COLS: ReadonlyArray<{ key: QueueColKey; label: string; width: number | null; align?: "right" }> = [
  { key: "select", label: "", width: 32 },
  { key: "customer", label: "Customer", width: null },
  { key: "product", label: "Product & period", width: null },
  { key: "due", label: "Due", width: 84 },
  { key: "amount", label: "Amount", width: 112, align: "right" },
  { key: "status", label: "Status", width: 152 },
  { key: "invoice", label: "Last invoice", width: 156 },
  /* "Record payment" + ⋯ on one line (the card spec checks no cell overflows) */
  { key: "actions", label: "Action", width: 184 },
];
