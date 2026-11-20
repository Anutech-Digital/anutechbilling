/**
 * /subscriptions ?focus= — the set behind the money tiles (R-118, 2 Oct 2026).
 *
 * Active MRR / ARR / Margin / Seats add up status = 'active'. No single tab is that set:
 * the folders split it into Active and Expiring (renewing within 30 days), so the tiles had
 * nowhere exact to open. The tiles and the list both use subInFocus.
 *
 * R-2969 (20 Nov 2026): "trials-month" — the dashboard's Company → Growth → "Trials started":
 * every trial (running, converted or ended) whose trial_started_at is in this IST month
 * (lib/company/summary.ts#trialStartedInMonth). It lists trials, not subscriptions, so the
 * page shows it on the Trials tab and no subscription row is in it.
 */
export const SUB_FOCI = ["", "active", "trials-month"] as const;
export type SubFocus = (typeof SUB_FOCI)[number];

export const SUB_FOCUS_LABEL: Record<Exclude<SubFocus, "">, string> = {
  active: "Active subscriptions — every one billing now, renewing soon included",
  "trials-month": "This month · trials started (running, converted and ended)",
};

export function subInFocus(s: { status: string }, focus: SubFocus): boolean {
  if (focus === "") return true;
  if (focus === "trials-month") return false;   // a trial list — no subscription row is in it
  return s.status === "active";
}
