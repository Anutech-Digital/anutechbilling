/**
 * What can be DONE with the money on a quote right now.
 *
 * ─── THE DEAD END THIS REPLACES ─────────────────────────────────────────────
 * The quote page decided its own actions inline, in two conditions written months apart:
 *
 *     accepted && payment_status === "awaiting"                    → Record payment
 *     accepted && (payment_status === "received" || "partial")     → Generate GST Invoice
 *
 * Neither matches `payment_status = 'none'`, which is the column DEFAULT. So an accepted
 * quote that never went through the Mark-accepted button — accepted on the public page,
 * imported, or set directly — showed no money action at all. Live example, reported by
 * Pardeep: Q-2026-9776, accepted, ₹45,360, `payment_status = 'none'`, no Record payment
 * button and no invoice button. The deal simply could not be progressed from its own page.
 *
 * 'none' and 'awaiting' say the same thing in plain English: accepted, no money yet.
 * Treating them as different states was the whole bug, and the fix is to stop having two
 * places that each decide half of this.
 *
 * ─── AND AN INVOICE NO LONGER WAITS FOR PAYMENT ─────────────────────────────
 * The old rule let you invoice only once money had arrived. That is a constraint this app
 * invented; GST law does not have it. CGST §31(2) with Rule 47 requires a tax invoice for
 * services WITHIN 30 days of supply — payment is not a precondition, and a B2B customer
 * routinely needs the invoice in hand before their own accounts department will release
 * the payment at all. Pardeep's words: *"kai baar log payment se pehle invoice maangte
 * hai."* Refusing meant the reseller had to raise that invoice somewhere else, and the
 * books here would never know about it.
 *
 * So invoicing is offered from acceptance onward. What changes with payment is the
 * WORDING, not the permission — an invoice raised before any money says the full amount
 * is payable, and one raised after a part payment says what is left.
 */

export interface QuoteMoneyInput {
  status: string;
  /** `quotes.payment_status` — 'none' is the column default and means the same as
   *  'awaiting'. Null is treated the same way. */
  paymentStatus: string | null | undefined;
  /** Set once an invoice exists. From then on the invoice owns the money. */
  invoiceId: string | null | undefined;
  /** ₹, whole rupees. */
  total: number;
  /** ₹ received so far, across every recorded payment. */
  received: number;
  /** R-446: the cycle when the deal is billed per period (monthly / quarterly / half-yearly).
   *  The database refuses a whole-term invoice then (trigger
   *  invoices_reject_full_term_when_split_billed), so the page must not offer one. */
  splitBilledCycle?: string | null;
}

export type MoneyStage =
  /** Not sent yet — nothing to collect. */
  | "draft"
  /** Sent or viewed, not yet accepted. */
  | "open"
  /** Accepted, no money received. Covers BOTH 'none' and 'awaiting'. */
  | "unpaid"
  /** Some money in, balance outstanding. */
  | "partial"
  /** Paid in full, no invoice raised yet. */
  | "paid"
  /** An invoice exists — it owns the balance from here. */
  | "invoiced"
  /** Rejected or expired. */
  | "closed";

export interface MoneyActions {
  stage: MoneyStage;
  /** Offer a Record-payment button. */
  canRecordPayment: boolean;
  /** Offer a Generate-invoice button. */
  canGenerateInvoice: boolean;
  /** Button label — "Record payment" vs "Record balance payment" is a real difference. */
  recordLabel: string;
  /** The sentence beside the buttons. Always states the amount at stake. */
  note: string;
  /** ₹ still to collect. */
  outstanding: number;
}

