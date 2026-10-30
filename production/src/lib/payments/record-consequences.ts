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
  /** R-2101: every plan that gets a subscription — record_payment makes one per line that
   *  carries a billing commitment (Business Starter + Business Standard → two). When given with
   *  more than one name, the sheet names them all instead of planLabel alone. */
  planLabels?: readonly string[];
  /** R-453: a renewal quote — record_payment moves the EXISTING subscription on by a term
   *  instead of creating one. Optional; absent means a normal quote. */
  renewsSubscription?: boolean;
  /** R-2087: a support-plan upgrade quote (isSupportUpgradeQuote) — stored as a renewal
   *  (no new subscription) but record_payment moves the EXISTING subscription to the new
   *  plan and keeps its renewal date. Wins over renewsSubscription. */
  upgradesPlan?: boolean;
  /** R-542: an add-seats quote (quotes.is_add_seats) — the seats were already added to the
   *  EXISTING subscription by Manage seats → Add Seats, and record_payment creates no
   *  subscription for it. Optional; absent means a normal quote. */
  addsSeats?: boolean;
}

/** R-542: what recording a payment on an add-seats quote does to the subscription. */
export const ADD_SEATS_CONSEQUENCE =
  "Adds the seats to the existing subscription — no new subscription is created. The next renewal bills the new seat count.";

/** R-2087: what recording the full payment on a support-plan upgrade quote does. */
export const UPGRADE_PLAN_CONSEQUENCE =
  "Upgrades the existing support plan once paid in full — same subscription, same renewal date. No new subscription is created.";

export function recordPaymentConsequences(args: {
  payment: PaymentToRecord;
  /** The tenant's receipt_voucher counter. Null when this is the year's first. */
  receiptSeries: SeriesState | null;
  /** R-1680: the quote already has its GST invoice, so this payment issues NO receipt voucher
   *  (record_payment books it against the invoice). Null receiptSeries alone meant both "first of
   *  the year" and "after the invoice", and the sheet said "Issues a GST receipt voucher" right
   *  beside "No new receipt voucher — post-invoice payment". */
  afterInvoice?: boolean;
}): Consequence[] {
  const { payment: p, receiptSeries, afterInvoice = false } = args;
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
  if (afterInvoice) {
    out.push({
      tone: "fact",
      text: "No receipt voucher — the GST invoice already exists, so this payment is recorded against it.",
    });
  } else if (receiptSeries) {
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

  if (p.upgradesPlan) {
    out.push({ tone: "fact", text: UPGRADE_PLAN_CONSEQUENCE });
  } else if (p.renewsSubscription) {
    /* R-453: "Creates a recurring subscription" on a renewal made the owner think a second
       subscription would appear. It does not — the same one gets a new renewal date. */
    out.push({
      tone: "fact",
      text: "Renews the existing subscription — the same subscription moves to its next renewal date. No new subscription is created.",
    });
  } else if (p.addsSeats) {
    /* R-542: the add-seats line carries a billing commitment, so it used to fall through to
       "Creates a recurring subscription" — the owner read that as double billing.
       record_payment skips subscription creation for is_add_seats quotes. */
    out.push({ tone: "fact", text: ADD_SEATS_CONSEQUENCE });
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
  } else if (p.priorReceived > 0) {
    /* R-2095 (Sept reconcile): a sale's subscriptions are filed by its FIRST receipt (record_payment,
       never twice) — a balance payment on Q-0224 said "Creates 2 recurring subscriptions". */
    out.push({
      tone: "fact",
      text: "The subscriptions on this quote already exist (made by its first payment) — this payment only adds to what was received. No new subscription is created.",
    });
  } else {
    const plans = (p.planLabels ?? []).map((x) => x.trim()).filter(Boolean);
    out.push({
      tone: "fact",
      text: plans.length > 1
        ? `Creates ${plans.length} recurring subscriptions — ${plans.slice(0, -1).join(", ")} and ${plans[plans.length - 1]} — and sets their first renewal date. The renewal cron will bill them from then on.`
        : `Creates a recurring subscription${p.planLabel?.trim() ? ` for ${p.planLabel.trim()}` : ""} and sets its first renewal date. The renewal cron will bill it from then on.`,
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
