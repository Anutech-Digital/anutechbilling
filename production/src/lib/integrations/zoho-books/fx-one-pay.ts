/**
 * R-2658 — Reconcile from Zoho: one export receipt per foreign-currency invoice in a run. Pure.
 *
 * An export receipt settles its foreign-currency invoice IN FULL (R-2427), so only one line of a run
 * can pay it. r2621OnePayPerItem (zoho-sale-filed.ts) adds up the ₹ of rows paying one invoice and
 * leaves FX rows alone (their ₹ never adds up to the due) — so here: when two BOOKABLE rows (ticked,
 * with a booking) pay the same invoice and at least one of them is an FX receipt, one keeps the
 * invoice and the other is not booked. Who keeps it: a row paired for sure (UTR, or "fx_amount" with
 * nothing doubtful) before a row paired by amount + date; then the plan's own order. A row that is
 * not bookable anyway (unticked — it already says why) never takes the invoice from another.
 */
import type { PlanRow } from "./bulk-reconcile-plan";

const sure = (r: PlanRow) => r.zoho.by === "utr" || (r.zoho.by === "fx_amount" && !r.zoho.notSure);

export function oneFxPayPerInvoice(rows: PlanRow[]): PlanRow[] {
  const pays = (r: PlanRow) => (r.ticked && r.book?.kind === "pay_item" && r.book.item?.invoiceId ? r.book.item : null);
  const order = rows.map((r, i) => ({ r, i })).filter((x) => pays(x.r)).sort((a, b) => Number(sure(b.r)) - Number(sure(a.r)) || a.i - b.i);
  const holder = new Map<string, { fx: boolean }>();
  for (const { r } of order) {
    const it = pays(r)!;
    const key = it.invoiceId!;
    const held = holder.get(key);
    if (!held) { holder.set(key, { fx: !!it.fx }); continue; }
    if (!held.fx && !it.fx) continue;   // two ₹ rows: r2621OnePayPerItem's sums decide
    r.problems.push(`Another line in this run already pays ${key} in full — book that line first, then run this again for this one (it then pays another invoice, or is a new sale).`);
    r.ticked = false;
    r.book = null;
  }
  return rows;
}
