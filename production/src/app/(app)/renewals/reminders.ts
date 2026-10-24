/**
 * Renewal reminder rules for the Renewals screen (R-239, 6 Oct 2026).
 *
 * Audit found: "Bulk reminder" emailed every renewal in 30 days on ONE click — no count,
 * no confirm, and renewed / suspended customers included; "Send now" also fired without
 * asking; a server 500 (HTML) surfaced as "Failed: Unexpected token <"; and the success
 * toast printed the raw state key ("Sent notice_sent to Acme"). Pure rules here, tested;
 * the page only wires them.
 */
import { decideCadence, effectiveGraceDays, renewalIsSettled, renewalStateLabel, type RenewalState } from "@/lib/renewals/cadence";
import { describeError } from "@/lib/errors/toast-error";
import { cleanDisplayName } from "@/lib/utils";

export interface RenewalSubLike {
  id: string;
  customer_name: string;
  domain?: string | null;
  renewal_state?: string | null;
  renewal_date: string | null;
  term_months?: number | null;
  /** R-1621: the owner's "+N days" for this term (select * carries it). */
  grace_until?: string | null;
}

export interface RenewalRowLike {
  sub: RenewalSubLike;
  daysUntil: number;
}

/**
 * No reminder for a suspended subscription, nor for a renewed one whose NEW term's first
 * reminder is still ahead. R-1562: a bare `state === "renewed"` held every renewed row
 * back for good — record_payment writes 'renewed' while rolling renewal_date one term on,
 * so at T-30 of that new term it owes again. Without a date, 'renewed' counts as settled.
 */
export function isTerminalRenewal(
  state: string | null | undefined,
  renewalDate?: string | null,
  termMonths?: number | null,
  today: Date = new Date(),
): boolean {
  if (state === "suspended") return true;
  if (state !== "renewed") return false;
  return renewalDate ? renewalIsSettled(state, renewalDate, termMonths, today) : true;
}

/**
 * Who "Bulk reminder" emails: renewing in the next 30 days, AND (R-1124) already past the
 * renewal date but still inside the grace — the customers closest to losing the service
 * were the ones it skipped. Past the grace the owner decides on the Grace over list (R-1621),
 * so those are not mailed from here. Never suspended / settled-renewed.
 */
export function bulkReminderTargets<T extends RenewalRowLike>(rows: T[], today: Date = new Date(), tenantGraceDays = 0): T[] {
  return rows.filter((r) => {
    if (r.daysUntil > 30) return false;
    if (isTerminalRenewal(r.sub.renewal_state, r.sub.renewal_date, r.sub.term_months, today)) return false;
    if (r.daysUntil >= 0) return true;
    if (!r.sub.renewal_date) return false;
    const grace = effectiveGraceDays({ tenantGraceDays, renewalDate: r.sub.renewal_date, graceUntil: r.sub.grace_until ?? null });
    return -r.daysUntil <= grace;
  });
}

export function bulkReminderConfirm(targets: RenewalRowLike[]): { title: string; body: string } {
  const n = targets.length;
  const names = targets.slice(0, 5).map((r) => r.sub.customer_name).join(", ");
  const more = n > 5 ? `, and ${n - 5} more` : "";
  /* R-1124: name the lapsed ones apart — they get the grace email, not a "renewing soon" one. */
  const lapsed = targets.filter((r) => r.daysUntil < 0);
  const lapsedNames = lapsed.slice(0, 5).map((r) => r.sub.customer_name).join(", ");
  const lapsedLine = lapsed.length > 0
    ? `\n${lapsed.length} already past the renewal date (in grace): ${lapsedNames}${lapsed.length > 5 ? `, and ${lapsed.length - 5} more` : ""}.`
    : "";
  return {
    title: `Email ${n} customer${n === 1 ? "" : "s"}?`,
    body: `Each gets its renewal reminder for the step it is due (renewing in the next 30 days, or lapsed and still in grace).\n${names}${more}.${lapsedLine}`,
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

/* ── R-1642: who did not get the bulk reminder, and why ─────────────────────────────
   The bulk run used to keep only a count ("2 failed"). Each failure now keeps the row (so
   "Retry failed" re-sends only those), the customer name and a plain reason — the server's
   own guard sentence when it has one, database/network plumbing mapped by describeError. */

export interface BulkReminderFailure<T extends RenewalRowLike = RenewalRowLike> {
  row: T;
  name: string;
  reason: string;
}

export interface BulkReminderResult<T extends RenewalRowLike = RenewalRowLike> {
  sent: number;
  stub: boolean;
  failed: BulkReminderFailure<T>[];
}

export type SendReminder = (subscriptionId: string) => Promise<{ ok: boolean; json: { error?: string; email_mode?: unknown } }>;

export async function sendBulkReminders<T extends RenewalRowLike>(targets: T[], send: SendReminder): Promise<BulkReminderResult<T>> {
  const out: BulkReminderResult<T> = { sent: 0, stub: false, failed: [] };
  for (const row of targets) {
    const name = cleanDisplayName(row.sub.customer_name) || "A customer";
    try {
      const { ok, json } = await send(row.sub.id);
      if (!ok) {
        out.failed.push({ row, name, reason: describeError(json.error ?? "", "The server refused the send.").message });
        continue;
      }
      out.sent++;
      if (json.email_mode === "stub") out.stub = true;
    } catch (e) {
      out.failed.push({ row, name, reason: describeError(e, "The send did not go through.").message });
    }
  }
  return out;
}

/** At most this many customers are named in the toast; the rest are counted. */
const MAX_NAMED = 3;

function describeReminderFailures(failed: readonly BulkReminderFailure[]): string {
  const byReason = new Map<string, string[]>();
  for (const f of failed) byReason.set(f.reason, [...(byReason.get(f.reason) ?? []), f.name]);
  let named = 0;
  const parts: string[] = [];
  for (const [reason, names] of byReason) {
    const take = names.slice(0, Math.max(0, MAX_NAMED - named));
    if (take.length === 0) break;
    named += take.length;
    parts.push(`${take.join(", ")} — ${reason}`);
  }
  const rest = failed.length - named;
  return rest > 0 ? `${parts.join("; ")}; and ${rest} more` : parts.join("; ");
}

export interface BulkReminderReport {
  tone: "success" | "warning" | "error";
  title: string;
  description?: string;
  /** True when some failed — the toast offers "Retry failed". */
  retry: boolean;
}

export function bulkReminderReport(r: BulkReminderResult): BulkReminderReport {
  const n = (c: number) => `${c} customer${c === 1 ? "" : "s"}`;
  const stub = r.stub ? " · stub mode (no real email yet)" : "";
  if (r.failed.length === 0) return { tone: "success", title: `Reminded ${n(r.sent)}${stub}`, retry: false };
  const description = describeReminderFailures(r.failed);
  if (r.sent === 0) return { tone: "error", title: `Could not remind ${n(r.failed.length)}`, description, retry: true };
  return { tone: "warning", title: `Reminded ${n(r.sent)} · ${r.failed.length} refused${stub}`, description, retry: true };
}
