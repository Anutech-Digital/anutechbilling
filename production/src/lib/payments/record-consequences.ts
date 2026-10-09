/**
 * What recording a payment sets in motion.
 *
 * ─── WHAT THE DIALOG SAID BEFORE ────────────────────────────────────────────
 * "Record payment received". A title, and nothing else. Yet `record_payment` is the
 * single widest-reaching write in this app: in one transaction it can create a customer,
 * convert the lead, create a subscription, roll a renewal date forward, and allocate a
 * GST receipt-voucher number.
 *
 * ─── THE ONE NOBODY WOULD GUESS ─────────────────────────────────────────────
 * A receipt voucher is a GST document under CGST Section 31(3)(d), and its number comes
 * from the same gapless series machinery as an invoice. So recording a payment consumes a
 * serial. Measured 23 Aug 2026: ANUTECH holds **zero** payments while its receipt-voucher
 * series sits at **39** — thirty-nine numbers spent and every one of those payments since
 * deleted. Nothing on screen has ever mentioned that this happens.
 *
 * ─── AND WHAT IS *NOT* IRREVERSIBLE, WHICH MATTERS TOO ──────────────────────
 * Deleting the payment unwinds the rest cleanly — the subscriptions page already tells
 * the operator so ("delete the payment in Payments instead — that unwinds it cleanly").
 * Saying that here is not softening the warning, it is the difference between an operator
 * who freezes and one who knows the recovery. The serial is the part that does not come
 * back.
 */
import { rupee } from "@/lib/utils";
import { seriesGap, formatDocumentNumber, type Consequence, type SeriesState } from "@/lib/actions/consequence";

export interface PaymentToRecord {
  quoteId: string;
  customerName: string | null;
  /** Whole rupees. What is being recorded now. */
  amount: number;
  /** The quote's own total, in whole rupees. */
  quoteAmount: number | null;
  /** Already received against this quote, in whole rupees. */
  priorReceived: number;
  /** True when this quote has no customer yet — so a customer row gets created. */
  createsCustomer: boolean;
  /** True when this quote will produce a recurring subscription. */
  createsSubscription: boolean;
  /** The plan a subscription would be created for, when there is one. */
  planLabel: string | null;
  /** R-453: a renewal quote — record_payment moves the EXISTING subscription on by a term
   *  instead of creating one. Optional; absent means a normal quote. */
  renewsSubscription?: boolean;
}

export function recordPaymentConsequences(args: {
  payment: PaymentToRecord;
  /** The tenant's receipt_voucher counter. Null when this is the year's first. */
  receiptSeries: SeriesState | null;
}): Consequence[] {
  const { payment: p, receiptSeries } = args;
  const out: Consequence[] = [];

  if (p.amount <= 0) {
    /* record_payment refuses this outright ("amount must be > 0"), so it is a block. */
    out.push({
      tone: "warning",
      text: "A payment has to be more than zero. Nothing will be recorded.",
    });
    return out;
  }

  /* The receipt voucher, first — it is the irreversible part and the one no screen has
     ever mentioned. */
  if (receiptSeries) {
    const next = formatDocumentNumber(receiptSeries, receiptSeries.lastNumber + 1);
    out.push({
      tone: "fact",
      text: `Issues receipt voucher ${next} — a GST document under Section 31(3)(d). That number is used up whether or not the payment is later deleted.`,
    });
  } else {
    out.push({
      tone: "fact",
      text: "Issues a GST receipt voucher, the first of this financial year, under Section 31(3)(d).",
    });
  }

  const total = p.priorReceived + p.amount;
  const expected = p.quoteAmount ?? 0;

  out.push({
    tone: "fact",
    text: `Records ${rupee(p.amount)}${p.priorReceived > 0 ? ` on top of ${rupee(p.priorReceived)} already received, taking the total to ${rupee(total)}` : ""}${p.customerName?.trim() ? ` from ${p.customerName.trim()}` : ""}.`,
  });

  /* Overpayment is worth naming before the fact, not after. It is not blocked — a
     customer really can pay more than the quote — but it needs a decision, and the
     decision is easier now than when it turns up in a reconciliation. */
  if (expected > 0 && total > expected) {
    out.push({
      tone: "warning",
      text: `That is ${rupee(total - expected)} MORE than the quote's ${rupee(expected)}. The extra sits on the account as an advance until somebody adjusts it.`,
    });
  } else if (expected > 0 && total < expected) {
    out.push({
      tone: "fact",
      text: `${rupee(expected - total)} of the quote's ${rupee(expected)} will still be outstanding, and the quote stays partly paid.`,
    });
  }

  if (p.createsCustomer) {
    out.push({
      tone: "fact",
      text: "Turns the lead into a customer. The lead moves to Won and stops appearing in the pipeline.",
    });
  }

  if (p.renewsSubscription) {
    /* R-453: "Creates a recurring subscription" on a renewal made the owner think a second
       subscription would appear. It does not — the same one gets a new renewal date. */
    out.push({
      tone: "fact",
      text: "Renews the existing subscription — the same subscription moves to its next renewal date. No new subscription is created.",
    });
  } else if (!p.createsSubscription) {
    /* Stated POSITIVELY. An operator expecting a renewal should learn here that none is
       coming, not from one that never arrives. Phrased by OUTCOME rather than cause: the
       caller knows whether a subscription will be created, not why — guard 0157 (one-off)
       and "no billing commitment on the lines" both land here and the consequence is the
       same either way. */
    out.push({
      tone: "fact",
      text: "No subscription and no renewal are created from this payment — nothing will be billed again automatically.",
    });
  } else {
    out.push({
      tone: "fact",
      text: `Creates a recurring subscription${p.planLabel?.trim() ? ` for ${p.planLabel.trim()}` : ""} and sets its first renewal date. The renewal cron will bill it from then on.`,
    });
  }

  /* The recovery, stated plainly. Not a softening — an operator who knows the way back
     acts on a mistake instead of leaving it. */
  out.push({
    tone: "fact",
    text: "If this turns out to be wrong, delete the payment in Payments — that unwinds the customer and subscription cleanly. The receipt-voucher number does not come back.",
  });

  const gap = seriesGap(receiptSeries, "receipt voucher");
  if (gap) out.push(gap);

  return out;
}
