/**
 * /today — one ranked list of everything that wants a person today (S29).
 *
 * The list itself comes from the `today_inbox()` SQL function (migration
 * 20260928160000), which reads every queue under the caller's own RLS. Two things
 * live here instead, and both are pure so they are tested without a database:
 *
 *   1. GST / TDS deadlines. Their dates come from the code-owned catalog in
 *      lib/compliance/obligations.ts; the SQL deliberately does not carry a second
 *      copy of that calendar (AGENTS.md L106). `complianceTodayItems` turns the same
 *      rows the /compliance page shows into inbox items on the SQL function's scale.
 *   2. The merge. `rankTodayItems` orders exactly as the SQL does — priority desc,
 *      due_at asc with nulls last, then kind, then id — so merging the two sources
 *      cannot reorder what the database already ranked.
 *
 * The priority scale is documented once, at the top of the migration. The three
 * compliance numbers below are placed on it: an overdue statutory filing (88) sits
 * just under "paid, not delivered" (90), because it costs money per day and the
 * penalty has no cap on several of them.
 */
import { buildComplianceRows, type ComplianceCategory, type ComplianceProfile } from "@/lib/compliance/obligations";
import { daysBetweenISO, toIstDate } from "@/lib/dates/ist";

export type TodayKind =
  | "task"
  | "enquiry"
  | "whatsapp"
  | "support"
  | "automation"
  | "provisioning"
  | "purchase_inbox"
  | "approval"
  | "join_request"
  | "renewal"
  | "invoice_overdue"
  | "payment_failed"
  | "compliance"
  /* Built in code from open deals — lib/today/deals.ts. */
  | "deal_overdue"
  | "deal_quote_stale"
  | "deal_closing";

export interface TodayItem {
  kind: string;
  id: string;
  title: string;
  /** ISO instant, or null when the queue has no natural deadline. */
  due_at: string | null;
  /** 0–100, higher first. Scale: migration 20260928160000. */
  priority: number;
  /** In-app link to the screen that does the work. Always starts with "/". */
  href: string;
}

/** Label + icon per kind, for the row's leading chip. Unknown kinds still render. */
export const TODAY_KIND_META: Record<TodayKind, { label: string; icon: string }> = {
  task:            { label: "Task",          icon: "check" },
  enquiry:         { label: "Enquiry",       icon: "mail" },
  whatsapp:        { label: "WhatsApp",      icon: "message" },
  support:         { label: "Support",       icon: "ticket" },
  automation:      { label: "Automation",    icon: "sparkles" },
  provisioning:    { label: "Activation",    icon: "package" },
  purchase_inbox:  { label: "Purchase",      icon: "cart" },
  approval:        { label: "Approval",      icon: "check_circle" },
  join_request:    { label: "Join request",  icon: "users" },
  renewal:         { label: "Renewal",       icon: "refresh" },
  invoice_overdue: { label: "Overdue",       icon: "receipt" },
  payment_failed:  { label: "Autopay",       icon: "alert" },
  compliance:      { label: "GST / TDS",     icon: "calendar" },
  deal_overdue:     { label: "Deal late",       icon: "trending_up" },
  deal_quote_stale: { label: "Quote follow-up", icon: "mail" },
  deal_closing:     { label: "Closing",         icon: "target" },
};

export function kindMeta(kind: string): { label: string; icon: string } {
  return (TODAY_KIND_META as Record<string, { label: string; icon: string }>)[kind]
    ?? { label: kind, icon: "info" };
}

/** Which statutory categories /today surfaces. The rest stay on /compliance. */
export const TODAY_COMPLIANCE_CATEGORIES: ComplianceCategory[] = ["gst", "tds"];

/** How far ahead a filing starts to count as "today's" work. */
export const COMPLIANCE_WINDOW_DAYS = 7;

/** Midnight IST of a YYYY-MM-DD date, as an ISO instant (IST = UTC+05:30, no DST). */
function istMidnightISO(date: string): string {
  return new Date(`${date}T00:00:00+05:30`).toISOString();
}

/**
 * GST / TDS filings that are overdue or due within COMPLIANCE_WINDOW_DAYS and not
 * marked filed. `filed` is the same map the /compliance page builds from
 * compliance_log (`${obligation_key}|${period_key}` → filed date). `notApplicable`
 * is the same predicate too (R-181: no TDS deducted → no TDS deposit to chase).
 *
 * R-325: `profile` is the tenant's business type + GST mode (R-262), the same one the
 * /compliance page uses — so a QRMP filer sees the quarterly GSTR-3B / monthly PMT-06,
 * not a monthly GSTR-3B. Omitted / unknown → the Pvt Ltd, monthly-GST list, as before.
 */
export function complianceTodayItems(
  today: Date,
  filed: Map<string, string>,
  notApplicable?: (obligationKey: string, periodKey: string) => boolean,
  profile?: ComplianceProfile,
): TodayItem[] {
  return buildComplianceRows(today, filed, TODAY_COMPLIANCE_CATEGORIES, notApplicable, profile)
    .filter((r) => r.status !== "filed" && r.status !== "not_applicable" && r.daysToDue <= COMPLIANCE_WINDOW_DAYS)
    .map((r) => ({
      kind: "compliance",
      id: `${r.ob.key}|${r.inst.periodKey}`,
      title:
        (r.daysToDue < 0
          ? `${r.ob.name} — ${r.inst.periodLabel} · ${-r.daysToDue}d LATE`
          : r.daysToDue === 0
            ? `${r.ob.name} — ${r.inst.periodLabel} · due today`
            : `${r.ob.name} — ${r.inst.periodLabel} · due in ${r.daysToDue}d`),
      due_at: istMidnightISO(r.inst.dueDate),
      priority: r.daysToDue < 0 ? 88 : r.daysToDue <= 3 ? 78 : 62,
      href: "/compliance",
    }));
}

/** Same order as today_inbox()'s final ORDER BY. Returns a new array. */
export function rankTodayItems(items: readonly TodayItem[]): TodayItem[] {
  return [...items].sort((a, b) => {
    if (a.priority !== b.priority) return b.priority - a.priority;
    if (a.due_at !== b.due_at) {
      if (a.due_at === null) return 1;
      if (b.due_at === null) return -1;
      const d = Date.parse(a.due_at) - Date.parse(b.due_at);
      if (d !== 0) return d;
    }
    if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

/** Rows at or above this are shown under "Do first". */
export const URGENT_PRIORITY = 75;

/** Kinds whose due_at is when the thing ARRIVED, not a deadline — shown as a relative time. */
export const TODAY_ARRIVAL_KINDS: readonly string[] = [
  "enquiry", "whatsapp", "automation", "purchase_inbox", "join_request", "approval", "provisioning",
];

/**
 * "2d late", "due today", "in 3d" — by IST calendar day (R-241, 6 Oct 2026). It used to
 * compare milliseconds with Math.round: a filing due today (IST midnight) read "late" all
 * day, and tomorrow 15:00 read "due today" from 03:00. Returns "" when there is no usable
 * deadline, and null for arrival kinds (the page shows their relative arrival time).
 */
export function todayWhenLabel(item: TodayItem, now: number): string | null {
  if (TODAY_ARRIVAL_KINDS.includes(item.kind)) return null;
  if (!item.due_at) return "";
  const t = Date.parse(item.due_at);
  if (Number.isNaN(t)) return "";
  const days = daysBetweenISO(toIstDate(now), toIstDate(t));
  if (days < 0) return `${-days}d late`;
  if (days === 0) return "due today";
  return `in ${days}d`;
}
