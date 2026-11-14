/**
 * The one quote line the Onboard subscription dialog writes (tested in onboarding-line.test.ts).
 *
 * R-1442: it now carries the dialog's Start Date as `start_date`. On "Payment Received" the
 * subscription is created by record_payment, which starts it on the line's start_date and
 * otherwise on current_date — so a back-dated start used to come out as today.
 */
import type { QuoteLineItem } from "@/lib/supabase/database.types";
import type { BillingChoice, BillingTerms } from "@/lib/subscriptions/catalog-options";
import { domainLineYears } from "@/lib/provisioning/products";
import { addMonthsClamped } from "@/lib/billing/schedule";

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d);

/**
 * R-2734 (Pratik, 16 Oct): "Register for N years" in the Onboard dialog — a domain plan only
 * (isDomainPlan, the R-1445 / R-2712 rule) on Annual · Yearly (whole-year terms billed once; a
 * split-billed or Flex sale is never multi-year). N = a whole number 1-10, else 1 — the same reading
 * as domainLineYears and the database trigger.
 */
export function onboardingYears(raw: unknown, ctx: { domainPlan: boolean; billingChoice: BillingChoice }): number {
  if (!ctx.domainPlan || ctx.billingChoice !== "annual_yearly") return 1;
  return domainLineYears({ years: raw });
}

/**
 * R-2734: the renewal date the dialog saves. N years > 1 → start + N years (29 Feb + 3 → 28 Feb, as
 * Postgres' make_interval), not editable — a hand-typed date on the line would make the trigger skip
 * spreading the mrr. 1 year → the date on screen, as before.
 */
export function onboardingRenewal(startDate: string, years: number, typed: string): string {
  const start = startDate.trim();
  return years > 1 && isDay(start) ? addMonthsClamped(start, 12 * years) : typed;
}

export function onboardingQuoteLine(input: {
  id: string;
  plan: string;
  seats: number;
  pricePerSeat: number;
  terms: Pick<BillingTerms, "periods" | "costPerSeat" | "commitment">;
  startDate: string;
  /** R-1442 follow-up: the Renewal / Expiry date on screen (derived or hand-edited). */
  renewalDate?: string;
  /** R-2734: "Register for N years" (domain plan, Annual · Yearly). Default 1. */
  years?: number;
}): QuoteLineItem & { renewal_date?: string } {
  const { id, plan, seats, pricePerSeat, terms } = input;
  const start = input.startDate.trim();
  const renewal = (input.renewalDate ?? "").trim();
  /* R-2734: N years only on a once-a-year annual line (periods 1) — the rate and cost are then the
     WHOLE term, like a quote's multi-year domain line (R-156 / R-1445), billed once. */
  const years = terms.commitment === "annual_yearly" && terms.periods === 1
    ? domainLineYears({ years: input.years }) : 1;
  return {
    id,
    /* R-2095 (staging, 30 Oct): the name is the catalogue plan — record_payment names the
       subscription after the line, and "(2 seats)" in the plan broke matching (R-812 family).
       Seats are the line's qty and the subscription's seats column. */
    name: plan,
    qty: seats,
    /* rate × qty must equal what the quote stores, so the rate carries the same
       `periods` multiplier the total does. On annual-billed-monthly that makes
       this the ₹/seat/YEAR the customer committed to, which is what a line under
       commitment 'annual_yearly' is required to mean. */
    rate: pricePerSeat * terms.periods * years,
    /* The real catalog cost when we have it, in the same unit as the rate.
       `× 0.83` — a flat 17% — survives only for a custom plan that has no
       catalog row, and it is the last of the three places that guess used to live. */
    cost: terms.costPerSeat !== null
      ? terms.costPerSeat * terms.periods * years
      : Math.round(pricePerSeat * terms.periods * 0.83) * years,
    commitment: terms.commitment,
    ...(years > 1 ? { years } : {}),
    ...(isDay(start) ? { start_date: start } : {}),
    /* R-1442 follow-up: on "Payment Received" record_payment files the subscription with
       renewal = start + 1 year; trigger subscription_term_follows_line (migration
       …_r1445_subscription_term_follows_line.sql) replaces that with this date, so the
       expiry the operator saw — or typed — is the one saved. Only a date after the start.
       R-2734: never with N years > 1 — the trigger's step 1 would take that date and return
       before step 2 spreads the mrr over the years (the row would keep the whole term ÷ 12 as
       its monthly figure). Without it, step 2 sets renewal = start + years itself. */
    ...(years === 1 && isDay(start) && isDay(renewal) && renewal > start ? { renewal_date: renewal } : {}),
  };
}
