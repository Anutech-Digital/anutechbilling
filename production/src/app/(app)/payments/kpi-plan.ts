/**
 * R-1730 — one fact, one place on /payments (owner audit 21 Oct, UI rule 1 / label-and-logic 2f).
 *
 * "Awaiting Invoice ₹55.9K (3)" showed in the analytics strip AND as the "Awaiting GST Invoice"
 * box under it AND as "3 fully paid, GST invoice not generated yet (₹… worth)" in Action needed.
 * Now:
 *   · the strip's figures show only while it is collapsed — expanded, the boxes carry them;
 *   · partial quotes and awaiting-invoice quotes live in "Action needed" (where they are acted
 *     on) whenever that card is shown; the analytics show them only when it is not (a role that
 *     cannot act, or nothing to act on — then they read 0 there).
 */
export type PaymentsKpi = "collected" | "partial" | "awaiting" | "topMethod";

export function paymentsKpiPlan(args: { expanded: boolean; actionCardShown: boolean }): {
  strip: PaymentsKpi[];
  tiles: PaymentsKpi[];
  actionCard: PaymentsKpi[];
} {
  const quoteFigures: PaymentsKpi[] = args.actionCardShown ? [] : ["partial", "awaiting"];
  return {
    strip: args.expanded ? [] : ["collected", ...quoteFigures],
    tiles: args.expanded ? ["collected", ...quoteFigures, "topMethod"] : [],
    actionCard: args.actionCardShown ? ["partial", "awaiting"] : [],
  };
}
