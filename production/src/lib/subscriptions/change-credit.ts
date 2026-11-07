/**
 * R-2255 (Zoho Billing audit A20, 31 Oct 2026): on a mid-term plan change (R-2227, A3) or a
 * seat cut (R-2252, A17), the customer gets a CREDIT only up to money actually received.
 *
 * Why: Zoho's change-plan preview credited the unused part of the old plan (₹1,829.03)
 * against an invoice of ₹2,700 that was never paid — copying that hands out money we never got.
 *
 * The rule, in one line: the unused value first LOWERS WHAT IS STILL OWED on the part's
 * invoice / payment request; only what is left after that is a credit to the customer.
 *
 *   due            = billed − received          (received is capped at billed)
 *   lowerOpen      = min(unused, due)
 *   credit         = unused − lowerOpen  =  max(0, received − used)
 *
 * So the credit can never exceed what was received for this part, and the two lines always add
 * up to the unused value. When the part has a tax invoice, ONE credit note for the full unused
 * value is the GST document (CGST s.34 — it reduces the invoice by the value of the supply not
 * made); this split only says how that note's value lands: first against the invoice's open
 * balance, the rest as the customer's credit. With no tax invoice yet (only an open payment
 * request), there is no credit note — the request itself is lowered.
 *
 * All amounts are integer paise and include GST (pass `prorate(...).totalPaise` as unused).
 */
import { formatPaise, type Paise } from "./proration";

export interface ChangeCreditInput {
  /** Value of the unused part being given back (incl. GST), from prorate(). */
  unusedPaise: Paise;
  /** Total of the part's invoice / payment request (incl. GST). */
  billedPaise: Paise;
  /** Money actually received against that invoice / request. */
  receivedPaise: Paise;
  /** True when a tax invoice exists for the part (then a credit note is the document). */
  invoiced: boolean;
}

export interface ChangeCreditLine {
  kind: "lower-open" | "credit";
  amountPaise: Paise;
  /** Ready-to-show preview text. */
  text: string;
}

export interface ChangeCreditSplit {
  unusedPaise: Paise;
  /** Billed − unused: the value of the days/seats actually used. */
  usedPaise: Paise;
  /** Part of the unused value that lowers the open (unpaid) amount. */
  lowerOpenPaise: Paise;
  /** Part of the unused value that becomes the customer's credit — never more than received. */
  creditPaise: Paise;
  /** What the customer still owes on this part after the change. */
  stillOwedPaise: Paise;
  /** Credit note value to issue on the invoice (0 when there is no tax invoice yet). */
  creditNotePaise: Paise;
  /** The two preview lines, always both, in this order. */
  lines: [ChangeCreditLine, ChangeCreditLine];
}

function assertPaise(name: string, v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`splitChangeCredit: ${name} must be a whole, non-negative number of paise (got ${String(v)})`);
  }
}

export function splitChangeCredit(input: ChangeCreditInput): ChangeCreditSplit {
  const { unusedPaise, billedPaise, invoiced } = input;
  assertPaise("unusedPaise", unusedPaise);
  assertPaise("billedPaise", billedPaise);
  assertPaise("receivedPaise", input.receivedPaise);
  if (unusedPaise > billedPaise) {
    throw new Error(
      `splitChangeCredit: the unused part (${formatPaise(unusedPaise)}) is more than was billed (${formatPaise(billedPaise)})`,
    );
  }

  // Money received beyond this bill belongs elsewhere (advance / another invoice), not to this change.
  const receivedPaise = Math.min(input.receivedPaise, billedPaise);
  const duePaise = billedPaise - receivedPaise;
  const lowerOpenPaise = Math.min(unusedPaise, duePaise);
  const creditPaise = unusedPaise - lowerOpenPaise;

  const creditText =
    `Credit to customer (from money received): ${formatPaise(creditPaise)}` +
    (receivedPaise === 0 ? " — nothing received yet" : "");

  return {
    unusedPaise,
    usedPaise: billedPaise - unusedPaise,
    lowerOpenPaise,
    creditPaise,
    stillOwedPaise: duePaise - lowerOpenPaise,
    creditNotePaise: invoiced ? unusedPaise : 0,
    lines: [
      { kind: "lower-open", amountPaise: lowerOpenPaise, text: `Lowers what they still owe: ${formatPaise(lowerOpenPaise)}` },
      { kind: "credit", amountPaise: creditPaise, text: creditText },
    ],
  };
}
