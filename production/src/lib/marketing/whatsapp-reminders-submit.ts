/**
 * S28 — submit the starter reminder templates to Meta FROM THE APP (pure rules).
 *
 * Pehle owner ko WhatsApp Manager me login karke chhe template haath se type karne padte the.
 * Ab /api/marketing/whatsapp/reminders/submit ye kaam karta hai; yahan sirf:
 *   - kaunse starter abhi bhejne hain (jo approved / pending nahi hain),
 *   - Meta ko jaane wali request ka body (har {{n}} ke liye ek example value — Meta bina
 *     example ke variable wala template reject karta hai),
 *   - Meta ka jawab → app ka status, aur Meta ki galti → Hinglish text.
 * Kept pure so the exact request shape is tested without a network.
 */
import {
  STARTER_REMINDER_TEMPLATES, type ReminderKind, type ReminderParamField,
} from "./whatsapp-reminders";
import { paramCount } from "./whatsapp-broadcast";

/** Language every starter is submitted in (the starter wording is English). */
export const STARTER_LANGUAGE = "en";

/**
 * One realistic example per reminder field — Meta's reviewer reads these next to the
 * wording, so they must look like a real bill, not "{{1}}" or "test".
 */
export const REMINDER_EXAMPLE_VALUES: Record<ReminderParamField, string> = {
  customer_name: "Rahul",
  seller_name:   "Anutech",
  plan:          "Google Workspace Business Starter",
  invoice_id:    "INV-2026-0142",
  amount:        "₹1,180",
  due_date:      "15 Oct 2026",
  days:          "3",
  link:          "https://example.com/pay/INV-2026-0142",
};

export type Starter = (typeof STARTER_REMINDER_TEMPLATES)[number];

/** Example values in {{1}}…{{n}} order, one per slot. Throws if the map does not fit the body. */
export function starterExampleValues(body: string, paramMap: readonly ReminderParamField[]): string[] {
  const n = paramCount(body);
  if (paramMap.length !== n) {
    throw new Error(`Template has ${n} slot${n === 1 ? "" : "s"} but ${paramMap.length} fields — the starter is wrong.`);
  }
  return paramMap.map((f) => REMINDER_EXAMPLE_VALUES[f]);
}

/** The JSON body POSTed to https://graph.facebook.com/v18.0/{WABA}/message_templates. */
export function metaTemplateRequest(s: Starter) {
  const examples = starterExampleValues(s.body, s.param_map);
  return {
    name: s.name,
    language: STARTER_LANGUAGE,
    category: "UTILITY" as const,
    components: [
      examples.length > 0
        ? { type: "BODY" as const, text: s.body, example: { body_text: [examples] } }
        : { type: "BODY" as const, text: s.body },
    ],
  };
}

/** App statuses that mean "Meta already has this — do not submit again". */
const LIVE_STATUSES = new Set(["approved", "submitted", "paused"]);

export interface ExistingTemplate { name: string; language: string; status: string }

/** Starters (optionally only these kinds) that are not yet approved / pending in the app. */
export function startersToSubmit(existing: readonly ExistingTemplate[], kinds?: readonly ReminderKind[]): Starter[] {
  return STARTER_REMINDER_TEMPLATES.filter((s) => {
    if (kinds && !kinds.includes(s.kind)) return false;
    const row = existing.find((t) => t.name === s.name && t.language === STARTER_LANGUAGE);
    return !row || !LIVE_STATUSES.has(row.status);
  });
}

/** Meta template status → whatsapp_templates.status (same mapping as templates/sync). */
export function appStatusFromMeta(metaStatus: unknown): "approved" | "rejected" | "submitted" | "paused" {
  switch (metaStatus) {
    case "APPROVED": return "approved";
    case "REJECTED": return "rejected";
    case "PAUSED": case "DISABLED": case "LIMIT_EXCEEDED": return "paused";
    default: return "submitted"; // PENDING, IN_APPEAL, or anything new
  }
}

interface MetaErrorBody {
  error?: { message?: string; error_user_msg?: string; error_user_title?: string; code?: number; error_subcode?: number };
}

/**
 * Is this Meta error "a template with this name + language already exists"? Meta has used
 * more than one subcode for it over versions, so the message text is checked as well.
 */
export function isDuplicateTemplateError(j: unknown): boolean {
  const e = (j as MetaErrorBody)?.error;
  if (!e) return false;
  if (e.error_subcode === 2388023 || e.error_subcode === 2388024) return true;
  const text = `${e.message ?? ""} ${e.error_user_title ?? ""} ${e.error_user_msg ?? ""}`;
  return /already exists|duplicate|same name/i.test(text);
}

/** A Meta refusal in words the owner can act on. Never contains the access token. */
export function metaErrorText(j: unknown, httpStatus: number, token: string): string {
  const e = (j as MetaErrorBody)?.error;
  const raw = e?.error_user_msg || e?.message || `HTTP ${httpStatus}`;
  const safe = token ? raw.split(token).join("***") : raw;
  if (httpStatus === 401 || e?.code === 190) {
    return "Meta rejected the WhatsApp token (expired or invalid) — reconnect WhatsApp in Settings → Integrations.";
  }
  if (httpStatus === 403 || e?.code === 10 || e?.code === 200) {
    return `Meta denied permission (${safe}) — the token needs the whatsapp_business_management permission. Check Settings → Integrations.`;
  }
  if (httpStatus === 429 || e?.code === 4 || e?.code === 80008) {
    return "Meta is rate-limiting requests — try again in 10–15 minutes.";
  }
  return `Meta rejected the template: ${safe} — check the wording and resubmit, or submit it yourself in WhatsApp Manager.`;
}
