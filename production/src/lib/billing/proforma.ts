/**
 * R-2519 (Pardeep, 6 Nov 2026 — "Zoho ki tarah proforma bhejna") — a renewal part's payment
 * request is a PROFORMA INVOICE: its own PI series (PI-<code>-<YY>-<NNNN>, migration
 * 20261106065103), seats × a per-seat rate with the period, a pay-by date, and a state that says
 * what really happened — "Ready to send" until an email went, "Expired" once the pay-by date passed
 * unpaid (still payable — the service period is running, so the reminders go on), "Cancelled" when
 * it was cancelled (kept, never deleted).
 *
 * Pure rules for the Bill-next-part preview (Renewals), the quote page and the PDF. Tests:
 * proforma-r2519.test.ts.
 */
import { addMonthsClamped, addDaysISO, CYCLE_MONTHS } from "./schedule";
import type { BillingCycle } from "@/lib/supabase/database.types";

/** A number from the PI series (R-2519). Older requests keep their Q- number. */
export function isProformaNumber(id: string | null | undefined): boolean {
  return typeof id === "string" && /^PI-/.test(id);
}

/** The title a part request's paper carries; null = an ordinary quote (its own title). */
export function proformaDocumentTitle(q: { isPartRequest: boolean }): string | null {
  return q.isPartRequest ? "Proforma Invoice" : null;
}

export interface PartAmounts { taxable: number; tax: number; gross: number }

/** seats × per-seat rate, GST on top (rounded to the rupee — the database's rule). */
export function partAmounts(a: { seats: number; seatRate: number; taxRate: number }): PartAmounts {
  const taxable = a.seats * a.seatRate;
  const tax = Math.round((taxable * a.taxRate) / 100);
  return { taxable, tax, gross: taxable + tax };
}

/** The part's per-seat rate when its taxable divides exactly by the seats (R-2101's rule), else null. */
export function defaultSeatRate(a: { seats: number; partTaxable: number }): number | null {
  if (!Number.isInteger(a.seats) || a.seats <= 0 || a.partTaxable <= 0) return null;
  return a.partTaxable % a.seats === 0 ? a.partTaxable / a.seats : null;
}

export interface Period { start: string; end: string }

/** The next `count` billing periods from `firstStart`, back to back; end inclusive. */
export function nextPeriods(a: { cycle: BillingCycle; firstStart: string; count: number }): Period[] {
  const m = CYCLE_MONTHS[a.cycle];
  const out: Period[] = [];
  for (let i = 0; i < a.count; i++) {
    out.push({
      start: addMonthsClamped(a.firstStart, i * m),
      end: addDaysISO(addMonthsClamped(a.firstStart, (i + 1) * m), -1),
    });
  }
  return out;
}

export const MAX_BILL_PERIODS = 12;

export interface BillNextBody { periods: number; seats: number | null; seatRate: number | null }

/** The Bill-next-part body: periods 1–12 (default 1); seats and per-seat rate together or not at all. */
export function parseBillNextBody(body: unknown): BillNextBody | { error: string } {
  const b = (body ?? {}) as { periods?: unknown; seats?: unknown; seatRate?: unknown };
  const periods = b.periods == null ? 1 : Number(b.periods);
  if (!Number.isInteger(periods) || periods < 1 || periods > MAX_BILL_PERIODS) {
    return { error: `Bill 1 to ${MAX_BILL_PERIODS} periods at a time.` };
  }
  const hasSeats = b.seats != null;
  const hasRate = b.seatRate != null;
  if (hasSeats !== hasRate) return { error: "Give the seats and the rate a seat together." };
  if (!hasSeats) return { periods, seats: null, seatRate: null };
  const seats = Number(b.seats);
  const seatRate = Number(b.seatRate);
  if (!Number.isInteger(seats) || seats < 1 || seats > 100_000) return { error: "Seats must be a whole number from 1 to 1,00,000." };
  if (!Number.isInteger(seatRate) || seatRate < 0 || seatRate > 10_000_000) return { error: "The rate a seat must be whole rupees, ₹0 or more." };
  return { periods, seats, seatRate };
}

export interface ShownState { label: "Ready to send" | "Expired" | "Cancelled"; kind: "info" | "danger" | "muted" }

const MONEY = new Set(["partial", "received", "invoiced"]);

/**
 * The state to show instead of the stored status, or null to keep the usual badge.
 *   cancelled (any quote)                            → Cancelled
 *   a part request with money / an invoice           → null (the payment badge says it)
 *   a part request past its pay-by date, unpaid      → Expired (still payable)
 *   a part request no email ever went out for        → Ready to send (it is stored 'sent' so every
 *                                                      money path keeps treating it as open)
 */
