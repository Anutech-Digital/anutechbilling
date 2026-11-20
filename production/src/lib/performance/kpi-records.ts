/**
 * R-2965 — every Scorecards KPI opens the records behind its number.
 *
 * ONE source of truth: `buildPerfRows` picks, per person, the rows each KPI counts
 * (`PerfRecords`) and computes every tile number FROM those lists — the tile is
 * `records.<kpi>.length` (or the sum of their amounts for Revenue). The Sheet a tile opens
 * lists the same arrays, so the number and the list can never disagree.
 *
 * The rules are the score's own, unchanged from lib/queries/performance.ts (R-1588, R-2957):
 *   Revenue / Payments  payments.recorded_by = the person, status 'received', received_at in
 *                       the window (the read filters status + window).
 *   Deals won           leads.owner_id = the person, stage 'won', UPDATED_AT in the window
 *                       (not the date it was won — see `wonOutsideWindow`).
 *   Quotes              quotes.owner_id = the person, created_at in the window (renewal quotes
 *                       count too — the read does not filter is_renewal).
 *   Tasks on-time/late  tasks.owner_id = the person, status 'done', not a goal row, completed
 *                       in the window. On time = completed_at <= due_at (same instant counts as
 *                       on time); everything else — late OR no due date — is "late".
 *   Present days        attendance rows of the employee linked to the login (users.employee_id)
 *                       with a check-in, work_date in the window.
 *   Activity            activity_log rows with user_id = the person in the window.
 * Pure: no Supabase, no React — tests feed it rows.
 */
import {
  tallyKudos, badgesFor, type BadgeDef, type KudosRow,
} from "@/lib/performance/gamification";

/** Point weights — tune to taste. Documented so scores are explainable. */
export const PERF_WEIGHTS = {
  revenuePerRupees: 5000, // +1 pt per ₹5,000 collected
  dealWon: 40, // +40 per lead moved to 'won'
  quoteSent: 5, // +5 per quote raised
  paymentRecorded: 5, // +5 per payment collected
  taskOnTime: 3, // +3 per task completed on/before due
  taskLate: -1, // −1 per task completed after due
  kudosReceived: 10, // +10 per peer kudos (budgeted — see gamification.ts)
};

/* ── Input rows (what fetchPerformanceInputs reads) ─────────────────────────── */
export interface LeadIn {
  id: string; owner_id: string | null; value: number | null; stage: string; updated_at: string;
  stage_changed_at?: string | null; company?: string | null; contact_name?: string | null;
}
export interface QuoteIn {
  id: string; owner_id: string | null; created_at: string;
  customer_name?: string | null; amount?: number | null; status?: string | null; is_renewal?: boolean | null;
}
export interface PaymentIn {
  id: string; recorded_by: string | null; amount: number | null; received_at: string; status: string;
  quote_id: string | null; invoice_id?: string | null; customer_id?: string | null;
  method?: string | null; reference?: string | null;
}
export interface TaskIn {
  id: string; owner_id: string | null; status: string; due_at: string | null; completed_at: string | null;
  title?: string | null;
}
export interface UserIn { id: string; employee_id: string | null }
export interface AttendanceIn { id?: string; employee_id: string | null; work_date: string; check_in: string | null }
export interface ActivityIn { user_id: string | null; created_at: string; action?: string | null; entity?: string | null }

export interface PerfInputs {
  leads: readonly LeadIn[];
  quotes: readonly QuoteIn[];
  payments: readonly PaymentIn[];
  tasks: readonly TaskIn[];
  users: readonly UserIn[];
  attendance: readonly AttendanceIn[];
  activity: readonly ActivityIn[];
  kudos: readonly KudosRow[];
  /** Quotes (of this window's payments) that are renewal quotes — the Renewal Guardian badge. */
  renewalQuoteIds: ReadonlySet<string>;
}

export interface PerfMember { id: string; name: string; role: string }

/* ── Per-person records ─────────────────────────────────────────────────────── */
export interface PerfRecords {
  /** Payments counted in Revenue — the same list as `payments` (Revenue = their sum). */
  revenue: PaymentIn[];
  payments: PaymentIn[];
  dealsWon: LeadIn[];
  quotes: QuoteIn[];
  tasksOnTime: TaskIn[];
  tasksLate: TaskIn[];
  present: AttendanceIn[];
  activity: ActivityIn[];
  /** The employee linked to this login (users.employee_id) — Present days needs one. */
  employeeId: string | null;
}

export interface PerfBreakdown { label: string; detail: string; points: number }
export interface PerfRow {
  userId: string;
  /** R-2725: the employee this login is linked to (users.employee_id), null when none — the
   *  Employees table shows this row's score against that employee. */
  employeeId?: string | null;
  name: string;
  role: string;
  dealsWon: number;
  revenue: number;
  quotesSent: number;
  paymentsCount: number;
  tasksOnTime: number;
  tasksLate: number;
  presentDays: number;   // reliability (attendance) — this month
  activityCount: number; // leading signal (activity log) — this month
  score: number;
  breakdown: PerfBreakdown[];
  // ── Gamification (added 13 Aug 2026).
  kudosReceived?: number;
  distinctKudosGivers?: number;
  renewalPayments?: number;
  badges?: BadgeDef[];
  /** R-2965: the rows behind every number above (the tile = these lists). */
  records?: PerfRecords;
}