export function quoteMoneyActions(q: QuoteMoneyInput, rupees: (n: number) => string): MoneyActions {
  const outstanding = Math.max(0, q.total - q.received);
  const stage = moneyStage(q);

  /* R-446: a per-period plan is invoiced by the billing run, one period at a time. Offering
     "Generate GST Invoice" there only led to a red refusal. Same money stages, no invoice
     button, and the sentence says where the invoice comes from. */
  const cycle = q.splitBilledCycle ? q.splitBilledCycle.replace(/_/g, "-") : null;
  if (cycle && (stage === "unpaid" || stage === "partial" || stage === "paid")) {
    const each = `Billed ${cycle}: each period gets its own GST invoice on its date.`;
    if (stage === "unpaid") {
      return base(stage, outstanding, {
        note: `Accepted. ${rupees(q.total)} to collect — record the payment when it arrives. ${each}`,
        canRecordPayment: true,
      });
    }
    if (stage === "partial") {
      return base(stage, outstanding, {
        note: `${rupees(q.received)} of ${rupees(q.total)} received · ${rupees(outstanding)} still outstanding. ${each}`,
        canRecordPayment: true,
        recordLabel: "Record balance payment",
      });
    }
    return base(stage, outstanding, {
      note: `Paid in full — ${rupees(q.received || q.total)} received. ${each}`,
    });
  }

  switch (stage) {
    case "draft":
      /* R-444: no sentence here. The draft row just above the money row already says
         "This is a draft. Send it to the customer when ready." — the page showed it twice. */
      return base(stage, outstanding, {});

    case "open":
      return base(stage, outstanding, {
        note: "Waiting on the customer. You can still record a payment if money arrives before they formally accept.",
        /* Money sometimes lands before anyone presses Accept, and refusing to record it
           is how a real payment ends up in a WhatsApp thread instead of the books. */
        canRecordPayment: true,
      });

    case "unpaid":
      return base(stage, outstanding, {
        note: `Accepted. ${rupees(q.total)} to collect — record the payment when it arrives, or raise the GST invoice now if the customer needs it first.`,
        canRecordPayment: true,
        canGenerateInvoice: true,
        recordLabel: "Record payment",
      });

    case "partial":
      return base(stage, outstanding, {
        note: `${rupees(q.received)} of ${rupees(q.total)} received · ${rupees(outstanding)} still outstanding.`,
        canRecordPayment: true,
        canGenerateInvoice: true,
        recordLabel: "Record balance payment",
      });

    case "paid":
      return base(stage, outstanding, {
        note: `Paid in full — ${rupees(q.received || q.total)} received. Raise the GST invoice to close this off in the books.`,
        canGenerateInvoice: true,
      });

    case "invoiced":
      return base(stage, outstanding, {
        /* Deliberately no buttons. Two places that both take payment against one deal is
           how the same rupee gets recorded twice. */
        note: "An invoice has been raised — record any further payment against the invoice, not against this quote.",
      });

    case "closed":
      return base(stage, outstanding, {
        note: "This quote is closed. Reopen it if the customer has come back.",
      });
  }
}

function base(
  stage: MoneyStage,
  outstanding: number,
  over: Partial<Omit<MoneyActions, "stage" | "outstanding">>,
): MoneyActions {
  return {
    stage,
    outstanding,
    canRecordPayment: false,
    canGenerateInvoice: false,
    recordLabel: "Record payment",
    note: "",
    ...over,
  };
}

/**
 * R-446: the per-period cycle of a deal, or null when it is invoiced once (yearly / unknown).
 * The subscriptions win — they are what the database trigger reads — and the quote's own
 * cycle covers the time before a subscription exists.
 */
export function splitBilledCycleOf(
  quoteCycle: string | null | undefined,
  subscriptionCycles: ReadonlyArray<string | null | undefined>,
): string | null {
  const fromSubs = subscriptionCycles.find((c) => Boolean(c) && c !== "yearly");
  if (fromSubs) return fromSubs;
  if (subscriptionCycles.some((c) => c === "yearly")) return null;
  return quoteCycle && quoteCycle !== "yearly" ? quoteCycle : null;
}

export function moneyStage(q: QuoteMoneyInput): MoneyStage {
  /* An invoice wins over everything: once it exists, it is the document the customer owes
     against, and the quote is history. */
  if (q.invoiceId || q.paymentStatus === "invoiced") return "invoiced";

  /* A dead quote stays dead even if money once landed on it — offering "record the
     balance" on a rejected deal invites collecting against something nobody is selling.
     A refund is the conversation there, and it does not live on this row. */
  if (q.status === "rejected" || q.status === "expired" || q.status === "lost") return "closed";

  /* ── MONEY BEFORE WORKFLOW ────────────────────────────────────────────────
     These three checks used to sit BELOW `if (q.status !== "accepted") return "open"`, so
     the money was only ever consulted for a quote somebody had remembered to mark
     accepted. Measured on production: Q-ADPL-2026-27-0024 · ₹38,232 · ₹20,000 received
     by UPI with receipt voucher RV-ADPL-2026-27-0024 · status still `sent`. Stage came
     back "open", so its page offered "Record payment" as though the account were empty
     and said "Payment can land later — record it when received" about money already in
     the bank.

     A status is a note about a conversation. A payment is a fact about a bank account.
     Money is read first, and from the recorded ROWS before the status column — a label is
     something somebody has to remember to move, and where the two disagree the rows are
     right. Same derived-over-stored rule as the already-quoted banner on /enquiries. */
  if (q.received > 0) return q.received >= q.total ? "paid" : "partial";
  if (q.paymentStatus === "received") return "paid";
  if (q.paymentStatus === "partial")  return "partial";

  if (q.status === "draft") return "draft";
  if (q.status !== "accepted") return "open";

  /* 'none' (the column default), 'awaiting', null — all one state: accepted, nothing in.
     Splitting these is what produced a quote with no buttons at all. */
  return "unpaid";
}
