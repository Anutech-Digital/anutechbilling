/**
 * R-2252 (Zoho Billing audit A17, 31 Oct 2026): "Reduce seats" in Manage seats, with a credit
 * the owner can SEE before saving.
 *
 * Why: Manage seats only added. A seat cut went through Correct details (no money) or a hand
 * credit note, and Zoho shows ₹0 and hides the credit — neither app told the owner what the
 * customer gets back.
 *
 * Two ways:
 *   · NOW — the seats drop today. The unused days of the current part for the removed seats,
 *     priced exactly like Add seats prices them (seatChargePlan + seatIncreaseCharge: the part's
 *     own rate when billed in parts, annual × days ÷ term days otherwise), is the value given
 *     back. R-2255's splitChangeCredit() decides how it lands: first it LOWERS what the part's
 *     invoice still asks for, the rest becomes the customer's credit — never more than was
 *     received. The server (reduce_subscription_seats, migration 20261108013626) repeats the
 *     same split on the locked invoice row and issues ONE credit note for it (CGST s.34).
 *   · END OF TERM — nothing changes now and no money moves; the cut is scheduled for the
 *     renewal date (the customer keeps the seats they paid for until then).
 *
 * Pure: the preview endpoint (GET /api/subscriptions/[id]/reduce-seats), the POST and the tests
 * call it, so the number shown is the number booked.
 */
import { seatChargePlan, type SeatWindowSub } from "./seat-charge-window";
import { seatIncreaseCharge } from "./seat-increase-charge";
import { rupeesToPaise, formatPaise, type Paise } from "./proration";
import { splitChangeCredit, type ChangeCreditSplit } from "./change-credit";

export type SeatReductionTiming = "now" | "end_of_term";

export interface SeatReductionSub extends SeatWindowSub {
  seats: number;
}

export interface SeatReductionValueOk {
  ok: true;
  seatsBefore: number;
  seatsRemoved: number;
  seatsAfter: number;
  /** ₹/seat/year the subscription bills (from mrr) — what the removed seats are valued at. */
  annualPerSeat: number;
  /** Unused days of the current part (today → part / term end). */
  days: number;
  /** Last day the current part covers (inclusive). */
  partEnd: string;
  /** True when the part is an instalment (billed in parts). */
  instalmentPart: boolean;
  /** Ex-GST value of the unused days, whole rupees. */
  subtotal: number;
  /** GST on it, whole rupees. */
  tax: number;
  /** Incl. GST, whole rupees — what reduce_subscription_seats() receives as p_unused_gross. */
  total: number;
  /** Same as `total`, in paise, for splitChangeCredit(). */
  unusedPaise: Paise;
  /** ₹/month after the cut. */
  newMrr: number;
}

export type SeatReductionValue =
  | SeatReductionValueOk
  | { ok: false; code: "invalid_seats" | "too_many" | "no_renewal_date" | "term_ended"; message: string };

/**
 * The value of the removed seats' unused days in the current part — the credit before the
 * paid/unpaid split. Same window and rate rules as Add seats, with the effective date = today.
 */
export function seatReductionValue(input: {
  sub: SeatReductionSub;
  seatsRemoved: number;
  today: string;
  taxRatePct: number;
}): SeatReductionValue {
  const { sub, seatsRemoved, today, taxRatePct } = input;
  if (!Number.isInteger(seatsRemoved) || seatsRemoved < 1) {
    return { ok: false, code: "invalid_seats", message: "Remove at least 1 seat." };
  }
  if (seatsRemoved >= sub.seats) {
    return {
      ok: false,
      code: "too_many",
      message: `At least 1 seat must stay — this subscription has ${sub.seats}. To stop every seat, cancel the subscription instead.`,
    };
  }
  if (!sub.renewal_date) {
    return { ok: false, code: "no_renewal_date", message: "This subscription has no renewal date, so the unused days cannot be worked out. Add the renewal date in Correct details first." };
  }
  const plan = seatChargePlan(sub, today, today);
  const window = plan?.current ?? null;
  if (!window || window.remainingDays <= 0) {
    return { ok: false, code: "term_ended", message: "This term has ended — there are no unused days to credit. Renew or extend it first, or reduce the seats at the next renewal." };
  }
  const charge = seatIncreaseCharge({
    currentSeats: sub.seats,
    currentMrr: sub.mrr,
    additionalSeats: seatsRemoved,
    remainingDays: window.remainingDays,
    termDays: window.termDays,
    taxRatePct,
    parts: window.parts ?? null,
  });
  const seatsAfter = sub.seats - seatsRemoved;
  return {
    ok: true,
    seatsBefore: sub.seats,
    seatsRemoved,
    seatsAfter,
    annualPerSeat: charge.storedAnnualPerSeat,
    days: window.remainingDays,
    partEnd: window.chargeTo,
    instalmentPart: window.instalmentPeriod,
    subtotal: charge.subtotal,
    tax: charge.tax,
    total: charge.total,
    unusedPaise: rupeesToPaise(charge.total),
    newMrr: Math.round((charge.storedAnnualPerSeat * seatsAfter) / 12),
  };
}

