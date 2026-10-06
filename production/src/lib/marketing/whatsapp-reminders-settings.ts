/**
 * S28 — the WhatsApp reminders SETTINGS screen (/marketing/whatsapp/reminders): pure rules.
 *
 * The sender (whatsapp-reminders.server.ts) already decides per reminder; this file answers
 * the owner's question BEFORE the cron runs: "agar aaj reminder banta, to kya WhatsApp
 * jaata?" — per kind, in the same order the sender checks. Kept pure so the answer the page
 * shows is tested against the same gate the cron uses, not re-typed in JSX.
 */
import type { AutonomyMode } from "@/lib/ai/autonomy";
import {
  REMINDER_KINDS, REMINDER_PARAM_FIELDS, STARTER_REMINDER_TEMPLATES, parseParamMap,
  pickReminderTemplate, type ApprovedTemplate, type ReminderKind, type ReminderParamField,
  type ReminderTemplateRow, type SkipReason,
} from "./whatsapp-reminders";
import { paramCount } from "./whatsapp-broadcast";

/** One row of whatsapp_templates as the settings screen needs it. */
export interface KnownTemplate { name: string; language: string; status: string; body: string }

export type KindState =
  | "ready" | "switch_off" | "not_connected" | "dial_blocks"
  | "no_template" | "template_disabled" | "not_approved" | "bad_param_map";

export interface KindReadiness {
  state: KindState;
  /** Kind of badge the page shows. */
  tone: "success" | "warning" | "danger" | "muted";
  /** What happened + what to do next (AGENTS.md §7). */
  text: string;
}

export interface KindInput {
  kind: ReminderKind;
  switchOn: boolean;
  connected: boolean;
  dialMode: AutonomyMode;
  killSwitch: boolean;
  mapping: ReminderTemplateRow | null;
  templates: readonly KnownTemplate[];
}

/**
 * Would a reminder of this kind go out today? Same order as decideReminder(): the tenant
 * switch, then the template (mapped → switched on → approved → valid map), then the dial.
 * `connected` is checked too, because the sender logs it as `not_configured` only AFTER
 * trying — the screen can say it up front.
 *
 * The template problems are reported even while the switch is OFF, so the owner can set
 * everything up first and flip the switch last.
 */
export function kindReadiness(i: KindInput): KindReadiness {
  const approved: ApprovedTemplate[] = i.templates.map((t) => ({ name: t.name, language: t.language, status: t.status }));
  const pick = pickReminderTemplate(i.kind, i.mapping ? [i.mapping] : [], approved);

  if (!pick.ok) {
    if (pick.reason === "no_template") {
      return { state: "no_template", tone: "muted", text: "No template chosen — click \"Set template\"." };
    }
    if (pick.reason === "template_disabled") {
      return { state: "template_disabled", tone: "muted", text: "This kind's template is off — edit it and turn it ON." };
    }
    if (pick.reason === "template_not_approved") {
      const t = i.templates.find((x) => x.name === i.mapping?.template_name && x.language === i.mapping?.language);
      return {
        state: "not_approved", tone: "warning",
        text: t
          ? `"${t.name}" (${t.language}) is ${t.status} — click "Sync from Meta" once Meta approves it.`
          : `"${i.mapping?.template_name}" (${i.mapping?.language}) is not in the app's templates — submit it on Meta, then click "Sync from Meta".`,
      };
    }
    return { state: "bad_param_map", tone: "danger", text: "The template's {{n}} fields are wrong — edit to fix them." };
  }

  if (!i.connected) {
    return { state: "not_connected", tone: "warning", text: "WhatsApp Business API is not connected — connect it in Settings → Integrations." };
  }
  if (i.killSwitch || i.dialMode !== "auto") {
    return {
      state: "dial_blocks", tone: "warning",
      text: i.killSwitch
        ? "The automation master switch is off — turn it on at /automation."
        : `Automation dial for this job is "${i.dialMode}" — WhatsApp sends only on "auto". Change it at /automation.`,
    };
  }
  if (!i.switchOn) {
    return { state: "switch_off", tone: "muted", text: "All set — reminders start once the switch above is ON." };
  }
  return { state: "ready", tone: "success", text: "On — the next cron run sends a WhatsApp for every reminder due." };
}