/** On time = completed at or before the due instant. A task with no due date is never on time. */
export function isOnTime(t: Pick<TaskIn, "completed_at" | "due_at">): boolean {
  return !!(t.completed_at && t.due_at && t.completed_at <= t.due_at);
}

/** The rows each KPI counts for one login. */
export function recordsFor(userId: string, inp: PerfInputs): PerfRecords {
  const employeeId = inp.users.find((u) => u.id === userId)?.employee_id ?? null;
  const payments = inp.payments.filter((p) => p.recorded_by === userId);
  const myTasks = inp.tasks.filter((t) => t.owner_id === userId);
  return {
    revenue: payments,
    payments,
    dealsWon: inp.leads.filter((l) => l.owner_id === userId),
    quotes: inp.quotes.filter((q) => q.owner_id === userId),
    tasksOnTime: myTasks.filter(isOnTime),
    tasksLate: myTasks.filter((t) => !isOnTime(t)),
    present: employeeId ? inp.attendance.filter((a) => a.employee_id === employeeId && !!a.check_in) : [],
    activity: inp.activity.filter((a) => a.user_id === userId),
    employeeId,
  };
}

export function sumAmounts(rows: readonly { amount: number | null | undefined }[]): number {
  return rows.reduce((s, r) => s + (r.amount ?? 0), 0);
}

/** Per-member outcome scores — every number is read off `recordsFor`. Highest score first. */
export function buildPerfRows(members: readonly PerfMember[], inp: PerfInputs): PerfRow[] {
  const kudos = tallyKudos([...inp.kudos]);
  const rows: PerfRow[] = members.map((mem) => {
    const records = recordsFor(mem.id, inp);
    const dealsWon = records.dealsWon.length;
    const revenue = sumAmounts(records.revenue);
    const paymentsCount = records.payments.length;
    const quotesSent = records.quotes.length;
    const tasksOnTime = records.tasksOnTime.length;
    const tasksLate = records.tasksLate.length;
    const renewalPayments = records.payments.filter((p) => p.quote_id && inp.renewalQuoteIds.has(p.quote_id)).length;
    const myKudos = kudos.byUser[mem.id] ?? { points: 0, received: 0, distinctGivers: 0 };

    const breakdown: PerfBreakdown[] = [
      { label: "Revenue collected", detail: `₹${revenue.toLocaleString("en-IN")}`, points: Math.round(revenue / PERF_WEIGHTS.revenuePerRupees) },
      { label: "Deals won", detail: `${dealsWon}`, points: dealsWon * PERF_WEIGHTS.dealWon },
      { label: "Quotes sent", detail: `${quotesSent}`, points: quotesSent * PERF_WEIGHTS.quoteSent },
      { label: "Payments collected", detail: `${paymentsCount}`, points: paymentsCount * PERF_WEIGHTS.paymentRecorded },
      { label: "Tasks on time", detail: `${tasksOnTime}`, points: tasksOnTime * PERF_WEIGHTS.taskOnTime },
      { label: "Tasks late", detail: `${tasksLate}`, points: tasksLate * PERF_WEIGHTS.taskLate },
    ];
    // Only shown once kudos exist, so the breakdown does not carry a
    // permanent "Peer kudos 0" line on a workspace that has none yet.
    if (myKudos.received > 0) {
      breakdown.push({
        label: "Peer kudos",
        detail: `${myKudos.received} from ${myKudos.distinctGivers} ${myKudos.distinctGivers === 1 ? "person" : "people"}`,
        points: myKudos.points,
      });
    }
    const score = Math.max(0, breakdown.reduce((s, b) => s + b.points, 0));

    return {
      userId: mem.id, employeeId: records.employeeId, name: mem.name, role: mem.role,
      dealsWon, revenue, quotesSent, paymentsCount, tasksOnTime, tasksLate,
      presentDays: records.present.length, activityCount: records.activity.length, score, breakdown,
      kudosReceived: myKudos.received,
      distinctKudosGivers: myKudos.distinctGivers,
      renewalPayments,
      badges: badgesFor({ score, tasksOnTime, renewalPayments, kudosReceived: myKudos.received, distinctKudosGivers: myKudos.distinctGivers }),
      records,
    };
  });
  return rows.sort((a, b) => b.score - a.score);
}

/* ── KPI keys + what the Sheet needs ────────────────────────────────────────── */
export type KpiKey = "revenue" | "dealsWon" | "quotes" | "payments" | "present" | "tasksOnTime" | "tasksLate" | "activity";

export const KPI_LABEL: Record<KpiKey, string> = {
  revenue: "Revenue", dealsWon: "Deals won", quotes: "Quotes", payments: "Payments",
  present: "Present days", tasksOnTime: "Tasks on-time", tasksLate: "Tasks late", activity: "Activity",
};

