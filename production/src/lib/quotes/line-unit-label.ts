/**
 * The "Per seat …" line under each item on the quote preview and PDF (R-482 / board R-469 (4)).
 *
 * Abhishek's Scenario 15: a support plan (Standard Yearly, qty 1, a flat fee) printed
 * "Per seat per year" on the quote, the preview and the PDF. A support plan or a one-time
 * service is not a seat. Same seat rule as the seat count (lib/quotes/seat-lines.ts).
 */
import { isSeatLine, type SeatLineLike } from "./seat-lines";

/** `perPeriod` = the rate shown is per invoice (split billing), so no "per year" is added. */
export function lineUnitLabel(line: SeatLineLike, perPeriod: boolean): string {
  const yearly = perPeriod ? "" : " per year";
  if (isSeatLine(line)) return `Per seat${yearly}`;
  if (!line.commitment) return "One-time";
  return `Flat fee${yearly}`;
}