/** What the part's tax invoice says, in RUPEES as stored — the inputs the server split reads. */
export interface ReductionInvoiceMoney {
  id: string;
  /** What it still asks for now (pending/overdue, not written off) — openInvoiceDue(). */
  openDue: number;
  /** Money settled on it (receipts + adjusted advances; a Paid invoice at least its value). */
  received: number;
  /** Credit already given back from it by an earlier credit note. */
  alreadyCredited: number;
  /** What a further credit note may still take off it (amount − earlier credit notes). */
  creditable: number;
}

export interface SeatReductionPreview {
  value: SeatReductionValueOk;
  /** null when the part has no tax invoice yet. */
  invoice: ReductionInvoiceMoney | null;
  split: ChangeCreditSplit;
  /** "Now" can be saved: there is an invoice to credit against (or nothing to credit). */
  canReduceNow: boolean;
  /** Why not, in plain words — "" when it can. */
  blockedReason: string;
}

/**
 * R-2255's split on the part's invoice (rupees in, paise inside). The credit note may never take
 * more than the invoice still has (creditable) — the server caps it the same way.
 */
export function seatReductionPreview(value: SeatReductionValueOk, invoice: ReductionInvoiceMoney | null): SeatReductionPreview {
  const unused = invoice ? Math.min(value.unusedPaise, rupeesToPaise(Math.max(0, invoice.creditable))) : value.unusedPaise;
  const split = splitChangeCredit({
    unusedPaise: unused,
    openDuePaise: invoice ? rupeesToPaise(Math.max(0, invoice.openDue)) : 0,
    receivedPaise: invoice ? rupeesToPaise(Math.max(0, invoice.received)) : 0,
    alreadyCreditedPaise: invoice ? rupeesToPaise(Math.max(0, invoice.alreadyCredited)) : 0,
    invoiced: invoice !== null,
  });
  /* The cap by `creditable` is "not given" too — report it on the full unused value. */
  const capped = value.unusedPaise - unused;
  const notGivenPaise = split.notGivenPaise + capped;
  const fullSplit: ChangeCreditSplit = capped > 0
    ? {
        ...split,
        unusedPaise: value.unusedPaise,
        notGivenPaise,
        lines: [
          ...split.lines.filter((l) => l.kind !== "not-given"),
          { kind: "not-given", amountPaise: notGivenPaise, text: `Not given back (more than is owed, was received or the invoice has left to credit): ${formatPaise(notGivenPaise)}` },
        ],
      }
    : split;
  const blocked = invoice === null && value.unusedPaise > 0;
  return {
    value,
    invoice,
    split: fullSplit,
    canReduceNow: !blocked,
    blockedReason: blocked
      ? "This part has no tax invoice yet, so there is no invoice to credit. Choose “At end of term”, or reduce the seats after the part is invoiced."
      : "",
  };
}

/** The scheduled row's one-line description for the subscription screens. */
export function scheduledReductionText(r: { seats_before: number; seats_after: number; effective_date: string }, fmt: (iso: string) => string): string {
  return `Seats go from ${r.seats_before} to ${r.seats_after} on ${fmt(r.effective_date)} (end of term) — no credit; the customer keeps the seats until then.`;
}
