/**
 * Renewals FORECAST — agle mahino me renewal par kitna paisa aana chahiye
 * (audit B7: /renewals ek list thi, curve nahi — "is quarter kitna aayega?"
 * ka jawab haath se jodna padta tha).
 *
 * R-2431 (after R-2422, Pardeep 3 Nov: "monthly commitment to renewal hi hoga"): the forecast adds
 * each renewal at its TERM AMOUNT before GST (lib/billing/subscription-schedule termAmountOf — the
 * amount the Renewals row and tiles show for a row without a renewal quote; a quote's total is
 * incl. GST, so it is not mixed in here). Before, an annual row was mrr × 12 (₹108,552 for a
 * ₹108,000 term filed as mrr ₹9,046) and flex sat in a separate "run-rate — not in total" lane. Now:
 *   - every row falls in the month of each renewal inside the horizon: its renewal_date, then
 *     every term_months after it — an annual row once in 6 months, a flex (1-month) row each
 *     month from its next part, each part the same one-month amount its row/tile shows;
 *   - flex IS in the total (flexCount says how many flex subscriptions are in it).
 *   - Ye ANDAZA hai: churn/expansion nahi ginta, aur screen yahi kehta hai. A MONTH already past
 *     is the Overdue tab's work; a date earlier in this month still counts in this month.
 */
import type { Subscription } from "@/lib/supabase/database.types";
import { termAmountOf } from "@/lib/billing/subscription-schedule";
import { isFlexSubscription } from "./buckets";

export interface ForecastMonth {
  /** "2026-09" */
  key: string;
  /** "Sep 2026" */
  label: string;
  /** ₹ before GST — the term amounts of the renewals due in this month. */
  amount: number;
  count: number;
}

export interface RenewalForecast {
  months: ForecastMonth[];
  totalAmount: number;
  totalCount: number;
  /** R-2431: flex (monthly-commitment) subscriptions counted IN the months above. */
  flexCount: number;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

type ForecastSub = Pick<Subscription, "status" | "mrr" | "term_months" | "renewal_date"> &
  Partial<Pick<Subscription, "term_amount" | "billing_cycle">>;

/** "2026-11" + n months. */
function shiftKey(key: string, n: number): string {
  const [y, m] = key.split("-").map(Number);
  const idx = y * 12 + (m - 1) + n;
  return `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, "0")}`;
}

/**
 * @param todayISO IST ki aaj ki tareekh (YYYY-MM-DD) — caller deta hai,
 *                 taki ye function pure aur test me jamaya hua rahe.
 */
export function renewalForecast(
  subs: readonly ForecastSub[],
  todayISO: string,
  horizonMonths = 6,
): RenewalForecast {
  const start = todayISO.slice(0, 7); // "2026-09"
  const keys = Array.from({ length: horizonMonths }, (_, i) => shiftKey(start, i));
  const last = keys[keys.length - 1];

  const byKey = new Map<string, ForecastMonth>(
    keys.map((key) => {
      const [y, m] = key.split("-").map(Number);
      return [key, { key, label: `${MONTHS[m - 1]} ${y}`, amount: 0, count: 0 }];
    }),
  );

  let flexCount = 0;
  for (const sub of subs) {
    if (sub.status !== "active") continue;
    const first = sub.renewal_date?.slice(0, 7);
    if (!first) continue;
    const step = Math.max(1, sub.term_months ?? 12);
    const termAmount = termAmountOf({ mrr: sub.mrr, term_months: sub.term_months ?? 12, term_amount: sub.term_amount ?? null });
    let counted = false;
    for (let k = first; k <= last; k = shiftKey(k, step)) {
      const bucket = byKey.get(k);
      if (!bucket) continue; // beeta hua mahina — Overdue tab ka kaam
      bucket.amount += termAmount;
      bucket.count += 1;
      counted = true;
    }
    if (counted && isFlexSubscription(sub)) flexCount += 1;
  }

  const months = keys.map((k) => byKey.get(k)!);
  return {
    months,
    totalAmount: months.reduce((s, m) => s + m.amount, 0),
    totalCount: months.reduce((s, m) => s + m.count, 0),
    flexCount,
  };
}
