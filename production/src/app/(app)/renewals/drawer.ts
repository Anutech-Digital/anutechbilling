/**
 * R-2740 (Pardeep 13 Nov screenshot + renewals audit §5.4 + user audit 14 Nov, job 2: "Is customer
 * ne pichhla term pay kiya?") — the Renewals row drawer's pure rules. Read-only: the drawer shows
 * the renewal's whole story on one screen; its only actions are the row's own ONE button + ⋯.
 *
 *   Documents  every quote + invoice linked to the subscription (last-docs.ts `{ all: true }` —
 *              the SAME links, status words and periods as the row), newest first; a revised-away
 *              quote says which revision replaced it; a cancelled one is greyed, never hidden.
 *              The first DRAWER_PAGE rows, then "Show all N".
 *   Payments   every captured payment (last-paid.ts, R-2752's links): date · amount · method ·
 *              the invoice (else quote) it paid.
 *   Follow-ups the renewal's payment_followups rows the page already read (who, when, note,
 *              promise, next date) + the reminder count on the subscription.
 *   Flags      every stage flag (R-2738 renewalStage) with ONE plain line saying what it means.
 *
 * ?sub=<subscription id> opens it (shareable, Back closes it). Tested in drawer-r2740.test.ts.
 */
import { formatDate, rupee } from "@/lib/utils";
import { currentTermStart, followingTermStart } from "@/lib/billing/subscription-schedule";
import { addDaysIso } from "@/lib/quotes/service-period";
import type { FlagKey, StageFlag } from "@/lib/renewals/stage";
import { VENDOR_HOLD_TITLE } from "@/lib/renewals/vendor-hold";
import {
  docMoney, invoiceStatusWords, invoiceTotalWords, periodWords, quoteStateLabel,
  type DocTone, type DrawerQuote, type LastDocs, type LastInvoice,
} from "./last-docs";
import { lastPaidSummary, type LastPaid } from "./last-paid";
import type { RenewalFollowupRow } from "./followup";

/** The URL parameter that opens the drawer (?sub=<subscription id>). */
export const DRAWER_PARAM = "sub";
/** Documents shown before "Show all N" (an old customer can have 200+). */
export const DRAWER_PAGE = 20;

const UUIDISH = /^[0-9a-zA-Z-]{8,64}$/;

/** The subscription id in a location.search, or null (anything that is not an id is ignored). */
export function drawerSubFromSearch(search: string): string | null {
  const v = new URLSearchParams(search).get(DRAWER_PARAM)?.trim() ?? "";
  return UUIDISH.test(v) ? v : null;
}

