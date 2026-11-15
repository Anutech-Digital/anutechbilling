/**
 * R-2762 (R-2740 split) — the Renewals drawer's Follow-ups section lists every renewal reminder the
 * app tried to send for the subscription: when · channel (Email / WhatsApp) · which step · to whom ·
 * whether it went out — with the count, newest first. Before it showed only the subscription's
 * reminder_count counter ("3 reminders sent · last 2 Nov"), so nobody could see WHICH reminders went,
 * by which channel, or that a "sent" email was really stubbed / failed.
 *
 * Two existing logs, no new table:
 *   renewal_email_log      every renewal-cadence email (nightly cron + Send now): status sent /
 *                          stubbed (email not set up) / failed / skipped (no contact email).
 *   whatsapp_reminder_log  every WhatsApp reminder (S28) — only the ones that went out are read
 *                          (sent / delivered / read; the partial unique index serves that read).
 * Only "sent" email and sent/delivered/read WhatsApp count as reaching the customer. The count is
 * THIS term's (from the current term's start — the subscription counter resets each term too); the
 * list keeps older terms' reminders below. Pure — the read is drawer-data.ts readReminderLog; tested
 * in reminder-log-r2762.test.ts.
 */
import { formatDate } from "@/lib/utils";
import { renewalStateLabel, type RenewalState } from "@/lib/renewals/cadence";
import { REMINDER_KINDS, isReminderKind } from "@/lib/marketing/whatsapp-reminders";
import { remindersWords } from "./drawer";

/** Rows read per log per drawer open (a subscription gets ~8 reminders a term). */
export const REMINDER_LOG_MAX = 100;
/** The WhatsApp statuses that mean the message went out (whatsapp_reminder_log_once's own list). */
export const WA_SENT_STATUSES = ["sent", "delivered", "read"] as const;

export interface EmailReminderLogRow {
  id: string;
  cadence_step: string;
  recipient_email: string | null;
  status: string;
  sent_at: string;
}

export interface WhatsAppReminderLogRow {
  id: string;
  kind: string;
  step: string | null;
  phone: string | null;
  status: string;
  sent_at: string | null;
  created_at: string;
}

export interface ReminderLog {
  email: EmailReminderLogRow[];
  whatsapp: WhatsAppReminderLogRow[];
}

export type ReminderChannel = "Email" | "WhatsApp";

export interface DrawerReminderRow {
  id: string;
  /** ISO time it was sent / tried (sorting). */
  at: string;
  /** The day, formatted. */
  when: string;
  channel: ReminderChannel;
  /** Which reminder ("Reminder 1 (T-12)", "Final notice"). */
  what: string;
  /** The email address / phone it went to; null = none on file. */
  to: string | null;
  status: string;
  /** It reached the customer (counted). */
  reached: boolean;
}

const EMAIL_STATUS: Record<string, { text: string; reached: boolean }> = {
  sent: { text: "Sent", reached: true },
  stubbed: { text: "Not sent — email sending is not set up", reached: false },
  failed: { text: "Failed to send", reached: false },
  skipped: { text: "Not sent — no contact email", reached: false },
};

const WA_STATUS: Record<string, string> = { sent: "Sent", delivered: "Delivered", read: "Read" };

const plain = (s: string) => s.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());

/** A cadence step (renewal_state) in words; anything else in plain words. */
function stepWords(step: string): string {
  return (renewalStateLabel(step as RenewalState) as string | undefined) ?? plain(step);
}

/** Every reminder in both logs, newest first (an email before a WhatsApp at the same moment). */
export function drawerReminderRows(log: ReminderLog | null | undefined): DrawerReminderRow[] {
  if (!log) return [];
  const rows: DrawerReminderRow[] = [];
  for (const e of log.email) {
    const s = EMAIL_STATUS[e.status] ?? { text: plain(e.status), reached: false };
    const to = e.recipient_email && e.recipient_email !== "(missing)" ? e.recipient_email : null;
    rows.push({ id: `email:${e.id}`, at: e.sent_at, when: formatDate(e.sent_at), channel: "Email", what: stepWords(e.cadence_step), to, status: s.text, reached: s.reached });
  }
  for (const w of log.whatsapp) {
    const at = w.sent_at ?? w.created_at;
    /* the cadence step it was sent for (the dedupe key); the kind's own label when the step is not a cadence state */
    const what = w.step && (renewalStateLabel(w.step as RenewalState) as string | undefined)
      ? stepWords(w.step)
      : isReminderKind(w.kind) ? REMINDER_KINDS[w.kind].label : plain(w.kind);
    rows.push({
      id: `whatsapp:${w.id}`, at, when: formatDate(at), channel: "WhatsApp", what,
      to: w.phone?.trim() || null,
      status: WA_STATUS[w.status] ?? plain(w.status),
      reached: (WA_SENT_STATUSES as readonly string[]).includes(w.status),
    });
  }
  return rows.sort((a, b) => b.at.localeCompare(a.at) || (a.channel === b.channel ? b.id.localeCompare(a.id) : a.channel === "Email" ? -1 : 1));
}

/** A log came back full — older rows may exist. */
export function reminderLogCapped(log: ReminderLog | null | undefined): boolean {
  return !!log && (log.email.length >= REMINDER_LOG_MAX || log.whatsapp.length >= REMINDER_LOG_MAX);
}

type CounterSub = Parameters<typeof remindersWords>[0];

/**
 * The Reminders line for THIS term: "3 reminders sent this term (2 email, 1 WhatsApp) · last 2 Nov 2026".
 * `termStart` (YYYY-MM-DD) = the current term's first day; null = count every row. Nothing in the logs →
 * the subscription's own counter (remindersWords — "No reminder sent yet" when 0). Tries that did not
 * go out are named, so a stubbed / failed email is never read as sent; older terms' are named too.
 */
export function reminderLogWords(rows: readonly DrawerReminderRow[], sub: CounterSub, termStart: string | null = null): string {
  if (rows.length === 0) return remindersWords(sub);
  const inTerm = termStart ? rows.filter((r) => r.at.slice(0, 10) >= termStart) : [...rows];
  const earlier = rows.length - inTerm.length;
  const earlierWords = earlier > 0 ? `${earlier} from earlier terms` : null;
  const term = termStart ? " this term" : "";
  const reached = inTerm.filter((r) => r.reached);
  const notSent = inTerm.length - reached.length;
  const notSentWords = notSent > 0 ? `${notSent} ${notSent === 1 ? "try" : "tries"} not sent` : null;
  if (reached.length === 0) return [`No reminder sent yet${term}`, notSentWords, earlierWords].filter(Boolean).join(" · ");
  const email = reached.filter((r) => r.channel === "Email").length;
  const wa = reached.length - email;
  const split = email > 0 && wa > 0 ? ` (${email} email, ${wa} WhatsApp)` : wa > 0 ? " by WhatsApp" : " by email";
  const head = `${reached.length} reminder${reached.length === 1 ? "" : "s"} sent${term}${split} · last ${reached[0].when}`;
  return [head, notSentWords, earlierWords].filter(Boolean).join(" · ");
}
