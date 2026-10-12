/**
 * UPI payment intent — the string behind the QR on invoices and quotes.
 *
 * WHY A STATIC UPI INTENT, NOT A RAZORPAY QR:
 * `upi://pay?…` is understood by every UPI app (GPay, PhonePe, Paytm, BHIM) and
 * needs nothing but the reseller's own VPA. It therefore ships TODAY, without
 * waiting on Razorpay KYC — and getting paid sooner is the whole point. The
 * trade-off is honest and worth stating: there is no automatic reconciliation,
 * because the money lands straight in the bank, not through a gateway webhook.
 * The operator still records the payment. A gateway QR can be added later
 * without changing this file's shape.
 *
 * Pure and tested: a malformed intent doesn't fail loudly, it silently sends
 * money to the wrong place or drops the amount, so every field is validated
 * rather than interpolated hopefully.
 *
 * Spec: NPCI UPI Linking Specification (pa/pn/am/cu/tn/tr).
 */

export interface UpiIntentInput {
  /** Payee VPA, e.g. `democo@okhdfcbank`. */
  vpa: string;
  /** Payee name shown in the UPI app before the user confirms. */
  payeeName: string;
  /** Whole rupees. Omit for a "scan and enter the amount" QR. */
  amount?: number | null;
  /** Free-text note — invoice number, typically. */
  note?: string | null;
  /** Merchant/transaction reference, echoed back in the bank statement. */
  ref?: string | null;
}

export type UpiResult =
  | { ok: true; uri: string }
  | { ok: false; error: string };

/**
 * A VPA is `handle@psp`. Deliberately conservative: letters, digits, dot,
 * hyphen and underscore before the `@`, letters/digits after it. A typo'd VPA
 * doesn't error at scan time — the payer's app just shows a different name, or
 * the transfer fails after they've tried. Better to refuse to print the QR.
 */
const VPA_RE = /^[a-zA-Z0-9.\-_]{2,64}@[a-zA-Z][a-zA-Z0-9.\-]{1,63}$/;

export function isValidVpa(vpa: string | null | undefined): boolean {
  return typeof vpa === "string" && VPA_RE.test(vpa.trim());
}

/**
 * UPI params are percent-encoded, but `&`, `=` and `#` inside a note are what
 * actually break a payment string, and some apps mishandle `+`. Strip to a
 * conservative set instead of trusting every app's parser.
 */
function cleanText(s: string, max: number): string {
  return s
    .replace(/[&=#?%]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/**
 * Build a `upi://pay` intent.
 *
 * Amount is emitted with exactly two decimals — several UPI apps reject or
 * silently drop a bare integer amount, which turns a "pay ₹11,800" QR into a
 * "type the amount yourself" QR without telling anyone.
 */
export function buildUpiIntent(input: UpiIntentInput): UpiResult {
  const vpa = (input.vpa ?? "").trim();
  if (!isValidVpa(vpa)) {
    return { ok: false, error: "Enter a valid UPI ID, e.g. yourname@okhdfcbank" };
  }

  const payeeName = cleanText(input.payeeName ?? "", 50);
  if (!payeeName) return { ok: false, error: "Payee name is required" };

  const params: string[] = [
    `pa=${encodeURIComponent(vpa)}`,
    `pn=${encodeURIComponent(payeeName)}`,
  ];

  if (input.amount !== null && input.amount !== undefined) {
    if (!Number.isFinite(input.amount)) return { ok: false, error: "Amount is not a number" };
    if (input.amount < 0) return { ok: false, error: "Amount can't be negative" };
    // A ₹0 QR is a real footgun: it looks payable and does nothing. Treat it as
    // "no amount" so the payer is asked to enter one.
    if (input.amount > 0) params.push(`am=${input.amount.toFixed(2)}`);
  }

  params.push("cu=INR");

  const note = cleanText(input.note ?? "", 50);
  if (note) params.push(`tn=${encodeURIComponent(note)}`);

  const ref = cleanText(input.ref ?? "", 35).replace(/[^a-zA-Z0-9\-]/g, "");
  if (ref) params.push(`tr=${encodeURIComponent(ref)}`);

  return { ok: true, uri: `upi://pay?${params.join("&")}` };
}

/**
 * Convenience for an invoice. Returns null when the tenant hasn't set a VPA —
 * callers render nothing rather than a broken QR.
 *
 * An INVOICE is stricter than the primitive above. `buildUpiIntent` may legitimately
 * emit an open-amount QR — that is what a shop counter's static QR is. An invoice
 * is the opposite: the amount is the entire point, and a nothing-owed invoice must
 * print no QR at all. Otherwise a fully-settled invoice carries a live "scan to pay"
 * block with no amount in it, and a customer doing the diligent thing — paying what
 * the document appears to ask for — pays twice.
 *
 * So `amountDue` must be a positive number here. Zero, null and negative all mean
 * "nothing is owed", and all three yield no QR. Pass the result of
 * `invoiceAmountDue()` rather than a raw column: `net_payable` alone ignores
 * receipts and over-asks by exactly what has already been paid.
 */
export function invoiceUpiIntent(args: {
  vpa: string | null | undefined;
  payeeName: string | null | undefined;
  invoiceId: string;
  amountDue: number | null | undefined;
}): string | null {
  if (!args.vpa || !args.payeeName) return null;
  if (!isCollectable(args.amountDue)) return null;
  const r = buildUpiIntent({
    vpa: args.vpa,
    payeeName: args.payeeName,
    amount: args.amountDue ?? null,
    note: `Invoice ${args.invoiceId}`,
    ref: args.invoiceId,
  });
  return r.ok ? r.uri : null;
}

/** Shared guard: an amount is collectable only if it is a real positive number. */
function isCollectable(v: number | null | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v > 0;
}

/**
 * Convenience for a QUOTE. Same strictness as the invoice version — no amount
 * means no QR — but the note says "Advance", because that is what the money
 * legally is: a payment received before the tax invoice exists, which the seller
 * must acknowledge with a Receipt Voucher under CGST §31(3)(d), not a tax
 * invoice. Getting that word right in the bank narration is what lets the
 * reseller tell an advance apart from an invoice settlement at reconciliation
 * time, months later, from the statement alone.
 *
 * Pass `quoteAmountDue()` — it refuses non-INR quotes, which a UPI QR cannot
 * collect, and refuses quotes already handed over to an invoice.
 */
export function quoteUpiIntent(args: {
  vpa: string | null | undefined;
  payeeName: string | null | undefined;
  quoteId: string;
  amountDue: number | null | undefined;
}): string | null {
  if (!args.vpa || !args.payeeName) return null;
  if (!isCollectable(args.amountDue)) return null;
  const r = buildUpiIntent({
    vpa:       args.vpa,
    payeeName: args.payeeName,
    amount:    args.amountDue,
    note:      `Advance ${args.quoteId}`,
    ref:       args.quoteId,
  });
  return r.ok ? r.uri : null;
}
