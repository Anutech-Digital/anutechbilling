/**
 * Add seats to a subscription: the one place that decides the tax treatment and the
 * term length before calling `addSeats()`.
 *
 * ─── WHY THIS EXISTS ────────────────────────────────────────────────────────
 * Two routes now add seats — the operator's Add Seats dialog and a customer request
 * approved from the queue. Both need the same two derivations, and both are wrong in
 * expensive ways if they drift:
 *
 *   taxRatePct  add-seats used to multiply by a hardcoded 1.18, so an export customer
 *               was billed ₹2,135 of GST on a zero-rated ₹11,836 expansion.
 *   termDays    it was hardcoded to 365, so a two-year term with 400 days left billed
 *               as a full year — ₹21,600 instead of ₹11,836.
 *
 * Both are recorded in add-seats.ts as bugs that were found and fixed. Copying the
 * fixed versions into a second route is how they come back: one copy gets a
 * correction, the other does not, and the two paths quietly bill different amounts
 * for the same change.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/lib/supabase/database.types";
import { addSeats, type AddSeatsResult, type AddSeatsError } from "./add-seats";
import { isExportSupply } from "@/lib/gst/place-of-supply";
import { quotePlaceOfSupply, gstHeadLabel } from "@/lib/quotes/quote-place-of-supply";
import { seatChargePlan, seatTermEnd, seatTermDays } from "./seat-charge-window";
import { checkSeatEffectiveDate } from "./seat-effective-date";
import { isSplitBilled } from "@/lib/billing/instalments";
import { syncSubscriptionInstalments, readQuotePaymentFacts } from "@/lib/billing/sync-instalments.server";
import { istToday } from "@/lib/dates/ist";

type Admin = SupabaseClient<Database>;

export interface SeatIncreaseSubject {
  id: string;
  tenant_id: string;
  customer_id: string | null;
  customer_name: string;
  plan: string;
  vendor: "google" | "microsoft" | "zoho" | "other" | "domain" | "hosting" | "support";
  domain: string | null;
  seats: number;
  mrr: number;
  item_id: string | null;
  start_date: string | null;
  renewal_date: string | null;
  status: string;
  /** R-527: a split-billed subscription charges new seats to the end of this instalment. */
  billing_cycle: Database["public"]["Tables"]["subscriptions"]["Row"]["billing_cycle"];
  term_months: Database["public"]["Tables"]["subscriptions"]["Row"]["term_months"];
  quote_id: string | null;
}

/**
 * The length of THIS term, not an assumed year.
 *
 * R-802: the CURRENT term, from renewal_date and term_months (seatTermDays) — not from
 * start_date, which stays at the first sale across renewals: a 12-month row sold in Sep 2023
 * and renewed twice was a 1,096-day "term" and a +1 seat charge a third of the right amount.
 * 365 without a renewal date (applySeatIncrease refuses that case before charging).
 */
export function resolveTermDays(sub: Pick<SeatIncreaseSubject, "start_date" | "renewal_date" | "term_months">): number {
  return seatTermDays(sub);
}

/**
 * Derive the customer's GST rate. `isExportSupply` is conservative: an unknown country
 * counts as domestic, so a missing country over-charges rather than under-charges and is
 * never silently zero-rated.
 *
 * R-389 (F9): the rate AND the head it is charged under. The pro-rata quote's note said
 * "GST 18%" for an inter-state customer, whose invoice charges IGST 18%. Place of supply
 * comes from the same helper the quote page and PDF use (lib/quotes/quote-place-of-supply).
 */
export async function resolveSeatTax(
  supabase: Admin,
  customerId: string | null,
  tenantId: string,
): Promise<{ taxRatePct: number; taxLabel: string }> {
  const [{ data: customer }, { data: tenant }] = await Promise.all([
    customerId
      ? supabase.from("customers").select("country, state_code, gstin").eq("id", customerId).maybeSingle()
      : Promise.resolve({ data: null }),
    supabase.from("tenants").select("state_code, gstin").eq("id", tenantId).maybeSingle(),
  ]);
  const taxRatePct = isExportSupply(customer?.country) ? 0 : 18;
  const pos = quotePlaceOfSupply({ customer: customer ?? null, seller: tenant ?? {} });
  return { taxRatePct, taxLabel: gstHeadLabel({ ratePct: taxRatePct, interState: pos.interState, isExport: pos.isExport }) };
}