export function proformaShownState(q: {
  isPartRequest: boolean;
  status: string;
  cancelledAt: string | null | undefined;
  invoiceId: string | null | undefined;
  paymentStatus: string | null | undefined;
  mailed: boolean;
  dueOn: string | null | undefined;
  todayISO: string;
}): ShownState | null {
  if (q.cancelledAt) return { label: "Cancelled", kind: "muted" };
  if (!q.isPartRequest) return null;
  if (q.invoiceId || (q.paymentStatus && MONEY.has(q.paymentStatus))) return null;
  if (!["sent", "viewed", "accepted"].includes(q.status)) return null;
  if (q.dueOn && q.dueOn.slice(0, 10) < q.todayISO) return { label: "Expired", kind: "danger" };
  if (!q.mailed) return { label: "Ready to send", kind: "info" };
  return null;
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function dayMon(iso: string, withYear: boolean): string {
  const d = `${Number(iso.slice(8, 10))} ${MON[Number(iso.slice(5, 7)) - 1]}`;
  return withYear ? `${d} ${iso.slice(0, 4)}` : d;
}

/** "12 Nov–11 Dec 2026" (both years when they differ). */
export function periodText(start: string, end: string): string {
  return `${dayMon(start, start.slice(0, 4) !== end.slice(0, 4))}–${dayMon(end, true)}`;
}

/**
 * R-2519: the unit line under a part request's line on the paper — "Per seat · 12 Nov–11 Dec 2026"
 * instead of "One-time" (a renewal period is not a one-time charge). Null for any other line.
 */
export function partLineUnitLabel(line: { per_seat?: unknown; period_start?: unknown; period_end?: unknown }): string | null {
  const start = typeof line.period_start === "string" ? line.period_start.slice(0, 10) : null;
  const end = typeof line.period_end === "string" ? line.period_end.slice(0, 10) : null;
  const period = start && end ? periodText(start, end) : null;
  if (line.per_seat === true) return period ? `Per seat · ${period}` : "Per seat";
  return period ? `For ${period}` : null;
}

/** R-2519: the Bill-next-part preview (built server-side, bill-next.server.ts). */
export interface PreviewPeriod extends Period {
  /** A proforma / payment request this period already has (open or paid), or its tax invoice. */
  existing: { kind: "request" | "invoice"; id: string; status: string; amount: number | null } | null;
}

export interface BillNextPreview {
  cycle: BillingCycle;
  seats: number;
  /** ₹ a seat for ONE period; null when the part's amount does not divide by the seats. */
  seatRate: number | null;
  partTaxable: number;
  taxRate: number;
  amounts: { taxable: number; tax: number; gross: number };
  periods: PreviewPeriod[];
  /** The first period's start — the billing run bills every period starting on/before the last one's start. */
  firstStart: string;
}


/** R-2519 Cancel: the reason, 5–500 characters (kept on the record). */
export function parseCancelReason(body: unknown): { reason: string } | { error: string } {
  const r = typeof (body as { reason?: unknown } | null)?.reason === "string" ? ((body as { reason: string }).reason).trim() : "";
  if (r.length < 5) return { error: "Write why it is cancelled (at least 5 characters) — it is kept on the record." };
  return { reason: r.slice(0, 500) };
}

/**
 * R-2519: offer "Cancel quote" — an open quote with no money in and no invoice (an add-seats quote
 * uses Mark rejected, which takes its seats back — R-1705). "Undo cancel" — a cancelled one with
 * nothing paid.
 */
export function cancelQuoteAction(q: {
  status: string; cancelledAt: string | null | undefined; invoiceId: string | null | undefined;
  receivedSoFar: number; isAddSeats: boolean | null | undefined; supersededBy?: string | null;
}): "cancel" | "undo" | null {
  if (q.cancelledAt) return q.receivedSoFar <= 0 && !q.invoiceId ? "undo" : null;
  if (q.invoiceId || q.receivedSoFar > 0 || q.isAddSeats || q.supersededBy) return null;
  return ["draft", "sent", "viewed", "accepted"].includes(q.status) ? "cancel" : null;
}

/** R-2519: the part request's GST rule (bill_subscription_instalment) — a customer outside India pays 0%. */
export function partTaxRate(country: string | null | undefined, partTaxRate: number): number {
  if (country == null) return partTaxRate;
  const c = country.trim().toLowerCase();
  return ["", "in", "ind", "india", "bharat"].includes(c) ? partTaxRate : 0;
}
