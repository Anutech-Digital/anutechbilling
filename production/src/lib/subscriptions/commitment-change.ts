/**
 * R-2095 (coordinator 30 Oct, P0 money): changing an EXISTING subscription's commitment.
 *
 * Venus Infotech is on Google Workspace ANNUAL commitment billed MONTHLY, but was booked as
 * "Monthly (Flexible)". Its licence cost (subscriptions.vendor_cost_per_seat_month, written from the
 * sale line — R-378) was therefore the Flexible ₹318/seat/month instead of the annual ₹264, and the
 * list showed a loss that does not exist. "Correct details" could not change the commitment.
 *
 * ─── THE MODEL IS THE ONE NEW SUBSCRIPTIONS ALREADY USE — NOTHING NEW ────────
 *   commitment         = subscriptions.term_months   1 Flexible · 12 Annual · 36 three years
 *   billing frequency  = subscriptions.billing_cycle monthly · quarterly · half_yearly · yearly
 * (record_payment and Add subscription write exactly these — catalog-options.ts billingTerms.)
 * An annual commitment can be billed in any of the four; Flexible is monthly only.
 *
 * ─── WHAT A CHANGE DOES ─────────────────────────────────────────────────────
 *   • licence cost := the catalogue's tier for the NEW commitment (prices.monthly.wholesale for
 *     Flexible, prices.annual.wholesale for a commitment — the annual rate is the same whether it is
 *     billed monthly or yearly, database.types ItemPrices);
 *   • seats, selling rate (mrr), domain and start stay as they are;
 *   • renewal_date := the inclusive end (termEndInclusive) of the new-length term that covers the
 *     current period, counted from the start date;
 *   • the database (correct_subscription_commitment) writes the same, logs old → new on the
 *     contract amendment ledger with the reason, and refuses an annual commitment reduced
 *     mid-term — the customer committed for the year and the vendor holds us to it.
 */
import type { BillingCycle, Item } from "@/lib/supabase/database.types";
import { termEndInclusive } from "@/lib/billing/schedule";
import { currentTermStart } from "@/lib/billing/subscription-schedule";

export type Commitment = "flex" | "annual" | "three_year";

/** The choices "Correct details" offers. A three-year row shows its own as well (see the dialog). */
export const COMMITMENT_OPTIONS: ReadonlyArray<{ value: Commitment; months: number; label: string; hint: string }> = [
  { value: "flex",   months: 1,  label: "Flexible (monthly)", hint: "No commitment — cancel any month. Flexible price tier; billed monthly only." },
  { value: "annual", months: 12, label: "Annual commitment",  hint: "Committed for 12 months at the annual price — billed monthly, quarterly, half-yearly or yearly." },
];

export const THREE_YEAR_OPTION = { value: "three_year" as const, months: 36, label: "3-year commitment", hint: "Committed for 36 months (Microsoft triennial)." };

export function commitmentOf(termMonths: number | null | undefined): Commitment {
  const tm = termMonths ?? 12;
  if (tm <= 1) return "flex";
  if (tm >= 36) return "three_year";
  return "annual";
}

export function commitmentLabel(termMonths: number | null | undefined): string {
  const c = commitmentOf(termMonths);
  if (c === "three_year") return THREE_YEAR_OPTION.label;
  return COMMITMENT_OPTIONS.find((o) => o.value === c)!.label;
}

const ALL_FREQUENCIES: readonly BillingCycle[] = ["yearly", "half_yearly", "quarterly", "monthly"];

/** How often a commitment may be billed. Same order as lib/quotes/billing BILLING_CYCLE_OPTIONS. */
export function frequenciesFor(c: Commitment): BillingCycle[] {
  return c === "flex" ? ["monthly"] : [...ALL_FREQUENCIES];
}

export const FREQUENCY_LABEL: Record<BillingCycle, string> = {
  yearly: "Yearly", half_yearly: "Half-yearly", quarterly: "Quarterly", monthly: "Monthly",
};

function positive(v: unknown): number | null {
  return typeof v === "number" && v > 0 ? v : null;
}

/**
 * ₹/seat/month the vendor charges for this commitment, from the catalogue. Null when the catalogue
 * cannot say. An annual commitment NEVER falls back to the flex cost — that fallback is the very
 * defect being fixed. Flexible with no flex cost falls back to the annual one (billingTerms does
 * the same for a new subscription). The SQL in correct_subscription_commitment mirrors this.
 */
