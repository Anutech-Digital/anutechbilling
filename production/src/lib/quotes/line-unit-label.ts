/**
 * The "Per seat …" line under each item on the quote preview and PDF (R-482 / board R-469 (4)).
 *
 * Abhishek's Scenario 15: a support plan (Standard Yearly, qty 1, a flat fee) printed
 * "Per seat per year" on the quote, the preview and the PDF. A support plan or a one-time
 * service is not a seat. Same seat rule as the seat count (lib/quotes/seat-lines.ts).
 *
 * R-1673 (3): a domain registration printed "Per seat per year" too — it is per domain, and
 * its rate covers the whole registration term (`years`, the builder's "Register for" picker).
 */
import { isSeatLine, isDomainRegistrationLine, type SeatLineLike } from "./seat-lines";
import { domainLineYears } from "@/lib/provisioning/products";

/** `perPeriod` = the rate shown is per invoice (split billing), so no "per year" is added. */
export function lineUnitLabel(line: SeatLineLike, perPeriod: boolean): string {
  const yearly = perPeriod ? "" : " per year";
  if (line.commitment && isDomainRegistrationLine(line)) {
    const years = domainLineYears(line);
    return perPeriod ? "Per domain" : years > 1 ? `Per domain for ${years} years` : "Per domain per year";
  }
  if (isSeatLine(line)) return `Per seat${yearly}`;
  if (!line.commitment) return "One-time";
  return `Flat fee${yearly}`;
}
