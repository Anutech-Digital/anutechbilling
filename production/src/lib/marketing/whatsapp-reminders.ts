/**
 * S28 — WhatsApp reminders for renewals and invoices: the rules, kept pure.
 *
 * The crons (api/cron/renewals, api/cron/invoice-dunning) already decide WHEN a customer is
 * reminded — that ladder is Abhishek's (lib/renewals, lib/invoices) and is not touched here.
 * This module only answers: for that step, is a WhatsApp allowed, which approved template,
 * and what goes in its {{1}} {{2}} slots.
 *
 * ─── DEFAULT OFF, AUR TEEN TAALE ────────────────────────────────────────────
 * Customer tak WhatsApp tabhi jata hai jab teeno haan kahen:
 *   1. whatsapp_reminder_settings.enabled — owner ne khud ON kiya (row nahi = OFF)
 *   2. us kind ke liye template mapped hai AUR whatsapp_templates me wahi naam 'approved' hai
 *      (approval Meta/BSP par hota hai; yahan sirf naam likhne se kuch nahi jata)
 *   3. number opt-out list me nahi hai (STOP — webhook already records it)
 * Plus the workspace's automation kill switch, same action as the email path.
 */
import type { CadenceTone } from "@/lib/renewals/cadence";
import type { DunningStep } from "@/lib/invoices/dunning";
import { bodyComponents, isValidTemplateName, paramCount } from "./whatsapp-broadcast";

export const REMINDER_KINDS = {
  renewal_upcoming: { label: "Renewal coming up (T-30 … T-3)", subject: "subscription" },
  renewal_final:    { label: "Renewal today (T-0)",              subject: "subscription" },
  renewal_grace:    { label: "Renewal passed — grace period",      subject: "subscription" },
  invoice_due:      { label: "Invoice due soon / due today",     subject: "invoice" },
  invoice_overdue:  { label: "Invoice overdue (day 1 / 3 / 7)",    subject: "invoice" },
  invoice_final:    { label: "Invoice final notice (day 14)",      subject: "invoice" },
} as const;
export type ReminderKind = keyof typeof REMINDER_KINDS;
export type ReminderSubject = "subscription" | "invoice";

export function isReminderKind(v: string): v is ReminderKind {
  return Object.prototype.hasOwnProperty.call(REMINDER_KINDS, v);
}

/**
 * Fields a reminder template slot can be filled with. Fallbacks exist because Meta rejects
 * an empty parameter — but a MONEY or DATE slot has no honest fallback, so a missing value
 * there blocks the send (see `slotProblem`) instead of printing "-" where ₹ should be.
 */
export const REMINDER_PARAM_FIELDS = {
  customer_name: { label: "Customer name",        fallback: "Customer" as string | null },
  seller_name:   { label: "Your company",         fallback: "our team" as string | null },
  plan:          { label: "Plan / product",       fallback: "your subscription" as string | null },
  invoice_id:    { label: "Invoice number",       fallback: null },
  amount:        { label: "Amount (₹)",           fallback: null },
  due_date:      { label: "Due / renewal date",   fallback: null },
  days:          { label: "Days",                 fallback: null },
  link:          { label: "Pay / accept link",    fallback: "reply to this message" as string | null },
} as const;
export type ReminderParamField = keyof typeof REMINDER_PARAM_FIELDS;
export type ReminderValues = Partial<Record<ReminderParamField, string | number | null>>;

/** Renewal cadence tone → reminder kind. `grace` is after the date; `final` is the day. */
export function renewalReminderKind(tone: CadenceTone): ReminderKind {
  if (tone === "final") return "renewal_final";
  if (tone === "grace") return "renewal_grace";
  return "renewal_upcoming";
}

/** Dunning step → reminder kind. `none` never reaches a send, but maps safely. */
export function dunningReminderKind(step: DunningStep): ReminderKind {
  if (step === "pre_due" || step === "due_today" || step === "none") return "invoice_due";
  if (step === "final") return "invoice_final";
  return "invoice_overdue";
}

