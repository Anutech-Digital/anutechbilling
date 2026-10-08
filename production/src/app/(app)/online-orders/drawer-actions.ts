/**
 * R-236 (6 Oct 2026) — what the Online Orders drawer's buttons do.
 *
 * Every button here used to show a toast and do nothing ("DNS guide re-sent",
 * "Conversion quote sent", "Call logged", "WhatsApp: Ravi" …), so an operator believed
 * the customer had been contacted when nobody had. Rule now: a button is a real link
 * (wa.me / tel: / mailto: / the quote builder / Google Admin) or opens the real call-log
 * popup — and a button with no backend behind it (retry provisioning, re-send DNS
 * guide, escalate to Google, winback email) is not shown at all.
 */
import { formatWhatsAppPhone } from "@/lib/whatsapp";
import { leadQuoteHref } from "@/lib/leads/lead-quote-href";

export interface DrawerActionInput {
  type: "paid" | "trial";
  status: string;
  trialDay: number | null;
  /** public.leads id behind the order — needed for the quote builder and the call log. */
  leadId: string | null;
  company: string;
  plan: string | null;
  seats: number | null;
  contact: { name: string; email: string; phone: string };
}

export interface DrawerAction {
  key: "convert-quote" | "log-call" | "whatsapp" | "call" | "email" | "admin-console";
  label: string;
  icon: string;
  /** link = in-app route, external = new tab / app handler, call-log = open the popup. */
  kind: "link" | "external" | "call-log";
  href?: string;
  primary?: boolean;
}

/** 10+ digits, else null. "—" and short numbers are not dialled. */
function phoneDigits(phone: string): string | null {
  const wa = formatWhatsAppPhone(phone);
  return wa.length >= 10 ? wa : null;
}

function validEmail(email: string): string | null {
  const e = email.trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
}

/** Same link every lead surface uses (lib/leads/lead-quote-href.ts) — R-389 (F5): only the
 *  lead id + plan/seats; the builder loads company and contact from the lead, so no email
 *  or phone sits in the URL. */
export function convertQuoteHref(i: DrawerActionInput): string | null {
  if (!i.leadId) return null;
  return leadQuoteHref({ id: i.leadId, plan: i.plan, seats: i.seats });
}

export function orderDrawerActions(i: DrawerActionInput): DrawerAction[] {
  const out: DrawerAction[] = [];
  const isTrial = i.type === "trial";
  const day = i.trialDay ?? 0;

  const wantsConvert =
    isTrial && (i.status === "trial-converting" || i.status === "trial-expired" || (i.status === "trial-active" && day >= 7));
  const quoteHref = wantsConvert ? convertQuoteHref(i) : null;
  if (quoteHref) {
    out.push({ key: "convert-quote", label: "Send convert quote", icon: "rupee", kind: "link", href: quoteHref, primary: true });
  }
  if (isTrial && i.status === "trial-active" && day < 7 && i.leadId) {
    out.push({ key: "log-call", label: "Log call", icon: "phone", kind: "call-log", primary: true });
  }

  const phone = phoneDigits(i.contact.phone);
  if (phone) {
    out.push({ key: "whatsapp", label: "WhatsApp", icon: "whatsapp", kind: "external", href: `https://wa.me/${phone}` });
    out.push({ key: "call", label: "Call", icon: "phone", kind: "external", href: `tel:+${phone}` });
  }
  const email = validEmail(i.contact.email);
  if (email) {
    out.push({ key: "email", label: "Email", icon: "mail", kind: "external", href: `mailto:${email}` });
  }
  out.push({ key: "admin-console", label: "Admin console", icon: "external", kind: "external", href: "https://admin.google.com" });
  return out;
}
