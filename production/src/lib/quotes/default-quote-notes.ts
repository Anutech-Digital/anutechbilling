/**
 * R-1929 (G-ONBOARD OB-8) — what a new quote's "Notes for customer" start with.
 *
 * The quote builder pre-filled every reseller's quote with the platform company's own promise:
 * "Pricing valid for 30 days. Onboarding includes DNS, MX, SPF, DKIM, DMARC setup. Free
 * training (2 sessions)." A new reseller who never offered free training sent that to its
 * customers. The default now says only what the app itself knows — how long the price holds,
 * from the quote's own "Valid for (days)" — and anything a reseller promises on top goes in the
 * quote's Terms & conditions (or is typed in the notes).
 */
import { DEFAULT_QUOTE_VALIDITY_DAYS } from "@/lib/quotes/quote-validity";

/** "Pricing valid for N days." — N from the quote's validity (default 30). */
export function pricingValidityLine(validityDays: number = DEFAULT_QUOTE_VALIDITY_DAYS): string {
  const n = Number.isFinite(validityDays) && validityDays >= 1 ? Math.round(validityDays) : DEFAULT_QUOTE_VALIDITY_DAYS;
  return `Pricing valid for ${n} ${n === 1 ? "day" : "days"}.`;
}

/** The notes a quote made from a lead starts with. */
export function defaultLeadQuoteNotes(input: { leadName: string; contactName?: string | null; validityDays?: number }): string {
  const contact = input.contactName?.trim();
  return (
    `Quote for ${input.leadName}\n` +
    (contact && contact !== input.leadName ? `Attn: ${contact}\n` : "") +
    `\n${pricingValidityLine(input.validityDays)}`
  );
}