/** The same URL with ?sub= set (id) or removed (null); every other parameter kept. */
export function withDrawerSub(href: string, id: string | null): string {
  const url = new URL(href, "http://x");
  if (id) url.searchParams.set(DRAWER_PARAM, id); else url.searchParams.delete(DRAWER_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// ─── Documents ──────────────────────────────────────────────────────────────

export interface DrawerDocRow {
  kind: "quote" | "invoice";
  id: string;
  /** YYYY-MM-DD; null = not dated. */
  date: string | null;
  period: string | null;
  /** In the document's own currency ("₹40,000" / "$1,200"); null = not known. */
  amount: string | null;
  status: string;
  tone: DocTone;
  /** A quote replaced by a newer revision — its id. */
  replacedBy: string | null;
}

const VOID_QUOTE = new Set(["cancelled", "void"]);

/** One quote's line: Draft / Sent / Viewed / Accepted / Expired / Invoiced / Part paid / Paid, or Revised / Cancelled. */
export function drawerQuoteRow(q: DrawerQuote, todayIst: string): DrawerDocRow {
  const amount = q.amount == null ? null : docMoney({ currency: q.currency, fxRate: q.fxRate }, q.amount);
  const base = { kind: "quote" as const, id: q.id, date: q.date, period: q.period, amount, replacedBy: q.supersededBy };
  if (q.supersededBy) return { ...base, status: `Revised — replaced by ${q.supersededBy}`, tone: "muted" };
  if (VOID_QUOTE.has(q.status)) return { ...base, status: "Cancelled", tone: "muted" };
  const status = quoteStateLabel(q, todayIst);
  const tone: DocTone = status === "Paid" ? "ok" : status === "Draft" || status === "Expired" || status === "Rejected" ? "muted" : "warn";
  return { ...base, status, tone };
}

/** One invoice's line — the row's own words (R-2737 invoiceStatusWords). */
export function drawerInvoiceRow(i: LastInvoice, todayIst: string): DrawerDocRow {
  const s = invoiceStatusWords(i, todayIst);
  return { kind: "invoice", id: i.id, date: i.date, period: i.period, amount: invoiceTotalWords(i), status: s.text, tone: s.tone, replacedBy: null };
}

/**
 * Every quote + invoice, newest first. Each list comes already in its own exact order (last-docs.ts:
 * quotes by created_at, invoices by invoice date + created_at — two revisions of one day stay in the
 * order they were made); the two are merged by day, an invoice before a quote on the same day.
 */
export function drawerDocRows(docs: LastDocs | undefined, todayIst: string): DrawerDocRow[] {
  if (!docs) return [];
  const inv = (docs.allInvoices ?? docs.invoices ?? []).map((i) => drawerInvoiceRow(i, todayIst));
  const quo = (docs.allQuotes ?? []).map((q) => drawerQuoteRow(q, todayIst));
  const out: DrawerDocRow[] = [];
  let i = 0;
  let j = 0;
  while (i < inv.length || j < quo.length) {
    if (j >= quo.length || (i < inv.length && (inv[i].date ?? "") >= (quo[j].date ?? ""))) out.push(inv[i++]);
    else out.push(quo[j++]);
  }
  return out;
}

/** The rows to show: the first DRAWER_PAGE until "Show all" is pressed. */
export function drawerPage<T>(rows: readonly T[], showAll: boolean): { shown: T[]; hidden: number } {
  if (showAll || rows.length <= DRAWER_PAGE) return { shown: [...rows], hidden: 0 };
  return { shown: rows.slice(0, DRAWER_PAGE), hidden: rows.length - DRAWER_PAGE };
}

// ─── Payments ───────────────────────────────────────────────────────────────

export interface DrawerPaymentRow {
  id: string;
  date: string;
  amount: string;
  method: string;
  /** The invoice it paid, else the quote; null = not linked to a document. */
  doc: string | null;
  docKind: "invoice" | "quote" | null;
  shared: string | null;
}

/** Every captured payment on this subscription's documents, newest first (last-paid.ts history). */
export function drawerPaymentRows(paid: LastPaid | undefined): DrawerPaymentRow[] {
  return (paid?.history ?? []).map((p) => {
    const s = lastPaidSummary(p);
    return { id: p.paymentId, date: s.date, amount: s.amount, method: s.method, doc: s.doc, docKind: s.docKind, shared: s.shared };
  });
}

// ─── Terms ──────────────────────────────────────────────────────────────────

type TermSub = { renewal_date: string | null; term_months?: number | null; start_date?: string | null };

/** The term now running ("1 Dec 2025 – 30 Nov 2026"); null = no renewal date. */
export function currentTermWords(sub: TermSub): string | null {
  if (!sub.renewal_date) return null;
  const s = { term_months: sub.term_months ?? 12, start_date: sub.start_date ?? null, renewal_date: sub.renewal_date };
  const start = currentTermStart(s);
  const nextStart = followingTermStart(s);
  if (!start || !nextStart || nextStart <= start) return null;
  return periodWords(start, addDaysIso(nextStart, -1), sub.term_months ?? 12);
}

/** "12 months" / "1 month" / "3 years" — the term length in words. */
export function termLengthWords(months: number | null | undefined): string {
  const m = months && months > 0 ? months : 12;
  if (m % 12 === 0 && m >= 24) return `${m / 12} years`;
  return `${m} month${m === 1 ? "" : "s"}`;
}

// ─── Follow-ups ─────────────────────────────────────────────────────────────

export interface DrawerFollowupRow {
  id: string;
  /** When it was logged (formatted). */
  when: string;
  /** How (call / email / WhatsApp / note), as logged. */
  kind: string | null;
  who: string | null;
  note: string | null;
  outcome: string | null;
  promise: string | null;
  next: string | null;
}

const OUTCOME_WORDS: Record<string, string> = {
  renewal_confirmed: "Customer confirmed the renewal",
};

/** The renewal's follow-ups, newest first, as lines: who (assigned to) · when · note · promise · next date. */
export function drawerFollowupRows(rows: readonly RenewalFollowupRow[], nameOf: (id: string) => string | null): DrawerFollowupRow[] {
  return [...rows]
    .sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id))
    .map((r) => ({
      id: r.id,
      when: formatDate(r.created_at),
      kind: r.kind ? r.kind.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : null,
      who: r.assigned_to ? nameOf(r.assigned_to) ?? "a colleague" : null,
      note: r.note?.trim() || null,
      outcome: r.outcome ? OUTCOME_WORDS[r.outcome] ?? r.outcome.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) : null,
      promise: r.promised_on ? `Promised ${formatDate(r.promised_on)}${r.promised_amount ? ` · ${rupee(r.promised_amount)}` : ""}` : null,
      next: r.next_follow_up_on ? `Next follow-up ${formatDate(r.next_follow_up_on)}` : null,
    }));
}

