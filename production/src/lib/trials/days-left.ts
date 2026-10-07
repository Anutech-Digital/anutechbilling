/**
 * R-319 — the ONE way to count a trial's days left.
 *
 * The quote page (R-282) counted IST calendar days; Subscriptions → Trials in progress
 * rounded raw milliseconds, so a trial ending 21 Oct 23:59 IST read "14 days left" on one
 * screen and "15d left" on the other. Both now call this.
 *
 * IST calendar days from today to the trial's last day: 0 = ends today, negative = ended.
 */
import { daysBetweenISO, toIstDate } from "@/lib/dates/ist";

export function trialDaysLeft(expiresAt: string | Date, now: Date = new Date()): number {
  return daysBetweenISO(toIstDate(now), toIstDate(expiresAt));
}
