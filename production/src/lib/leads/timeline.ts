/**
 * One chronological stream for a lead — activities, quotes, tasks and payments together.
 *
 * ─── WHY MERGE AT ALL ───────────────────────────────────────────────────────
 * The drawer already loads all of these; it just shows them in separate places. So a rep
 * asking "what has actually happened with this customer" reads three lists and does the
 * interleaving in their head — and gets it wrong, because the lists sort independently.
 * The quote sent on the 3rd appears above the call made on the 5th purely because quotes
 * render first.
 *
 * ─── WHAT IT REFUSES TO DO ──────────────────────────────────────────────────
 * An entry with no usable timestamp is DROPPED and counted, not placed at the top or
 * bottom with a guessed date. In a chronological view, a wrongly-placed event is worse
 * than a missing one: it invents a sequence of events that never happened, and sequence
 * is the only thing a timeline is for. The count is returned so the UI can say so.
 */

export type TimelineKind =
  | "activity" | "quote" | "task" | "payment";

export interface TimelineEntry {
  id: string;
  kind: TimelineKind;
  /** ISO timestamp. Entries without one never reach here. */
  at: string;
  /** One-line summary, already human-readable. */
  title: string;
  /** Optional second line. */
  detail?: string | null;
  /** Rupee amount where the event carries one. */
  amount?: number | null;
  /** Sub-type, e.g. the activity kind or the quote status — for the icon. */
  variant?: string | null;
  /** R-341: where clicking the row goes — the record itself. null = the event has no page of
   *  its own (a call, a note, a stage change live only in this stream), so the row is not a link. */
  href: string | null;
}

/** R-341: same shape as the deal timeline's quoteHref (src/lib/deals/timeline.ts). */
export const quoteHref = (id: string) => `/quotes/${encodeURIComponent(id)}`;

/** R-341: the tasks page opens this task's dialog from `?task=<id>`; tab=all so the task sits
 *  in the list behind the dialog whatever its due date or status. */
export const taskHref = (id: string) => `/tasks?tab=all&task=${encodeURIComponent(id)}`;

/** Sources as the drawer already has them. Deliberately loose — this is a merge, not a fetch. */
export interface TimelineSources {
  activities?: ReadonlyArray<{ id: string; kind: string; detail?: string | null; created_at?: string | null }>;
  quotes?: ReadonlyArray<{ id: string; status?: string | null; amount?: number | null; created_at?: string | null; created_date?: string | null }>;
  tasks?: ReadonlyArray<{ id: string; title: string; kind?: string | null; status?: string | null; due_at?: string | null; created_at?: string | null }>;
  /** quote_id: a lead's payment is recorded against its quote, and the quote page is where the
   *  payment and its receipt live — so that is where the row goes. */
  payments?: ReadonlyArray<{ id: string; amount?: number | null; method?: string | null; created_at?: string | null; paid_at?: string | null; quote_id?: string | null }>;
}

export interface Timeline {
  entries: TimelineEntry[];
  /** Entries dropped for having no usable date. Reported so the UI can admit the gap. */
  undated: number;
}

/** First usable ISO timestamp from the candidates, or null. */
function firstDate(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    if (!c) continue;
    const t = new Date(c).getTime();
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  return null;
}

const ACTIVITY_TITLE: Readonly<Record<string, string>> = {
  call:     "Call logged",
  whatsapp: "WhatsApp sent",
  email:    "Email sent",
  email_in: "Email received",
  note:     "Note added",
  quote:    "Quote activity",
  stage:    "Stage changed",
};

const QUOTE_TITLE: Readonly<Record<string, string>> = {
  draft:    "Quote drafted",
  sent:     "Quote sent",
  viewed:   "Quote viewed by customer",
  accepted: "Quote accepted",
  rejected: "Quote rejected",
  expired:  "Quote expired",
};

/**
 * Merge everything into one stream, newest first.
 *
 * Ties break by kind then id so the order is TOTAL — two events recorded in the same
 * second must not swap places between renders, or a rep re-reading the drawer sees a
 * different history.
 */
export function buildTimeline(src: TimelineSources): Timeline {
  const entries: TimelineEntry[] = [];
  let undated = 0;

  for (const a of src.activities ?? []) {
    const at = firstDate(a.created_at);
    if (!at) { undated++; continue; }
    entries.push({
      id: `activity:${a.id}`, kind: "activity", at,
      title: ACTIVITY_TITLE[a.kind] ?? a.kind,
      detail: a.detail ?? null, variant: a.kind,
      /* An email/WhatsApp/call/note activity is stored only as this row — no page shows it
         better than the stream itself, so it is not a link. */
      href: null,
    });
  }

  for (const q of src.quotes ?? []) {
    const at = firstDate(q.created_at, q.created_date);
    if (!at) { undated++; continue; }
    entries.push({
      id: `quote:${q.id}`, kind: "quote", at,
      title: QUOTE_TITLE[q.status ?? ""] ?? "Quote",
      detail: q.id, amount: q.amount ?? null, variant: q.status ?? null,
      href: quoteHref(q.id),
    });
  }

  for (const t of src.tasks ?? []) {
    /* Tasks are placed by when they were CREATED, not when they are due. A task due next
       Friday did not happen next Friday; putting it there would show the future inside a
       history. The due date rides in the detail line instead. */
    const at = firstDate(t.created_at, t.due_at);
    if (!at) { undated++; continue; }
    entries.push({
      id: `task:${t.id}`, kind: "task", at,
      title: t.status === "done" ? `Task done — ${t.title}` : `Task — ${t.title}`,
      detail: t.due_at ? `Due ${t.due_at.slice(0, 10)}` : null,
      variant: t.status ?? null,
      href: taskHref(t.id),
    });
  }

  for (const p of src.payments ?? []) {
    const at = firstDate(p.paid_at, p.created_at);
    if (!at) { undated++; continue; }
    entries.push({
      id: `payment:${p.id}`, kind: "payment", at,
      title: "Payment received",
      detail: p.method ?? null, amount: p.amount ?? null, variant: p.method ?? null,
      href: p.quote_id ? quoteHref(p.quote_id) : null,
    });
  }

  entries.sort((a, b) =>
    b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

  return { entries, undated };
}

/** Icon + tone per kind, so every row of the stream renders from one rule. */
export function timelineMeta(e: TimelineEntry): { icon: string; tone: string } {
  if (e.kind === "payment") return { icon: "rupee", tone: "text-emerald" };
  if (e.kind === "quote")   return { icon: "file", tone: "text-amber-ink" };
  if (e.kind === "task")    return { icon: e.variant === "done" ? "check" : "clock", tone: "text-indigo" };
  const byVariant: Record<string, string> = {
    call: "mobile", whatsapp: "whatsapp", email: "mail", email_in: "mail",
    note: "edit", stage: "target", quote: "file",
  };
  return { icon: byVariant[e.variant ?? ""] ?? "clock", tone: "text-ink-3" };
}
