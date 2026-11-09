/**
 * R-2623 — a vendor bill's SERVICE PERIOD: the month(s) the licence on the bill was used. The
 * management P&L puts the bill's cost in those months (R-2156, report_pnl_cogs_matched); GST
 * reports keep the bill date.
 *
 * The period itself is worked out in ONE place — SQL `vendor_bill_service_period` (a month written
 * on the bill, else the month before for Google / Microsoft, else the bill month; the owner's own
 * period wins). The screen reads it from the database (`vendor_bills_service_periods`) and never
 * guesses. This file only:
 *   - turns the From / To month pickers into the saved dates (1st .. last day, whole months, at
 *     most 36 — exactly the database check `vendor_bills_service_period_check`) and back;
 *   - words the period and its basis;
 *   - maps that check's raw error to plain English.
 */

import { serviceBasisLabel, type MatchedBill } from "@/lib/accounting/pnl-basis";
import { periodName } from "@/lib/accounting/pnl-compare";

/** set / reference / vendor_default / bill_month — the same field the P&L drill reads (R-2622). */
export type ServicePeriodBasis = MatchedBill["basis"];

/** The rule in words — shown when the database refuses a period. */
export const SERVICE_PERIOD_RULE_TEXT =
  "The service period must be whole months, the first month on or before the last, and at most 36 months.";

const MAX_MONTHS = 36;
const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** Last day of a month (month 1-12). */
function lastDay(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

/** From / To month pickers ("YYYY-MM") → the dates saved on the bill. */
export function monthsToPeriod(
  fromMonth: string,
  toMonth: string,
): { ok: true; service_from: string; service_to: string } | { ok: false; error: string } {
  const a = MONTH_RE.exec(fromMonth.trim());
  const b = MONTH_RE.exec(toMonth.trim());
  if (!fromMonth.trim() || !toMonth.trim()) return { ok: false, error: "Pick both the first and the last month." };
  if (!a || !b) return { ok: false, error: "Type each month as year-month, e.g. 2026-08." };
  const y1 = Number(a[1]), m1 = Number(a[2]);
  const y2 = Number(b[1]), m2 = Number(b[2]);
  const span = (y2 - y1) * 12 + (m2 - m1) + 1;
  if (span < 1) return { ok: false, error: "The last month must be the same as or after the first month." };
  if (span > MAX_MONTHS) return { ok: false, error: `A service period can be at most ${MAX_MONTHS} months.` };
  return {
    ok: true,
    service_from: `${y1}-${pad(m1)}-01`,
    service_to: `${y2}-${pad(m2)}-${pad(lastDay(y2, m2))}`,
  };
}

/** Saved dates → the month pickers' values ("" when the bill has none). */
export function periodToMonths(from: string | null | undefined, to: string | null | undefined): { from: string; to: string } {
  return { from: from ? from.slice(0, 7) : "", to: to ? to.slice(0, 7) : "" };
}

/** "Sep 2026", "Jul–Sep 2026", "Nov 2026 – Jan 2027" — the P&L drill's own words (periodName, R-2622). */
export function servicePeriodLabel(from: string | null | undefined, to: string | null | undefined): string {
  if (!from || !to) return "";
  return periodName({ from, to });
}

/** Why the bill has this period — the P&L drill's wording (serviceBasisLabel), marked "auto" unless the owner set it. */
export function servicePeriodBasisText(basis: ServicePeriodBasis | null | undefined): string {
  if (basis === "set") return serviceBasisLabel("set");
  return `auto (${serviceBasisLabel(basis ?? "bill_month")})`;
}

/** The database's period check refused → the rule in words; anything else → null (shown as is). */
export function servicePeriodErrorText(err: unknown): string | null {
  const msg = err && typeof err === "object" ? String((err as { message?: unknown }).message ?? "") : typeof err === "string" ? err : "";
  return msg.includes("vendor_bills_service_period_check") ? SERVICE_PERIOD_RULE_TEXT : null;
}

/** The bills list adds "for <period>" under the date only when it is not just the bill's own month. */
export function servicePeriodShowsInList(billDate: string, from: string | null | undefined, to: string | null | undefined): boolean {
  if (!from || !to) return false;
  const billMonth = billDate.slice(0, 7);
  return !(from.slice(0, 7) === billMonth && to.slice(0, 7) === billMonth);
}