/** Add `additionalSeats` to `sub`, with tax and term derived once, here. */
export async function applySeatIncrease(args: {
  supabase: Admin;
  sub: SeatIncreaseSubject;
  additionalSeats: number;
  graceDays: number;
  /**
   * R-800: the date the seats were provisioned, chosen by the admin in the Add seats dialog
   * (YYYY-MM-DD). Absent = today — a customer's approved request still starts today.
   * Re-validated here so no caller can charge from the future or from before the term.
   */
  effectiveDate?: string | null;
  /** R-800: name of the person who chose the date — recorded on the quote note. */
  effectiveDateSetBy?: string | null;
}): Promise<AddSeatsResult | AddSeatsError> {
  const { supabase, sub, additionalSeats, graceDays } = args;

  if (!sub.renewal_date) {
    return { ok: false, code: "no_renewal_date", message: "subscription has no renewal_date" };
  }

  const { taxRatePct, taxLabel } = await resolveSeatTax(supabase, sub.customer_id, sub.tenant_id);
  const termDays = resolveTermDays(sub);

  /* R-527: split-billed → charge the new seats to the end of the CURRENT instalment; the later
     instalments pick them up when the billing run re-syncs them to the new MRR. The current
     instalment is invoiced FIRST, at the old seat count: if it were still un-invoiced when the
     MRR changes, the re-sync would put the new seats into it as well — charged twice. */
  const today = istToday();
  const eff = checkSeatEffectiveDate(args.effectiveDate, sub, today);
  if (!eff.ok) return { ok: false, code: "invalid_effective_date", message: eff.message };
  /* R-543: an effective date in the PREVIOUS term → plan.previous (its own quote line) and the
     current-term window measured from the current term start. Else plan.current is exactly
     seatChargeWindow(sub, today, eff.date), as before. */
  const plan = seatChargePlan(sub, today, eff.date);
  const window = isSplitBilled(sub.billing_cycle) ? (plan?.current ?? null) : null;
  if (window?.instalmentPeriod) {
    try {
      await syncSubscriptionInstalments({
        supabase, sub, todayISO: today,
        quote: sub.quote_id ? await readQuotePaymentFacts(supabase, sub.quote_id) : undefined,
      });
    } catch (e) {
      return {
        ok: false, code: "insert_failed",
        message: `Seats not added — this period's instalment invoice must be raised first, and it could not be: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  return addSeats({
    supabase,
    subscriptionId: sub.id,
    tenantId:       sub.tenant_id,
    customerId:     sub.customer_id,
    customerName:   sub.customer_name,
    plan:           sub.plan,
    vendor:         sub.vendor,
    itemId:         sub.item_id,
    domain:         sub.domain,
    currentSeats:   sub.seats,
    currentMrr:     sub.mrr,
    additionalSeats,
    renewalDate:    sub.renewal_date,
    graceDays,
    taxRatePct,
    taxLabel,
    termDays,
    termEnd:        seatTermEnd(sub),
    chargeWindow:   window?.instalmentPeriod ? { remainingDays: window.remainingDays, chargeTo: window.chargeTo } : null,
    effectiveDate:  eff.date,
    effectiveDateSetBy: args.effectiveDateSetBy ?? null,
    previousTerm:   plan?.previous
      ? { to: plan.previous.to, remainingDays: plan.previous.remainingDays, termDays: plan.previous.termDays }
      : null,
    currentTermStart: plan?.previous ? plan.current.from : null,
    todayISO:       today,
  });
}

/** The columns applySeatIncrease needs — shared so both callers select the same set. */
export const SEAT_INCREASE_SELECT =
  "id, tenant_id, customer_id, customer_name, plan, vendor, domain, seats, mrr, item_id, start_date, renewal_date, status, billing_cycle, term_months, quote_id" as const;
