/**
 * R-388 — is a quote line's vendor cost KNOWN?  One rule, used by every screen that
 * judges margin (quote builder, saved-quote approval, customer configurator, quotes list).
 *
 * Three states, not two:
 *
 *   • cost is null / undefined  → UNKNOWN. Nobody has filled it in yet (e.g. the lead
 *     prefill ran before the catalogue arrived). Waiting to be filled, never "free".
 *   • cost is 0 on a line we SELL from a vendor → UNKNOWN too. That is how a missing
 *     catalogue cost has always been stored, and treating it as 0 would report a fake
 *     100% margin.
 *   • cost is 0 on OUR OWN service (the support plan — isSupportSkuId) → KNOWN, ₹0.
 *     There is no vendor; 0 is the real cost. Before R-388 every quote carrying the
 *     company-wide support plan went to the owner with "At least one line has no vendor
 *     cost", which taught people to click through the one warning that matters.
 *
 * A ₹0 line (rate 0) is never "unknown": a free line costs nothing to anyone.
 */
import { isSupportSkuId } from "@/lib/support/tiers";

export interface CostLine {
  cost?: number | null;
  rate: number;
  item_id?: string | null;
}

/** Our own service — no vendor, so ₹0 cost is the real cost. */
export function isOwnServiceLine(line: Pick<CostLine, "item_id">): boolean {
  return isSupportSkuId(line.item_id);
}

/** True when this line is being sold but nobody knows what it costs us. */
export function lineCostUnknown(line: CostLine): boolean {
  if (line.rate <= 0) return false;
  if (isOwnServiceLine(line)) return false;
  if (line.cost == null) return true;
  return line.cost <= 0;
}

/** True when any line on the quote has an unknown cost (see lineCostUnknown). */
export function anyCostUnknown(lines: readonly CostLine[]): boolean {
  return lines.some(lineCostUnknown);
}

/**
 * Fill the cost of lines whose cost is still UNKNOWN from the catalogue, once it has
 * arrived. The race this closes (R-388): the lead prefill ran on a reload before the
 * catalogue query had answered, wrote cost 0, and nothing ever came back to fill it —
 * a ₹7,440 Workspace cost became 0 and the margin read 98%.
 *
 *   • `isPending(line)` — the caller's record of "this cost was never known" (a line's
 *     cost is null/undefined, or it was prefilled without a catalogue row). A cost the
 *     user TYPED is never pending, so it is never overwritten.
 *   • `catalogCost(line)` — the per-seat cost in the line's unit, or null when the
 *     catalogue still cannot answer (row missing, or its wholesale is 0 for a vendor
 *     product — that stays unknown rather than becoming a real-looking ₹0).
 *
 * Returns the SAME array when nothing changed, so it is safe inside a setState updater.
 */
export function fillUnknownCosts<L extends CostLine>(
  lines: readonly L[],
  isPending: (line: L) => boolean,
  catalogCost: (line: L) => { cost: number; item_id?: string } | null,
): { lines: L[]; filled: L[] } {
  const filled: L[] = [];
  const next = lines.map((l) => {
    if (!isPending(l)) return l;
    const found = catalogCost(l);
    if (!found || !(found.cost > 0)) return l;
    const updated = { ...l, cost: found.cost, ...(found.item_id && !l.item_id ? { item_id: found.item_id } : {}) };
    filled.push(updated);
    return updated;
  });
  return { lines: filled.length ? next : (lines as L[]), filled };
}
