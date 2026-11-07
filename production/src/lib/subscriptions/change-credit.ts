/**
 * R-2255 (Zoho Billing audit A20, 31 Oct 2026): on a mid-term plan change (R-2227, A3) or a
 * seat cut (R-2252, A17), the customer gets a CREDIT only up to money actually received.
 *
 * Why: Zoho's change-plan preview credited the unused part of the old plan (₹1,829.03)
 * against an invoice of ₹2,700 that was never paid — copying that hands out money we never got.
 *
 * The rule: the unused value first LOWERS WHAT THE PART'S INVOICE / REQUEST STILL ASKS FOR;
 * only what is left after that becomes a credit, and never more than was received (less any
 * credit already given back from that money by an earlier change):
 *
 *   lowerOpen = min(unused, openDue)
 *   credit    = min(unused − lowerOpen, received − alreadyCredited)
 *   notGiven  = unused − lowerOpen − credit      (normally 0 — shown when it is not)
 *
 * When the part has a tax invoice, the document is ONE credit note for lowerOpen + credit
 * (CGST s.34 — it reduces the invoice by the value of the supply not made); this split says how
 * its value lands: first against the open balance, the rest as the customer's credit. With no
 * tax invoice yet, money received is an advance: giving part of it back is a refund voucher
 * (CGST rule 51), and an unpaid request is simply lowered.
 *
 * ⚠ UNITS: everything here is integer PAISE, incl. GST. The DB columns (invoices.amount,
 * net_payable, paid_amount) are RUPEES — convert with `openDuePaiseOf()` / `rupeesToPaise()`.
 * `unusedPaise` is the size of the giveback: `prorate(...)` priced with negative seats returns a
 * negative total — pass it as it is, the sign is ignored.
 *
 * The server RPC that books the change (R-2227 / R-2252) must apply the same split — this file is
 * the preview's and the tests' copy of the rule, like cancel-due.ts is for cancel_subscription().
 */
import { formatPaise, rupeesToPaise, type Paise } from "./proration";
import { openInvoiceDue, type SubInvoiceRow } from "./cancel-due";

export interface ChangeCreditInput {
  /** Value of the unused part being given back (incl. GST), e.g. `prorate(...).totalPaise`. Sign ignored. */
  unusedPaise: Paise;
  /** What the part's invoice / payment request still asks for NOW (after TDS, earlier credit notes,
   *  write-off) — `openDuePaiseOf(invoiceRow)` for an invoice. */
  openDuePaise: Paise;
  /** Money received for this part (TDS the customer deducted counts as received). */
  receivedPaise: Paise;
  /** Credit already given back from that money by an earlier change on the same part. Default 0. */
  alreadyCreditedPaise?: Paise;
  /** True when a tax invoice exists for the part. */
  invoiced: boolean;
}

export interface ChangeCreditLine {
  kind: "lower-open" | "credit" | "not-given";
  amountPaise: Paise;
  /** Ready-to-show preview text. */
  text: string;
}

export interface ChangeCreditSplit {
  unusedPaise: Paise;
  /** Part of the unused value that lowers the open (unpaid) amount. */
  lowerOpenPaise: Paise;
  /** Part that becomes the customer's credit — never more than received (less earlier credit). */
  creditPaise: Paise;
  /** Part not given back at all (more than is open + received). Normally 0. */
  notGivenPaise: Paise;
  /** What the invoice / request still asks for after the change. */
  stillOwedPaise: Paise;
  /** The document that carries it. */
  document: "credit-note" | "refund-voucher" | "none";
  /** Value of that document (credit note = lowerOpen + credit; refund voucher = credit). */
  documentPaise: Paise;
  /** Preview lines: always "lower-open" then "credit"; "not-given" only when it is not 0. */
  lines: ChangeCreditLine[];
}

function assertPaise(name: string, v: unknown): asserts v is number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`splitChangeCredit: ${name} must be a whole, non-negative number of paise (got ${String(v)})`);
  }
}

/** What an invoice row still asks for, in paise (the DB row is in rupees). */
export function openDuePaiseOf(row: SubInvoiceRow): Paise {
  return rupeesToPaise(openInvoiceDue(row));
}

export function splitChangeCredit(input: ChangeCreditInput): ChangeCreditSplit {
  if (typeof input.unusedPaise !== "number" || !Number.isSafeInteger(input.unusedPaise)) {
    throw new Error(`splitChangeCredit: unusedPaise must be a whole number of paise (got ${String(input.unusedPaise)})`);
  }
  const unusedPaise = Math.abs(input.unusedPaise);
  const { openDuePaise, receivedPaise, invoiced } = input;
  const alreadyCreditedPaise = input.alreadyCreditedPaise ?? 0;
  assertPaise("openDuePaise", openDuePaise);
  assertPaise("receivedPaise", receivedPaise);
  assertPaise("alreadyCreditedPaise", alreadyCreditedPaise);

  const lowerOpenPaise = Math.min(unusedPaise, openDuePaise);
  const creditablePaise = Math.max(0, receivedPaise - alreadyCreditedPaise);
  const creditPaise = Math.min(unusedPaise - lowerOpenPaise, creditablePaise);
  const notGivenPaise = unusedPaise - lowerOpenPaise - creditPaise;

  let creditReason = "";
  if (creditPaise === 0 && unusedPaise > 0) {
    creditReason = creditablePaise === 0 && receivedPaise === 0
      ? " — nothing received yet"
      : creditablePaise === 0
        ? " — what was received is already given back"
        : " — what was received covers only the part used";
  }

  const lines: ChangeCreditLine[] = [
    { kind: "lower-open", amountPaise: lowerOpenPaise, text: `Lowers what they still owe: ${formatPaise(lowerOpenPaise)}` },
    { kind: "credit", amountPaise: creditPaise, text: `Credit to customer (from money received): ${formatPaise(creditPaise)}${creditReason}` },
  ];
  if (notGivenPaise > 0) {
    lines.push({
      kind: "not-given",
      amountPaise: notGivenPaise,
      text: `Not given back (more than is owed or was received): ${formatPaise(notGivenPaise)}`,
    });
  }

  const document: ChangeCreditSplit["document"] = invoiced
    ? (lowerOpenPaise + creditPaise > 0 ? "credit-note" : "none")
    : (creditPaise > 0 ? "refund-voucher" : "none");
  const documentPaise = document === "credit-note" ? lowerOpenPaise + creditPaise
    : document === "refund-voucher" ? creditPaise : 0;

  return {
    unusedPaise,
    lowerOpenPaise,
    creditPaise,
    notGivenPaise,
    stillOwedPaise: openDuePaise - lowerOpenPaise,
    document,
    documentPaise,
    lines,
  };
}