/**
 * The {{n}} field list for the editor. In order:
 *   1. what was saved, if it still fits the body's slot count — the owner chose it;
 *   2. a starter template's own map, when the name is a starter and the count fits;
 *   3. the saved list padded / cut to the slot count.
 * Nothing is guessed for a MONEY or DATE slot: padding uses customer_name, which the owner
 * then changes, and the save is refused while the count is wrong (mappingProblem).
 */
export function defaultParamMap(
  kind: ReminderKind,
  templateName: string,
  body: string | null,
  saved: readonly ReminderParamField[] = [],
): ReminderParamField[] {
  const n = body ? paramCount(body) : null;
  if (saved.length > 0 && (n === null || saved.length === n)) return [...saved];
  const starter = STARTER_REMINDER_TEMPLATES.find((s) => s.kind === kind && s.name === templateName)
    ?? STARTER_REMINDER_TEMPLATES.find((s) => s.name === templateName);
  if (starter && (n === null || n === starter.param_map.length)) return [...starter.param_map];
  if (n === null) return [...saved];
  return Array.from({ length: n }, (_, i) => saved[i] ?? "customer_name");
}

export function isStarterReminderName(name: string): boolean {
  return STARTER_REMINDER_TEMPLATES.some((s) => s.name === name);
}

/** Why this mapping cannot be saved, or null. Body is the approved text when the app has it. */
export function mappingProblem(templateName: string, language: string, paramMap: unknown, body: string | null): string | null {
  if (!/^[a-z0-9_]+$/.test(templateName) || templateName.length > 512) {
    return "Template name can only use lower-case a-z, 0-9 and _ (e.g. invoice_due_v1) — use the exact name from Meta.";
  }
  if (language.length < 2 || language.length > 10) return "Language must be 2–10 characters (e.g. en, hi, en_US).";
  const map = parseParamMap(paramMap);
  if (!map) return "Pick a field from the list for every {{n}}.";
  if (body !== null) {
    const n = paramCount(body);
    if (map.length !== n) return `Template has ${n} slot${n === 1 ? "" : "s"} ({{n}}), but ${map.length} fields are chosen — make them match.`;
  }
  return null;
}

export const REMINDER_KIND_ORDER = Object.keys(REMINDER_KINDS) as ReminderKind[];
export const REMINDER_FIELD_ORDER = Object.keys(REMINDER_PARAM_FIELDS) as ReminderParamField[];

/* ─── Log ─────────────────────────────────────────────────────────────────── */

export type ReminderLogStatus = "sent" | "delivered" | "read" | "failed" | "skipped";

export const LOG_STATUS: Record<ReminderLogStatus, { label: string; tone: "success" | "info" | "warning" | "danger" | "muted" }> = {
  sent:      { label: "Sent",      tone: "info" },
  delivered: { label: "Delivered", tone: "success" },
  read:      { label: "Read",      tone: "success" },
  failed:    { label: "Failed",    tone: "danger" },
  skipped:   { label: "Skipped",   tone: "muted" },
};

export function logStatus(s: string): { label: string; tone: "success" | "info" | "warning" | "danger" | "muted" } {
  return (LOG_STATUS as Record<string, (typeof LOG_STATUS)[ReminderLogStatus]>)[s] ?? { label: s, tone: "muted" };
}

/** Why a reminder was skipped, in words the owner can act on. */
export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  disabled:              "WhatsApp reminders were OFF",
  automation_off:        "Blocked by the automation dial (/automation)",
  no_template:           "No template set for this kind",
  template_disabled:     "Template was off",
  template_not_approved: "Template not approved by Meta",
  bad_param_map:         "Template {{n}} fields were wrong",
  no_phone:              "Customer has no mobile number",
  opted_out:             "Customer replied STOP",
  already_sent:          "This step was already sent",
  missing_value:         "A template slot had no value",
  not_configured:        "WhatsApp API was not connected",
};

export function skipReasonText(r: string | null): string | null {
  if (!r) return null;
  return (SKIP_REASON_TEXT as Record<string, string>)[r] ?? r;
}
