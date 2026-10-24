/**
 * What sending a quote to a customer commits you to.
 *
 * ─── WHAT THE DIALOG SAID BEFORE ────────────────────────────────────────────
 * "Email a copy of the quote PDF to {customer}. The customer-facing accept link is
 * included automatically."
 *
 * Accurate, and it describes the mechanism rather than the commitment. Three things
 * were missing, and the operator could not have inferred any of them from that
 * sentence:
 *
 *   1. **The price stops being a draft.** Once it is in their inbox the customer will
 *      hold you to it, and there is no recall.
 *   2. **The accept link works without you.** They can accept it at any hour, and
 *      accepting is not a reply you get to consider — it moves the deal.
 *   3. **A resend is not a correction.** The old email is still in their inbox with the
 *      old figures, so two prices are now in the thread. That is the moment a customer
 *      asks "which one applies?", and the honest answer takes a phone call.
 *
 * ─── AND THE ONE THAT COSTS MONEY ───────────────────────────────────────────
 * A quote whose stored total disagrees with its own subtotal × tax rate. That check
 * already exists but only on the INVOICE path (`useGenerateInvoice`'s pre-flight,
 * added 21 Aug 2026 after finding one production quote ₹8,165 under-charged). Sending
 * comes first in the real sequence, so the wrong figure reaches the customer before
 * anything checks it — and by then the number is quoted, not just stored.
 */
import { rupee } from "@/lib/utils";
import { grossAmount, isQuoteAmountConsistent } from "@/lib/quotes/amounts";
import type { Consequence } from "@/lib/actions/consequence";

export interface QuoteToSend {
  id: string;
  customerName: string | null;
  recipientEmail: string | null;
  /** Whole rupees (CLAUDE.md §13). */
  amount: number | null;
  subtotal: number | null;
  taxRate: number | null;
  /** Days the quote stays valid, when the quote carries one. */
  validityDays: number | null;
  /** True when this quote has already been emailed at least once. */
  alreadySent: boolean;
}

export function sendQuoteConsequences(quote: QuoteToSend): Consequence[] {
  const out: Consequence[] = [];

  /* The money check FIRST, because it is the only one that makes sending a mistake
     rather than a commitment. Same test the invoice path runs — moved earlier here,
     since sending is what actually puts the figure in front of the customer. */
  const subtotal = quote.subtotal ?? 0;
  const taxRate = quote.taxRate ?? 0;
  const amount = quote.amount ?? 0;
  if (amount > 0 && subtotal > 0 && !isQuoteAmountConsistent(subtotal, taxRate, amount)) {
    const should = grossAmount(subtotal, taxRate);
    out.push({
      tone: "warning",
      text: `This quote's total does not match its own GST. ${rupee(subtotal)} plus ${taxRate}% is ${rupee(should)}, but the quote says ${rupee(amount)} — a difference of ${rupee(Math.abs(should - amount))}. Fix the quote before sending; the customer will hold you to whatever they receive.`,
    });
  }

  if (amount <= 0) {
    out.push({
      tone: "warning",
      text: "This quote has no total, so there is nothing for the customer to accept. Add the line items first.",
    });
  } else {
    out.push({
      tone: "fact",
      text: `${rupee(amount)} goes to ${quote.customerName?.trim() || "the customer"}${quote.recipientEmail ? ` at ${quote.recipientEmail}` : ""}, and an email cannot be recalled.`,
    });
  }

  out.push({
    tone: "fact",
    text: "The accept link works without you — they can accept at any time, and accepting moves the deal rather than asking you first.",
  });

  if (quote.alreadySent) {
    /* The case most likely to cause an argument, and the one the old copy hid behind
       the word "Resend". */
    out.push({
      tone: "warning",
      text: "This quote has been sent before. The earlier email is still in their inbox, so if the figures have changed there are now two prices in the thread and the customer decides which one they read.",
    });
  }

  if (quote.validityDays !== null && quote.validityDays < 0) {
    /* R-1679: negative = the validity already ended. Sending it gives the customer a link that
       refuses to accept — the builder used to say "Valid for −1 days" and send anyway. */
    out.push({
      tone: "warning",
      text: "This quote's validity has already ended, so the customer's accept link will refuse it. Revise it (that sets a new validity) and send the new one instead.",
    });
  } else if (quote.validityDays !== null && quote.validityDays > 0) {
    out.push({
      tone: "fact",
      text: `Valid for ${quote.validityDays} day${quote.validityDays === 1 ? "" : "s"} from today, and the accept link keeps working until then.`,
    });
  } else {
    /* No validity is a real commercial exposure, not a missing field: the price stands
       until somebody notices. */
    out.push({
      tone: "warning",
      text: "This quote carries no validity period, so the price stands indefinitely — including after your own cost changes.",
    });
  }

  if (!quote.recipientEmail?.trim()) {
    out.push({
      tone: "warning",
      text: "No recipient address on this quote. Nothing can be sent until one is entered above.",
    });
  }

  return out;
}
