/**
 * Quality Score (R-263, 6 Oct 2026) — the numbers behind /quality.
 *
 * Pardeep: "app world number one" — and perfect has to be measured. Every number here
 * comes from tables the app already writes; nothing is estimated, and a target the data
 * cannot answer yet is listed as "Not measured yet" instead of being left out (a page that
 * only shows what looks good is not a quality score).
 *
 *   first-invoice — signup (tenants.created_at) → that workspace's FIRST invoice, median.
 *   bug-fix       — bug report filed → marked fixed (feedback.resolved_at), median.
 *   open-bugs     — open bug reports (open + queued for the agent), by severity.
 *   money-bugs    — open bug reports about money (₹, GST, invoice, payment …), target 0.
 *   fixed-week    — fixes someone checked in the last 7 days (feedback.checked_at).
 *
 * A bug is what the TEXT says it is (inferred_type), falling back to what the reporter
 * picked — the same rule /admin/feedback uses, so "a bug" means one thing on both pages.
 * Pure: no clock, no I/O — `now` is passed in.
 */

export type QualityStatus = "green" | "amber" | "red" | "info" | "none";

export interface QualityMetric {
  id: string;
  label: string;
  /** The number, formatted ("8 min", "2", "—"). */
  value: string;
  /** The target in words ("≤ 10 min"). */
  target: string;
  status: QualityStatus;
  /** One line under the number: what it is counted over, or why it is red. */
  detail: string;
  /** Where to look next. */
  href?: string;
  hrefLabel?: string;
  /** false = a target the data cannot answer yet. */
  measured: boolean;
}

export interface QualityTenantRow { id: string; created_at: string }
export interface QualityInvoiceRow { tenant_id: string; created_at: string }
export interface QualityFeedbackRow {
  id: string;
  title: string;
  problem_summary: string | null;
  status: "open" | "agent_queued" | "fixed" | "wont_fix" | "duplicate";
  reported_type: "bug" | "feature" | "ui_improvement";
  inferred_type: "bug" | "feature" | "ui_improvement" | null;
  reported_severity: "low" | "medium" | "high" | "critical";
  created_at: string;
  resolved_at: string | null;
  checked_at: string | null;
}

export interface QualityInput {
  tenants: readonly QualityTenantRow[];
  invoices: readonly QualityInvoiceRow[];
  feedback: readonly QualityFeedbackRow[];
  /** false when the feedback.checked_at column is not on this database yet. */
  checkedAvailable: boolean;
}

/** The targets (Pardeep, 6 Oct 2026). */
export const QUALITY_TARGETS = {
  firstInvoiceMinutes: 10,
  /** Up to this is amber, beyond is red. */
  firstInvoiceAmberMinutes: 60,
  bugFixHours: 24,
  bugFixAmberHours: 72,
} as const;

const MIN = 60_000;
const HOUR = 60 * MIN;

export function median(xs: readonly number[]): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Lower is better: ≤ target green, ≤ amberUpTo amber, else red. No value = no colour. */
export function ragLowerBetter(value: number | null, target: number, amberUpTo: number): QualityStatus {
  if (value === null) return "none";
  if (value <= target) return "green";
  return value <= amberUpTo ? "amber" : "red";
}

export function formatMinutes(m: number): string {
  const r = Math.round(m);
  if (r < 60) return `${r} min`;
  if (r < 60 * 24) {
    const h = Math.floor(r / 60), rest = r % 60;
    return rest ? `${h} h ${rest} min` : `${h} h`;
  }
  return `${Math.round(r / (60 * 24))} d`;
}

/** Signup → earliest invoice, in minutes, one number per workspace that has an invoice. */
export function minutesToFirstInvoice(tenants: readonly QualityTenantRow[], invoices: readonly QualityInvoiceRow[]): number[] {
  const first = new Map<string, number>();
  for (const inv of invoices) {
    const t = Date.parse(inv.created_at);
    if (Number.isNaN(t)) continue;
    const had = first.get(inv.tenant_id);
    if (had === undefined || t < had) first.set(inv.tenant_id, t);
  }
  const out: number[] = [];
  for (const tn of tenants) {
    const inv = first.get(tn.id);
    const signup = Date.parse(tn.created_at);
    if (inv === undefined || Number.isNaN(signup)) continue;
    /* Imported data can carry an invoice dated before the signup — that is "at once", not negative. */
    out.push(Math.max(0, (inv - signup) / MIN));
  }
  return out;
}

export function isBug(r: QualityFeedbackRow): boolean {
  return (r.inferred_type ?? r.reported_type) === "bug";
}

export function isOpen(r: QualityFeedbackRow): boolean {
  return r.status === "open" || r.status === "agent_queued";
}

/** Filed → fixed, in hours, for fixed bug reports that carry a resolved time. */
export function fixHours(rows: readonly QualityFeedbackRow[]): number[] {
  const out: number[] = [];
  for (const r of rows) {
    if (r.status !== "fixed" || !isBug(r) || !r.resolved_at) continue;
    const h = (Date.parse(r.resolved_at) - Date.parse(r.created_at)) / HOUR;
    if (Number.isFinite(h)) out.push(Math.max(0, h));
  }
  return out;
}

const MONEY = /₹|\brs\.?\s?\d|\binr\b|\bgst|\bigst|\bcgst|\bsgst|\btds\b|invoice|payment|paise|paisa|amount|\btax|refund|razorpay|price|pricing|total/i;

