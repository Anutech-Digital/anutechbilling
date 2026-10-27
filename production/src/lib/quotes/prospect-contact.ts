/**
 * R-469 (6) — email and phone for a NEW prospect typed into the quote builder.
 *
 * Abhishek's audit (9 Oct 2026): "New prospect" took only a name, so "Send via email" had
 * nowhere to go and the customer created on payment had no contact. Quotes carry no contact
 * columns of their own; a lead does, and a prospect quote is already a lead quote everywhere
 * else (record_payment turns lead → customer with the lead's contact). So when an email or
 * phone is typed, the builder creates that lead and links the quote to it.
 */
import { quoteRecipient } from "@/lib/quotes/send-quote-email";
import { checkGstin, liveGstin } from "@/lib/forms/poka-yoke";
import { stageAfterQuoteSaved } from "@/lib/leads/stage-after-quote-sent";

export interface ProspectContact {
  email: string;
  phone: string;
  /** R-1712: the prospect's GSTIN — saved on the lead, which becomes customers.gstin when they
   *  accept or pay (accept_quote / record_payment copy v_lead.gstin). Optional: a person or an
   *  unregistered business has none. */
  gstin?: string;
}

/** R-1712: the GSTIN when it passes the checksum, upper-cased; null otherwise. */
export function validProspectGstin(raw: string | null | undefined): string | null {
  const v = liveGstin(raw ?? "");
  return checkGstin(v).tone === "ok" ? v : null;
}

/** Both are optional; a value that is there must be usable. Null = fine. */
export function prospectContactProblem(c: ProspectContact): string | null {
  const email = c.email.trim();
  if (email && !quoteRecipient(email)) return "That email doesn't look right — check it or leave it empty.";
  const digits = c.phone.replace(/\D/g, "");
  if (c.phone.trim() && digits.length < 10) return "A phone number needs at least 10 digits.";
  /* R-1712: the same checksum check as the customer and lead forms — a wrong GSTIN on a lead
     becomes a wrong GSTIN on the customer and its tax invoice. */
  const g = checkGstin(c.gstin ?? "");
  if (g.tone === "typing" || g.tone === "error") return `GSTIN: ${g.message}`;
  return null;
}

/** True when the typed prospect has something worth saving as a lead. */
export function hasProspectContact(c: ProspectContact): boolean {
  return c.email.trim() !== "" || c.phone.trim() !== "" || validProspectGstin(c.gstin) !== null;
}

/** The lead row for a typed prospect (tenant and id are added by the caller). */
export function prospectLeadRow(input: {
  name: string;
  contact: ProspectContact;
  stateCode: string | null;
  stateName: string | null;
  country: string;
  sent: boolean;
  plan: string | null;
  seats: number | null;
  value: number | null;
}) {
  return {
    company: input.name.trim(),
    contact_email: input.contact.email.trim() || null,
    contact_phone: input.contact.phone.trim() || null,
    gstin: validProspectGstin(input.contact.gstin),
    state_code: input.stateCode || null,
    state: input.stateCode ? input.stateName : null,
    country: input.country.trim() || "India",
    /* R-1959: the same rule as the lead-mode path (stageAfterQuoteSaved) — a sent quote puts
       the lead at Quote Sent; a draft is contact, so it starts at Contacted, not New. */
    stage: stageAfterQuoteSaved("new", input.sent).nextStage ?? ("new" as const),
    source: "manual",
    plan: input.plan,
    seats: input.seats && input.seats > 0 ? input.seats : null,
    value: input.value && input.value > 0 ? input.value : null,
  };
}