/** The tile's own number for a KPI (never re-counted elsewhere). */
export function kpiValue(row: PerfRow, kpi: KpiKey): number {
  switch (kpi) {
    case "revenue": return row.revenue;
    case "dealsWon": return row.dealsWon;
    case "quotes": return row.quotesSent;
    case "payments": return row.paymentsCount;
    case "present": return row.presentDays;
    case "tasksOnTime": return row.tasksOnTime;
    case "tasksLate": return row.tasksLate;
    case "activity": return row.activityCount;
  }
}

/** "No payments recorded by Asha in November 2026" — the empty Sheet says why. */
export function emptyReason(kpi: KpiKey, name: string, monthLabel: string, opts: { employeeLinked?: boolean } = {}): string {
  switch (kpi) {
    case "revenue":
    case "payments": return `No payments recorded by ${name} in ${monthLabel}.`;
    case "dealsWon": return `No leads owned by ${name} were marked won (or edited while won) in ${monthLabel}.`;
    case "quotes": return `No quotes owned by ${name} were created in ${monthLabel}.`;
    case "present": return opts.employeeLinked === false
      ? `${name}'s login is not linked to an employee, so there is no attendance to count. Link it on Employees & Users (Logins for attendance).`
      : `No check-ins for ${name} in ${monthLabel}.`;
    case "tasksOnTime": return `No tasks owned by ${name} were completed on time in ${monthLabel}.`;
    case "tasksLate": return `No tasks owned by ${name} were completed late (or without a due date) in ${monthLabel}.`;
    case "activity": return `No changes made by ${name} in the app in ${monthLabel}.`;
  }
}

/** Whole days a task finished after its due instant (0 = same day or on time); null without a due date. */
export function daysLate(t: Pick<TaskIn, "completed_at" | "due_at">): number | null {
  if (!t.due_at || !t.completed_at) return null;
  const ms = Date.parse(t.completed_at) - Date.parse(t.due_at);
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.ceil(ms / 86_400_000);
}

/** A won lead counted this month although its stage moved to won earlier (it was edited this month). */
export function wonOutsideWindow(l: Pick<LeadIn, "stage_changed_at">, start: string): boolean {
  return !!l.stage_changed_at && l.stage_changed_at < start;
}

/* ── Activity: counts by type, bulk changes apart ───────────────────────────── */
/** Rows written in one go (same instant — one transaction) by one person, at least this many,
 *  are a bulk change: an import, a bulk edit, or follow-on updates a single click caused. */
export const BULK_MIN_ROWS = 10;

export interface ActivityType { key: string; label: string; count: number }
export interface ActivitySummary {
  total: number;
  /** Rows changed one by one (smaller groups than BULK_MIN_ROWS). */
  ownCount: number;
  /** Rows written in bulk (BULK_MIN_ROWS+ at the same instant). ownCount + bulkCount = total. */
  bulkCount: number;
  /** Number of bulk operations. */
  bulkRuns: number;
  /** Top 10 action types; `other` holds the rest so the counts add up to `total`. */
  top: ActivityType[];
  other: { types: number; count: number };
  bulkTop: ActivityType[];
}

const VERB: Record<string, string> = { insert: "Added", update: "Changed", delete: "Deleted" };

export function activityTypeLabel(action: string | null | undefined, entity: string | null | undefined): string {
  const a = (action ?? "").trim();
  const what = (entity ?? "").replace(/_/g, " ").trim() || "record";
  const verb = VERB[a.toLowerCase()] ?? (a ? a.replace(/[_.]/g, " ") : "Action");
  return `${verb} · ${what}`;
}

function topTypes(rows: readonly ActivityIn[], n: number): { top: ActivityType[]; other: { types: number; count: number } } {
  const by = new Map<string, ActivityType>();
  for (const r of rows) {
    const key = `${r.action ?? ""}|${r.entity ?? ""}`;
    const t = by.get(key) ?? { key, label: activityTypeLabel(r.action, r.entity), count: 0 };
    t.count += 1;
    by.set(key, t);
  }
  const all = [...by.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const rest = all.slice(n);
  return { top: all.slice(0, n), other: { types: rest.length, count: rest.reduce((s, t) => s + t.count, 0) } };
}

export function summariseActivity(rows: readonly ActivityIn[]): ActivitySummary {
  const byInstant = new Map<string, number>();
  for (const r of rows) byInstant.set(r.created_at, (byInstant.get(r.created_at) ?? 0) + 1);
  const bulk = rows.filter((r) => (byInstant.get(r.created_at) ?? 0) >= BULK_MIN_ROWS);
  const bulkRuns = [...byInstant.values()].filter((c) => c >= BULK_MIN_ROWS).length;
  const { top, other } = topTypes(rows, 10);
  return {
    total: rows.length,
    ownCount: rows.length - bulk.length,
    bulkCount: bulk.length,
    bulkRuns,
    top,
    other,
    bulkTop: topTypes(bulk, 5).top,
  };
}
