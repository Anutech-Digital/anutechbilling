/**
 * R-2011 (1 Nov 2026, goal G-DPDP): the short data notice every website form shows next to its
 * button, and the separate UNTICKED marketing opt-in — ONE place for the wording, the version
 * and the form keys, so the forms, the API routes and the tests cannot drift.
 *
 * DPDP Rules 2025 (Rule 3): a notice before personal data is collected — itemised (what data,
 * what for), plain language, with a link to withdraw / exercise rights and to complain. The
 * marketing opt-in is a SEPARATE purpose: never ticked by default and never needed to order or
 * enquire. Client-safe (no server imports): the forms import it, and so do the routes.
 */

/** Bump when the notice or the opt-in wording changes — every consent row names the version it answered. */
export const DATA_NOTICE_VERSION = "2026-11-01";

/** Where the visitor reads the full policy, their rights and the grievance contact (LegalDoc ids). */
export const PRIVACY_POLICY_HREF = "/privacy-policy";
export const PRIVACY_RIGHTS_HREF = "/privacy-policy#your-rights";
export const PRIVACY_GRIEVANCE_HREF = "/privacy-policy#grievances";

export const MARKETING_OPT_IN_LABEL = "Send me offers on email/WhatsApp";
export const MARKETING_OPT_IN_HINT = "Optional — not needed for your request. You can stop them at any time.";
/** Checkout only (children's data, DPDP s.9): the buyer says they may order. */
export const ADULT_OR_BUSINESS_LINE = "I am 18+ or buying for my business.";

export type DataNoticePurpose = "order" | "trial" | "quote" | "enquiry" | "callback" | "chat";

/** What each kind of form collects and why — the itemised part of the notice. */
export const DATA_NOTICE: Readonly<Record<DataNoticePurpose, { collects: string; use: string }>> = {
  order: {
    collects: "your name, email, mobile, company, GSTIN, state and domain (and the address, if we register a domain for you)",
    use: "to set up and support what you buy, raise your GST invoice and tell you about renewals",
  },
  trial: {
    collects: "your name, email, mobile, company and domain",
    use: "to set up your free trial and contact you about it",
  },
  quote: {
    collects: "your name, email, mobile, company and what you need",
    use: "to prepare and send your quote and contact you about it",
  },
  enquiry: {
    collects: "your name, email, mobile, company and your message",
    use: "to answer your enquiry",
  },
  callback: {
    collects: "your name and mobile number (and your message, if you write one)",
    use: "to call you back about your request",
  },
  chat: {
    collects: "what you type, and your name, email or mobile if you share them",
    use: "to answer your questions and, if you ask, contact you",
  },
};

/** Which form recorded a consent row (consent_events.form — lower-case key). */
export const CONSENT_FORMS = [
  "buy_checkout", "buy_trial", "buy_quote", "support_checkout", "cart_checkout",
  "enquiry", "workspace_enquiry", "trial", "quote_builder", "callback", "ad_callback",
] as const;
export type ConsentForm = (typeof CONSENT_FORMS)[number];

/** What a form sends with its normal body: which form, which notice, and the opt-in yes/no. */
export interface FormConsent {
  form: ConsentForm;
  noticeVersion: string;
  marketing: boolean;
}

/** The `consent` field a form adds to its request body. `marketing` is true ONLY when ticked. */
export function formConsent(form: ConsentForm, marketingOptIn: boolean): { consent: FormConsent } {
  return { consent: { form, noticeVersion: DATA_NOTICE_VERSION, marketing: marketingOptIn === true } };
}

/**
 * Read the `consent` field of a request body, leniently: anything malformed (or an old page that
 * never sent one) → null, and the form still works exactly as before — nothing is recorded.
 */
export function readFormConsent(body: unknown): FormConsent | null {
  if (!body || typeof body !== "object") return null;
  const c = (body as { consent?: unknown }).consent;
  if (!c || typeof c !== "object") return null;
  const { form, noticeVersion, marketing } = c as Record<string, unknown>;
  if (typeof form !== "string" || !(CONSENT_FORMS as readonly string[]).includes(form)) return null;
  if (typeof noticeVersion !== "string" || noticeVersion.length < 1 || noticeVersion.length > 40) return null;
  return { form: form as ConsentForm, noticeVersion, marketing: marketing === true };
}
