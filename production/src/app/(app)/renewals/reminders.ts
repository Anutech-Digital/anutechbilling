/**
 * Renewal reminder rules for the Renewals screen (R-239, 6 Oct 2026).
 *
 * Audit found: "Bulk reminder" emailed every renewal in 30 days on ONE click — no count,
 * no confirm, and renewed / suspended customers included; "Send now" also fired without
 * asking; a server 500 (HTML) surfaced as "Failed: Unexpected token <"; and the success
 * toast printed the raw state key ("Sent notice_sent to Acme"). Pure rules here, tested;
 * the page only wires them.
 */
import { decideCadence, renewalStateLabel, type RenewalState } from "@/lib/renewals/cadence";

export interface RenewalSubLike {
  id: string;
  customer_name: string;
  domain?: string | null;
  renewal_state?: string | null;
  renewal_date: string | null;
  term_months?: number | null;
}

export interface RenewalRowLike {
  sub: RenewalSubLike;
  daysUntil: number;
}

/** A renewed or suspended subscription must never get a renewal reminder. */
export function isTerminalRenewal(state: string | null | undefined): boolean {
  return state === "renewed" || state === "suspended";
}

/** Who "Bulk reminder" emails: renewing in the next 30 days, not renewed / suspended. */
export function bulkReminderTargets<T extends RenewalRowLike>(rows: T[]): T[] {
  return rows.filter((r) => r.daysUntil >= 0 && r.daysUntil <= 30 && !isTerminalRenewal(r.sub.renewal_state));
}

export function bulkReminderConfirm(targets: RenewalRowLike[]): { title: string; body: string } {
  const n = targets.length;
  const names = targets.slice(0, 5).map((r) => r.sub.customer_name).join(", ");
  const more = n > 5 ? `, and ${n - 5} more` : "";
  return {
    title: `Email ${n} customer${n === 1 ? "" : "s"}?`,
    body: `Each gets its renewal reminder for the step it is due (renewing in the next 30 days).\n${names}${more}.`,
  };
}

/** The step the send-now route will send — the same decideCadence call it makes. */
export function sendNowStep(sub: RenewalSubLike, graceDays: number, today: Date = new Date()): RenewalState {
  if (!sub.renewal_date) return "notice_sent";
  const d = decideCadence({
    renewalDate: sub.renewal_date,
    graceDays,
    currentState: (sub.renewal_state ?? "pending") as RenewalState,
    termMonths: sub.term_months,
    today,
  });
  return d.targetState === "pending" ? "notice_sent" : d.targetState;
}

export function sendNowConfirm(sub: RenewalSubLike, step: RenewalState): { title: string; body: string } {
  return {
    title: `Email ${sub.customer_name} now?`,
    body: `Sends the "${renewalStateLabel(step)}" renewal email to the customer's billing contact, with the renewal quote.`,
  };
}

const KNOWN_STEPS: RenewalState[] = [
  "pending", "early_notice", "notice_sent", "reminder_1", "reminder_2", "reminder_3",
  "reminder_4", "final_sent", "grace_period", "renewed", "suspended",
];

export function sentToastText(json: { status?: string; step?: string }, customerName: string): string {
  const verb = json.status === "sent" ? "Sent" : "Logged";
  const step = json.step as RenewalState | undefined;
  if (step && KNOWN_STEPS.includes(step)) return `${verb} “${renewalStateLabel(step)}” to ${customerName}`;
  return `${verb} renewal email to ${customerName}`;
}

/** Customer name or domain, case-insensitive. Empty query matches everything. */
export function matchesRenewalSearch(sub: RenewalSubLike, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return sub.customer_name.toLowerCase().includes(q) || (sub.domain ?? "").toLowerCase().includes(q);
}

/** Response body as JSON — an HTML error page becomes a plain "Server error (500)". */
export async function readJsonSafe(res: Response): Promise<Record<string, unknown> & { error?: string }> {
  const text = await res.text();
  try {
    const j = JSON.parse(text) as unknown;
    if (j && typeof j === "object") return j as Record<string, unknown> & { error?: string };
  } catch {
    /* not JSON — fall through */
  }
  return res.ok ? {} : { error: `Server error (${res.status})` };
}