/** "3 reminders sent · last 2 Nov 2026" / "No reminder sent yet" — from the subscription row. */
export function remindersWords(sub: { reminder_count?: number | null; last_reminder_sent_at_v2?: string | null; last_reminder_at?: string | null }): string {
  const n = Math.max(0, Number(sub.reminder_count) || 0);
  const last = sub.last_reminder_sent_at_v2 ?? sub.last_reminder_at ?? null;
  if (n === 0 && !last) return "No reminder sent yet";
  const count = n > 0 ? `${n} reminder${n === 1 ? "" : "s"} sent` : "Reminder sent";
  return last ? `${count} · last ${formatDate(last)}` : count;
}

// ─── Flags explained ────────────────────────────────────────────────────────

/** What each flag on the stage chip means, in one plain line (the row only had hover titles). */
export const FLAG_EXPLAIN: Record<FlagKey, { title: string; explain: string }> = {
  atRisk: { title: "At risk", explain: "Signs this customer may not renew — call them before the renewal date." },
  vendorHold: { title: "Vendor renewal on hold", explain: VENDOR_HOLD_TITLE },
  priorTermUnpaid: { title: "Previous term unpaid", explain: "Money from the term now ending is still owed — collect it along with this renewal." },
  promiseBroken: { title: "Promise broken", explain: "The customer promised to pay by a date that has passed, and the money has not come in." },
  followUpDue: { title: "Follow-up due", explain: "The next follow-up date on this renewal is today or already past — call or message, then log it." },
  /* R-2761: an open 'held' undo (R-2749) — the renewal date was kept although the part's payment was undone. */
  renewalHeld: { title: "Renewal held", explain: "A paid renewal part's payment was undone but the renewal date was kept — bill the part again, or make the subscription active / clear the quote link so the date moves back." },
};

export interface DrawerFlagRow { key: FlagKey | "nonRenewing" | "renewedAnyway"; title: string; reason: string; explain: string }

/** Each flag with its own reason (the chip's tooltip) and the plain line; plus Won't renew / Renewed anyway. */
export function drawerFlagRows(
  flags: readonly StageFlag[],
  extra: { nonRenewing?: { reason: string | null; saidOn: string | null } | null; renewedAnyway?: boolean; priorDueGap?: string | null } = {},
): DrawerFlagRow[] {
  const out: DrawerFlagRow[] = flags.map((f) => ({
    key: f.key,
    title: FLAG_EXPLAIN[f.key].title,
    reason: f.key === "priorTermUnpaid" && extra.priorDueGap ? `${f.reason} · ${extra.priorDueGap}` : f.reason,
    explain: FLAG_EXPLAIN[f.key].explain,
  }));
  if (extra.renewedAnyway) {
    out.push({ key: "renewedAnyway", title: "Renewed anyway", reason: "Renewed at the vendor before payment", explain: "An owner or manager chose to renew before the money came in — this term is still unpaid." });
  }
  if (extra.nonRenewing) {
    const r = extra.nonRenewing;
    out.push({
      key: "nonRenewing", title: "Won't renew",
      reason: [r.reason?.trim() || "Customer said they won't renew", r.saidOn ? `said on ${formatDate(r.saidOn)}` : null].filter(Boolean).join(" · "),
      explain: "No renewal will be sent; the subscription ends on its date. Undo it from the ⋯ menu if they change their mind.",
    });
  }
  return out;
}