export function catalogCostPerSeatMonth(
  item: Pick<Item, "prices" | "wholesale"> | null | undefined, termMonths: number,
): number | null {
  if (!item) return null;
  const p = item.prices as { annual?: { wholesale?: number }; monthly?: { wholesale?: number } } | null;
  const annual = positive(p?.annual?.wholesale) ?? positive(item.wholesale);
  if (termMonths <= 1) return positive(p?.monthly?.wholesale) ?? annual;
  return annual;
}

export interface RenewalInput {
  startDate: string | null;
  renewalDate: string | null;
  termMonthsNow: number | null;
  termMonthsNext: number;
  today: string;
}

/**
 * The renewal date (inclusive last day) after the commitment changes.
 *
 *   • same length → unchanged (a frequency change does not move the commitment's end);
 *   • longer (Flexible → Annual) → the first start + k×term − 1 day that reaches the current
 *     period's first day: the annual term the customer is in now, from the original start;
 *   • shorter (only allowed once the longer term has ended or before it began) → after an ended
 *     term the stored end stays (the next term starts the day after it, at the new length);
 *     before the start → start + new term − 1 day.
 */
export function commitmentRenewal(i: RenewalInput): string | null {
  const now = Math.max(1, i.termMonthsNow ?? 12);
  const next = Math.max(1, i.termMonthsNext);
  if (!i.startDate || next === now) return i.renewalDate;
  const start = i.startDate.slice(0, 10);

  let ref: string;
  if (next > now) {
    ref = currentTermStart({ term_months: now, start_date: start, renewal_date: i.renewalDate }) ?? start;
  } else {
    const ended = !!i.renewalDate && i.renewalDate.slice(0, 10) < i.today;
    ref = ended ? i.renewalDate!.slice(0, 10) : start;
  }
  if (ref < start) ref = start;
  for (let k = 1; k <= 200; k++) {
    const end = termEndInclusive(start, k * next);
    if (end >= ref) return end;
  }
  return i.renewalDate;
}

const SEAT_CUT_ROLES = new Set(["owner", "manager"]);
const MONEY_ROLES = new Set(["owner", "manager", "accountant", "billing"]);

export interface CommitmentFacts {
  role: string | null | undefined;
  termMonthsNow: number | null;
  termMonthsNext: number;
  cycleNow: BillingCycle | string | null;
  cycleNext: BillingCycle;
  startDate: string | null;
  renewalDate: string | null;
  today: string;
  fmt?: (iso: string) => string;
}

export interface CommitmentVerdict {
  /** The commitment or the billing frequency differs from the record. */
  changed: boolean;
  /** The commitment gets shorter (Annual → Flexible, 3 years → Annual). */
  reduced: boolean;
  /** The rule refuses this change (for everyone), or null. */
  block: string | null;
  /** This login may not make it, or null. */
  roleBlock: string | null;
}

/** The rule — the database (correct_subscription_commitment) enforces the same. */
export function commitmentVerdict(f: CommitmentFacts): CommitmentVerdict {
  const now = Math.max(1, f.termMonthsNow ?? 12);
  const next = Math.max(1, f.termMonthsNext);
  const changed = next !== now || (f.cycleNow ?? "yearly") !== f.cycleNext;
  const reduced = next < now;
  const fmt = f.fmt ?? ((iso: string) => iso);

  let block: string | null = null;
  if (next <= 1 && f.cycleNext !== "monthly") {
    block = "Flexible is billed monthly only. Pick Annual commitment to bill quarterly, half-yearly or yearly.";
  } else if (reduced) {
    const termStart = currentTermStart({ term_months: now, start_date: f.startDate, renewal_date: f.renewalDate });
    const end = f.renewalDate?.slice(0, 10) ?? null;
    const running = termStart != null && end != null && termStart <= f.today && f.today <= end;
    if (running) {
      block = `An ${now >= 36 ? "3-year" : "annual"} commitment cannot be reduced mid-term — the customer committed until ${fmt(end!)}. `
        + `Change it after ${fmt(end!)}, when this term ends, or keep the commitment and change only the payment frequency.`;
    }
  }

  let roleBlock: string | null = null;
  if (changed) {
    const role = f.role ?? "";
    if (reduced && !SEAT_CUT_ROLES.has(role)) roleBlock = "Only an owner or manager can shorten a commitment. Ask one of them.";
    else if (!MONEY_ROLES.has(role)) roleBlock = "Only an owner, manager, accountant or billing user can change the commitment or payment frequency.";
  }
  return { changed, reduced, block, roleBlock };
}
