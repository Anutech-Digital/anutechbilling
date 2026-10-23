/**
 * The one quote line the Onboard subscription dialog writes (tested in onboarding-line.test.ts).
 *
 * R-1442: it now carries the dialog's Start Date as `start_date`. On "Payment Received" the
 * subscription is created by record_payment, which starts it on the line's start_date and
 * otherwise on current_date — so a back-dated start used to come out as today.
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import type { BillingTerms } from "@/lib/subscriptions/catalog-options";

export function onboardingQuoteLine(input: {
  id: string;
  plan: string;
  seats: number;
  pricePerSeat: number;
  terms: Pick<BillingTerms, "periods" | "costPerSeat" | "commitment">;
  startDate: string;
}): QuoteLineItem {
  const { id, plan, seats, pricePerSeat, terms } = input;
  const start = input.startDate.trim();
  return {
    id,
    name: `${plan} (${seats} seats)`,
    qty: seats,
    /* rate × qty must equal what the quote stores, so the rate carries the same
       `periods` multiplier the total does. On annual-billed-monthly that makes
       this the ₹/seat/YEAR the customer committed to, which is what a line under
       commitment 'annual_yearly' is required to mean. */
    rate: pricePerSeat * terms.periods,
    /* The real catalog cost when we have it, in the same unit as the rate.
       `× 0.83` — a flat 17% — survives only for a custom plan that has no
       catalog row, and it is the last of the three places that guess used to live. */
    cost: terms.costPerSeat !== null
      ? terms.costPerSeat * terms.periods
      : Math.round(pricePerSeat * terms.periods * 0.83),
    commitment: terms.commitment,
    ...(/^\d{4}-\d{2}-\d{2}$/.test(start) ? { start_date: start } : {}),
  };
}
