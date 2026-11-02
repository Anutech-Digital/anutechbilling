/**
 * R-2028 (3) — name the line that has no vendor cost.
 *
 * "At least one line has no vendor cost" left the owner of Q-4786-27-0001 guessing which line
 * locked the quote. The approval rule is unchanged (requiredApproval / R-2213 / R-2344); only the
 * reason shown on screen names the line(s), and "Add cost" opens that line's cost box in the
 * draft's editor (/quotes/<id>/edit?addCost=<line number>).
 */
import { lineCostUnknown, type CostLine } from "./line-cost";
import { COST_UNKNOWN_REASON } from "./approval";

export interface MissingCostLine {
  /** 1-based, as the line stands on the quote. */
  lineNo: number;
  id: string;
  name: string;
}

/** The lines being sold whose vendor cost nobody knows (the same rule as the approval). */
export function linesMissingCost(
  lines: readonly (CostLine & { id: string; name?: string | null })[],
): MissingCostLine[] {
  const out: MissingCostLine[] = [];
  lines.forEach((l, i) => {
    if (lineCostUnknown(l)) out.push({ lineNo: i + 1, id: l.id, name: (l.name ?? "").trim() || "Unnamed line" });
  });
  return out;
}

const ref = (m: MissingCostLine) => `${m.lineNo} "${m.name}"`;

/** 'Line 2 "GW Starter (1 year)" has no vendor cost, …' — null when every cost is known. */
export function missingCostReason(missing: readonly MissingCostLine[]): string | null {
  if (missing.length === 0) return null;
  const tail = "no vendor cost, so the margin on this quote is unknown.";
  if (missing.length === 1) return `Line ${ref(missing[0])} has ${tail}`;
  const refs = missing.map(ref);
  const list = `${refs.slice(0, -1).join(", ")} and ${refs[refs.length - 1]}`;
  return `Lines ${list} have ${tail}`;
}

/** The approval reasons to SHOW: the generic cost reason swapped for the one naming the line(s). */
export function namedApprovalReasons(
  reasons: readonly string[],
  lines: readonly (CostLine & { id: string; name?: string | null })[],
): string[] {
  const named = missingCostReason(linesMissingCost(lines));
  return reasons.map((r) => (r === COST_UNKNOWN_REASON && named ? named : r));
}

/** Where "Add cost" goes: the draft's editor, with that line's cost box focused. By line
 *  NUMBER — the editor gives every loaded line a fresh id, so a saved id would not be found. */
export function addCostHref(quoteId: string, lineNo: number): string {
  return `/quotes/${encodeURIComponent(quoteId)}/edit?addCost=${lineNo}`;
}