/** Which automation dial governs this kind — the SAME action the email path is gated by. */
export function reminderAction(kind: ReminderKind): "renewal.send" | "dunning.send" {
  return REMINDER_KINDS[kind].subject === "subscription" ? "renewal.send" : "dunning.send";
}

export interface ReminderTemplateRow {
  kind: string;
  template_name: string;
  language: string;
  param_map: unknown;
  enabled: boolean;
}

export interface ApprovedTemplate { name: string; language: string; status: string }

export interface PickedTemplate { name: string; language: string; paramMap: ReminderParamField[] }

export type PickResult =
  | { ok: true; template: PickedTemplate }
  | { ok: false; reason: "no_template" | "template_disabled" | "template_not_approved" | "bad_param_map" };

/**
 * The template for this kind — only if it is mapped, switched on, and APPROVED.
 *
 * Approval is read from whatsapp_templates (name + language, status 'approved'), which is
 * what "Sync from Meta" updates. A mapping to a name Meta has not approved sends nothing:
 * Meta would reject it anyway, and a rejected template is a failed reminder nobody sees.
 */
export function pickReminderTemplate(
  kind: ReminderKind,
  rows: readonly ReminderTemplateRow[],
  approved: readonly ApprovedTemplate[],
): PickResult {
  const row = rows.find((r) => r.kind === kind);
  if (!row) return { ok: false, reason: "no_template" };
  if (!row.enabled) return { ok: false, reason: "template_disabled" };
  const isApproved = approved.some(
    (t) => t.status === "approved" && t.name === row.template_name && t.language === row.language,
  );
  if (!isApproved) return { ok: false, reason: "template_not_approved" };
  const map = parseParamMap(row.param_map);
  if (!map || !isValidTemplateName(row.template_name)) return { ok: false, reason: "bad_param_map" };
  return { ok: true, template: { name: row.template_name, language: row.language, paramMap: map } };
}

/** param_map jsonb → known fields, or null when anything in it is not a reminder field. */
export function parseParamMap(v: unknown): ReminderParamField[] | null {
  if (!Array.isArray(v)) return null;
  const out: ReminderParamField[] = [];
  for (const f of v) {
    if (typeof f !== "string" || !(f in REMINDER_PARAM_FIELDS)) return null;
    out.push(f as ReminderParamField);
  }
  return out;
}

/** Why a registry row cannot be saved as written (for a settings screen), or null. */
export function reminderTemplateProblem(name: string, body: string, paramMap: unknown): string | null {
  if (!isValidTemplateName(name)) return "Template name can only use a-z, 0-9 and _.";
  const map = parseParamMap(paramMap);
  if (!map) return "param_map has a field that is not a reminder field.";
  const n = paramCount(body);
  if (body && map.length !== n) return `Template has ${n} slot${n === 1 ? "" : "s"}, but ${map.length} fields are chosen.`;
  return null;
}

/** Slot values in order, or the first slot that has no honest value. */
export function slotValues(
  map: readonly ReminderParamField[],
  v: ReminderValues,
): { ok: true; values: string[] } | { ok: false; missing: ReminderParamField } {
  const values: string[] = [];
  for (const f of map) {
    const raw = v[f];
    const s = raw === null || raw === undefined ? "" : String(raw).trim();
    if (s) { values.push(s); continue; }
    const fb = REMINDER_PARAM_FIELDS[f].fallback;
    if (fb === null) return { ok: false, missing: f };
    values.push(fb);
  }
  return { ok: true, values };
}

export type SkipReason =
  | "disabled" | "automation_off" | "no_template" | "template_disabled" | "template_not_approved"
  | "bad_param_map" | "no_phone" | "opted_out" | "already_sent" | "missing_value" | "not_configured";