/** A report about money — the words in its title or the triage summary. */
export function isMoneyReport(r: QualityFeedbackRow): boolean {
  return MONEY.test(r.title) || (r.problem_summary !== null && MONEY.test(r.problem_summary));
}

const SEVERITIES = ["critical", "high", "medium", "low"] as const;

export function buildQualityReport(input: QualityInput, now: Date): QualityMetric[] {
  const T = QUALITY_TARGETS;

  /* 1. Signup → first invoice. */
  const firstMins = minutesToFirstInvoice(input.tenants, input.invoices);
  const firstMed = median(firstMins);
  const withInvoice = firstMins.length;

  /* 2. Bug fix time. */
  const hours = fixHours(input.feedback);
  const fixMed = median(hours);
  const slow = hours.filter((h) => h > T.bugFixHours).length;

  /* 3 + 4. Open bugs. */
  const openBugs = input.feedback.filter((r) => isBug(r) && isOpen(r));
  const bySev = Object.fromEntries(SEVERITIES.map((s) => [s, openBugs.filter((r) => r.reported_severity === s).length])) as Record<(typeof SEVERITIES)[number], number>;
  const moneyOpen = openBugs.filter(isMoneyReport).length;

  /* 5. Fixes checked in the last 7 days. */
  const weekAgo = now.getTime() - 7 * 24 * HOUR;
  const checkedWeek = input.feedback.filter((r) => r.checked_at && Date.parse(r.checked_at) >= weekAgo).length;

  const notYet = (id: string, label: string, target: string): QualityMetric => ({
    id, label, value: "Not measured yet", target, status: "none", measured: false,
    detail: "No data source for this yet — needs its own card.",
  });

  return [
    {
      id: "first-invoice",
      label: "Signup to first invoice",
      value: firstMed === null ? "—" : formatMinutes(firstMed),
      target: `≤ ${T.firstInvoiceMinutes} min`,
      status: ragLowerBetter(firstMed, T.firstInvoiceMinutes, T.firstInvoiceAmberMinutes),
      detail: input.tenants.length === 0
        ? "No workspace to measure."
        : `Median over ${withInvoice} of ${input.tenants.length} workspace${input.tenants.length === 1 ? "" : "s"} with an invoice.`,
      href: "/invoices", hrefLabel: "Invoices",
      measured: true,
    },
    {
      id: "bug-fix",
      label: "Bug report to fix",
      value: fixMed === null ? "—" : formatMinutes(fixMed * 60),
      target: `≤ ${T.bugFixHours} h`,
      status: ragLowerBetter(fixMed, T.bugFixHours, T.bugFixAmberHours),
      detail: hours.length === 0
        ? "No fixed bug report yet."
        : `Median over ${hours.length} fixed bug${hours.length === 1 ? "" : "s"}; ${slow} took over ${T.bugFixHours} h.`,
      href: "/admin/feedback", hrefLabel: "Bug reports",
      measured: true,
    },
    {
      id: "open-bugs",
      label: "Open bugs",
      value: String(openBugs.length),
      target: "0 critical, 0 high",
      status: bySev.critical > 0 ? "red" : bySev.high > 0 ? "amber" : "green",
      detail: SEVERITIES.map((s) => `${bySev[s]} ${s}`).join(" · "),
      href: "/admin/feedback", hrefLabel: "Bug reports",
      measured: true,
    },
    {
      id: "money-bugs",
      label: "Open money bugs",
      value: String(moneyOpen),
      target: "0",
      status: moneyOpen > 0 ? "red" : "green",
      detail: "Open bug reports that mention ₹, GST, invoice, payment, tax or price.",
      href: "/admin/feedback", hrefLabel: "Bug reports",
      measured: true,
    },
    input.checkedAvailable
      ? {
          id: "fixed-week",
          label: "Fixes checked this week",
          value: String(checkedWeek),
          target: "—",
          status: "info",
          detail: "Fixes someone opened and confirmed in the last 7 days.",
          href: "/admin/feedback", hrefLabel: "Bug reports",
          measured: true,
        }
      : {
          id: "fixed-week",
          label: "Fixes checked this week",
          value: "—",
          target: "—",
          status: "none",
          detail: "Needs the feedback 'checked' migration on this database.",
          measured: true,
        },
    notYet("page-speed", "Page load", "< 1 s"),
    notYet("daily-clicks", "Clicks for the 5 daily tasks", "≤ 3 each"),
    notYet("phone-375", "Works on a 375 px phone", "Every page"),
    notYet("nps", "Customer NPS", "50+"),
  ];
}

/** The feedback columns the score reads. checked_at is read on its own (lib/quality/queries.ts): a database without that column must still show every other number. */
export const QUALITY_FEEDBACK_COLUMNS =
  "id, title, problem_summary, status, reported_type, inferred_type, reported_severity, created_at, resolved_at";

/**
 * Join the separately-read checked_at onto the feedback rows. `checked` null = the column
 * is not on this database (checkedAvailable false).
 */
export function mergeQualityInput(
  tenants: QualityInput["tenants"],
  invoices: QualityInput["invoices"],
  feedback: readonly Omit<QualityFeedbackRow, "checked_at">[],
  checked: readonly { id: string; checked_at: string | null }[] | null,
): QualityInput {
  const at = new Map((checked ?? []).map((c) => [c.id, c.checked_at]));
  return {
    tenants,
    invoices,
    feedback: feedback.map((f) => ({ ...f, checked_at: at.get(f.id) ?? null })),
    checkedAvailable: checked !== null,
  };
}
