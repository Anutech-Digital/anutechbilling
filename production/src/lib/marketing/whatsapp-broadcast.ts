/**
 * WhatsApp broadcast — the rules, kept pure so the page, the send route and the webhook
 * all agree.
 *
 * WhatsApp lets a business open a conversation only with a Meta-approved TEMPLATE. A
 * template's body has numbered slots ({{1}}, {{2}} …) that are filled per recipient; the
 * company decides which lead field fills each (param_map). This module turns a lead into
 * those values, the values into Meta's `components`, and knows a STOP when it sees one.
 */

/** Lead fields a template slot can be filled with. */
export const PARAM_FIELDS = {
  first_name: { label: "Lead first name", fallback: "there" },
  company:    { label: "Lead company",        fallback: "your business" },
  sender:     { label: "Your company name", fallback: "our team" },
} as const;
export type ParamField = keyof typeof PARAM_FIELDS;

export interface StarterTemplate {
  name: string;
  category: "MARKETING" | "UTILITY";
  body: string;
  param_map: ParamField[];
  when: string;
}

/* Starter wording. Each business submits its own copy to Meta (WhatsApp Manager →
   Message templates) under the same name, then marks it approved here or syncs. The last
   line keeps an opt-out in every marketing message — Meta's policy expects one, and the
   webhook turns a "STOP" reply into an opt-out. */
export const STARTER_WA_TEMPLATES: readonly StarterTemplate[] = [
  {
    name: "business_email_intro", category: "MARKETING", param_map: ["first_name", "sender"],
    body: "Hi {{1}}, this is {{2}}. We set up professional business email (Google Workspace / Microsoft 365) on your own domain, with migration and support included. Would you like a quick quote for your team?\n\nReply STOP to opt out.",
    when: "First message to new leads",
  },
  {
    name: "festival_offer", category: "MARKETING", param_map: ["first_name", "sender"],
    body: "Hi {{1}}, festive greetings from {{2}}! This month we have a special discount on new Google Workspace and Microsoft 365 licences. Reply YES and we will send you the offer details.\n\nReply STOP to opt out.",
    when: "Diwali / New Year offer",
  },
  {
    name: "quote_followup", category: "MARKETING", param_map: ["first_name", "company"],
    body: "Hi {{1}}, just checking in on the quote we shared for {{2}}. Happy to adjust users, plan or billing if needed — reply here and we will take care of it.\n\nReply STOP to opt out.",
    when: "Quote sent, no reply",
  },
  {
    name: "winback_check_in", category: "MARKETING", param_map: ["first_name", "company"],
    body: "Hi {{1}}, we spoke earlier about email and IT for {{2}}. Plans and prices have changed since — would you like an updated quote? No pressure either way.\n\nReply STOP to opt out.",
    when: "Lost leads, after 2–3 months",
  },
  {
    name: "custom_software_intro", category: "MARKETING", param_map: ["first_name", "sender"],
    body: "Hi {{1}}, {{2}} also builds custom software — billing, ERP, CRM, portals and apps — around how your business already works. Is there a manual process you would like automated?\n\nReply STOP to opt out.",
    when: "For custom software",
  },
];

/** Meta template names: lower-case letters, digits, underscore. */
export function isValidTemplateName(name: string): boolean {
  return /^[a-z0-9_]{1,512}$/.test(name);
}

/** Highest {{n}} in the body; 0 when there are none. */
export function paramCount(body: string): number {
  let max = 0;
  for (const m of body.matchAll(/\{\{(\d+)\}\}/g)) max = Math.max(max, Number(m[1]));
  return max;
}

/** Why a template cannot be saved as written, or null. Slots must run 1..n with a field for each. */
export function templateProblem(body: string, paramMap: string[]): string | null {
  if (!body.trim()) return "Message is empty.";
  const n = paramCount(body);
  for (let i = 1; i <= n; i++) {
    if (!body.includes(`{{${i}}}`)) return `{{${i}}} is missing — slots must run in order from 1.`;
  }
  if (paramMap.length !== n) return `Message has ${n} slot${n === 1 ? "" : "s"}, but ${paramMap.length} fields are chosen.`;
  for (const f of paramMap) if (!(f in PARAM_FIELDS)) return `"${f}" is not a field.`;
  return null;
}

export interface LeadValues { first_name?: string | null; company?: string | null; sender?: string | null }

/** The value for each slot, with a fallback — Meta rejects an empty parameter. */
export function slotValues(paramMap: string[], v: LeadValues): string[] {
  return paramMap.map((f) => {
    const raw = (v[f as ParamField] ?? "").toString().trim();
    return raw || PARAM_FIELDS[f as ParamField]?.fallback || "-";
  });
}

/** Meta's `components` for a template send; [] when the body has no slots. */
export function bodyComponents(values: string[]): unknown[] {
  if (values.length === 0) return [];
  return [{ type: "body", parameters: values.map((text) => ({ type: "text", text })) }];
}

/** The message as the recipient will read it. */
export function renderBody(body: string, values: string[]): string {
  return body.replace(/\{\{(\d+)\}\}/g, (all, n) => values[Number(n) - 1] ?? all);
}

export function firstName(full: string | null | undefined): string {
  return (full ?? "").trim().split(/\s+/)[0] ?? "";
}

/**
 * '+digits' for WhatsApp, or null when it cannot be a mobile number. A bare 10-digit
 * number is Indian (+91); a leading 0 is a trunk prefix.
 */
export function normalizeWaPhone(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  if (d.length < 8 || d.length > 15) return null;
  return `+${d}`;
}

const STOP_WORDS = new Set([
  "stop", "stop all", "stop promotions", "unsubscribe", "unsub", "opt out", "optout",
  "band karo", "message band karo", "band", "mat bhejo", // customer-language: what customers type to opt out
]);

/** True when an inbound WhatsApp message (or quick-reply button) asks to stop. */
export function isStopMessage(text: string | null | undefined): boolean {
  const t = (text ?? "").toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
  return t.length > 0 && t.length <= 30 && STOP_WORDS.has(t);
}