export interface ReminderGate {
  enabled: boolean;
  automationAllows: boolean;
  pick: PickResult;
  phone: string | null;
  optedOut: boolean;
  alreadySent: boolean;
}

export type ReminderDecision =
  | { send: true; template: PickedTemplate }
  | { send: false; reason: SkipReason; /** worth a log row? a disabled feature is not. */ log: boolean };

/**
 * The whole gate, in the order that matters. `disabled` comes first and is NOT logged —
 * a switched-off feature writing a row per invoice per day would bury the log it exists to
 * make readable. Everything after that is logged, because once the owner turned it on, a
 * reminder that did not go needs a reason he can read.
 */
export function decideReminder(g: ReminderGate): ReminderDecision {
  if (!g.enabled) return { send: false, reason: "disabled", log: false };
  if (g.alreadySent) return { send: false, reason: "already_sent", log: false };
  if (!g.automationAllows) return { send: false, reason: "automation_off", log: true };
  if (!g.pick.ok) return { send: false, reason: g.pick.reason, log: true };
  if (!g.phone) return { send: false, reason: "no_phone", log: true };
  if (g.optedOut) return { send: false, reason: "opted_out", log: true };
  return { send: true, template: g.pick.template };
}

/** Meta's components for the template send. */
export function reminderComponents(values: string[]): unknown[] {
  return bodyComponents(values);
}

/**
 * Starter UTILITY wording to submit to Meta under these names. Reminders about a bill the
 * customer already has are UTILITY, not MARKETING — which matters: utility templates are
 * cheaper and are not blocked by a marketing opt-out on Meta's side.
 *
 * No body may START or END with a {{n}} — Meta refuses such a template at submit time, which
 * is why the signature reads "— {{n}} team" and not "— {{n}}" (S28 submit-from-app).
 */
export const STARTER_REMINDER_TEMPLATES: readonly {
  kind: ReminderKind; name: string; body: string; param_map: ReminderParamField[];
}[] = [
  { kind: "renewal_upcoming", name: "renewal_upcoming_v1", param_map: ["customer_name", "plan", "due_date", "amount", "link", "seller_name"],
    body: "Hi {{1}}, your {{2}} renews on {{3}}. Renewal amount: {{4}}. To renew, use {{5}}.\n\n— {{6}} team" },
  { kind: "renewal_final", name: "renewal_today_v1", param_map: ["customer_name", "plan", "amount", "link", "seller_name"],
    body: "Hi {{1}}, your {{2}} is due for renewal today. Amount: {{3}}. Renew here: {{4}} to avoid any interruption.\n\n— {{5}} team" },
  { kind: "renewal_grace", name: "renewal_grace_v1", param_map: ["customer_name", "plan", "days", "link", "seller_name"],
    body: "Hi {{1}}, the renewal for your {{2}} is pending. Service continues for {{3}} more day(s) in the grace period. Renew here: {{4}}.\n\n— {{5}} team" },
  { kind: "invoice_due", name: "invoice_due_v1", param_map: ["customer_name", "invoice_id", "amount", "due_date", "seller_name"],
    body: "Hi {{1}}, a reminder that invoice {{2}} for {{3}} is due on {{4}}. Please ignore if already paid.\n\n— {{5}} team" },
  { kind: "invoice_overdue", name: "invoice_overdue_v1", param_map: ["customer_name", "invoice_id", "amount", "due_date", "seller_name"],
    body: "Hi {{1}}, invoice {{2}} for {{3}} was due on {{4}} and is still unpaid. Please arrange payment, or reply here if something is wrong.\n\n— {{5}} team" },
  { kind: "invoice_final", name: "invoice_final_v1", param_map: ["customer_name", "invoice_id", "amount", "days", "seller_name"],
    body: "Hi {{1}}, final reminder: invoice {{2}} for {{3}} is {{4}} days overdue. Please pay or call us today.\n\n— {{5}} team" },
];
