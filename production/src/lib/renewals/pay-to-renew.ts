/**
 * R-2735 (Pardeep, 13 Nov 2026 — p0 money): "jab tak payment na aaye renew to karna hi nahi ... bill next
 * part to quote banayega, wo renewal date kyo badhata hai jab tak wo paid na ho".
 *
 * A subscription billed in parts used to have renewal_date rolled a whole term on (renewal_state
 * 'renewed') the moment the new term's first part was BILLED — by Renewals → "Bill next part" and by the
 * renewals cron on the new term's first day — while its proforma was unpaid.
 *
 * Now the new term is billed on a VIRTUAL roll: the billing code is handed the subscription as if it had
 * renewed (`billAs`), so it lays and bills that term's parts, and the term's FIRST part is marked
 * `renews_from → renews_to` (subscription_billings). Nothing is written to the subscription. When that
 * part is paid, the database moves renewal_date (roll_paid_renewal_terms, migration
 * 20261113124936_r2735_renew_on_paid_part) — exactly once, oldest term first.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { splitBilledRenewalStep, type SplitRenewalFields } from "./split-billed-renewal";

/** "Paying this term's first part moves renewal_date from → to." */
export interface TermRoll {
  from: string;
  to: string;
}

type RollableSub = SplitRenewalFields & { renewal_quote_id?: string | null; auto_renew?: boolean | null };

/**
 * The term to bill for a subscription billed in parts whose next term has begun: the subscription as if
 * renewed (billAs) and the roll its first part carries. Null when nothing rolls — not billed in parts, the
 * term still running, an open renewal quote holds it (R-808), or the customer said Won't renew
 * (auto_renew false — the renewals cron lets it lapse).
 */
export function termToBill<T extends RollableSub>(sub: T, todayISO: string): { billAs: T & { term_roll: TermRoll }; roll: TermRoll } | null {
  if (sub.auto_renew === false) return null;
  const step = splitBilledRenewalStep({ ...sub, renewal_quote_id: sub.renewal_quote_id ?? null }, todayISO);
  if (step.kind !== "roll" || !sub.renewal_date) return null;
  const roll = { from: sub.renewal_date.slice(0, 10), to: step.newRenewalDate };
  return { billAs: { ...sub, renewal_date: step.newRenewalDate, term_roll: roll }, roll };
}

/** The first part of a laid term — the one whose payment renews (lowest period index). */
export function firstPartIndex(periodIndexes: readonly number[]): number | null {
  return periodIndexes.length === 0 ? null : Math.min(...periodIndexes);
}

/**
 * Marks a term's first part with its roll (only where it has none — a mark is never rewritten). The
 * database renews at once if that part is already paid (trigger subscription_billings_r2735_paid_part_renews).
 */
export async function markTermRoll(
  db: SupabaseClient,
  args: { subscriptionId: string; termStart: string; periodIndex: number; roll: TermRoll },
): Promise<void> {
  const { error } = await db.from("subscription_billings")
    .update({ renews_from: args.roll.from, renews_to: args.roll.to })
    .eq("subscription_id", args.subscriptionId)
    .eq("term_start", args.termStart)
    .eq("period_index", args.periodIndex)
    .is("renews_from", null);
  if (error) throw new Error(`Could not mark the renewal part: ${error.message}`);
}

/**
 * A term billed outside this app (Zoho, R-1763) is not ours to collect — it rolls as before, guarded on
 * the date read so two runs roll once. Returns whether it moved.
 */
export async function rollBilledElsewhere(db: SupabaseClient, subscriptionId: string, roll: TermRoll): Promise<boolean> {
  const { data, error } = await db.from("subscriptions")
    .update({ renewal_date: roll.to, renewal_state: "renewed", reminder_count: 0, last_reminder_sent_at_v2: null })
    .eq("id", subscriptionId).eq("status", "active").eq("renewal_date", roll.from).is("renewal_quote_id", null)
    .select("id");
  if (error) throw new Error(`Could not roll the term billed elsewhere: ${error.message}`);
  return (data ?? []).length > 0;
}

/** The line the Bill-next-part toast adds when a renewal term was billed. */
export function renewsWhenPaidNote(roll: TermRoll | null): string {
  if (!roll) return "";
  return ` The renewal date moves to ${dayMonYear(roll.to)} only when it is paid.`;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayMonYear(iso: string): string {
  return `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]} ${iso.slice(0, 4)}`;
}
