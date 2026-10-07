/**
 * "Issue GST invoice now" on the desk Record payment sheet (R-378, 7 Oct 2026).
 *
 * WHY: a payment taken online is invoiced straight away (online-invoice.server.ts), but a
 * FULL payment recorded at the desk left the owner to find and press "Generate GST Invoice"
 * afterwards — found in the 7 Oct live flow test. The sheet now offers a checkbox and, after
 * record_payment succeeds, calls generate_invoice the same way the quote page's button does
 * (useGenerateInvoice). A refusal shows generate_invoice's own reason and the quote keeps its
 * button, so nothing is lost.
 *
 * Rules (pure, unit-tested here; the sheet only renders them):
 *   · never offered when the quote already has an invoice (one quote, one invoice);
 *   · never offered for a SPLIT-billed quote — billing_cycle monthly / quarterly / half-yearly.
 *     Those are invoiced one period at a time by raise_subscription_billing, and the
 *     invoices_reject_full_term_when_split_billed trigger refuses a whole-term invoice;
 *   · shown only when this payment completes the quote, and ticked by default when the place of supply is
 *     known — state code, else the GSTIN's state, or a customer outside India (export).
 *     generate_invoice refuses an Indian buyer with neither, so a box ticked then would only
 *     produce an error toast;
 *   · runs only when the payment really completed the quote (record_payment's is_fully_paid),
 *     whatever the box said before submit.
 */
import { stateCodeFromGstin } from "@/lib/gst/gstin-state";
import { invoiceHref } from "@/app/(app)/invoices/invoice-href";
import type { PaymentToast, PaymentToastAction } from "@/lib/payments/record-payment-toast";

/** The buyer's place-of-supply facts — the customer's row, else the lead's / the quote's. */
export interface BuyerPlace {
  state_code?: string | null;
  gstin?: string | null;
  country?: string | null;
}

/** True when generate_invoice can work out the place of supply for this buyer. */
export function buyerStateKnown(b: BuyerPlace | null | undefined): boolean {
  if (!b) return false;
  const country = (b.country ?? "").trim().toLowerCase();
  if (country && !["in", "ind", "india"].includes(country)) return true; // export: zero-rated
  return Boolean((b.state_code ?? "").trim() || stateCodeFromGstin(b.gstin));
}

/** Split billing = invoiced per period, so the quote path is refused. Null/yearly = one invoice. */
export function isSplitBilled(billingCycle: string | null | undefined): boolean {
  return Boolean(billingCycle) && billingCycle !== "yearly";
}

export interface InvoiceNowInput {
  /** Invoice already issued against the quote, if any. */
  invoiceId: string | null | undefined;
  billingCycle: string | null | undefined;
  buyer: BuyerPlace | null | undefined;
  /** Will this payment (with TDS / credit) bring the quote to its total? */
  completesQuote: boolean;
}

export interface InvoiceNowOffer {
  /** Show the checkbox at all. */
  offer: boolean;
  /** Its starting state. */
  defaultOn: boolean;
  /** One plain line under the checkbox when it starts unticked, else null. */
  hint: string | null;
}

export function invoiceNowOffer(i: InvoiceNowInput): InvoiceNowOffer {
  /* A part payment never issues it (generate_invoice is still on the quote page for an
     invoice-before-payment), so the box is not shown rather than shown and ignored. */
  if (i.invoiceId || isSplitBilled(i.billingCycle) || !i.completesQuote) {
    return { offer: false, defaultOn: false, hint: null };
  }
  const stateKnown = buyerStateKnown(i.buyer);
  if (!stateKnown) {
    return {
      offer: true,
      defaultOn: false,
      hint: "The customer has no state or GSTIN on record, so the invoice would be refused. Add the state first.",
    };
  }
  return { offer: true, defaultOn: true, hint: null };
}

/** After record_payment: should the sheet call generate_invoice now? */
export function shouldIssueAfterPayment(a: {
  ticked: boolean;
  offered: boolean;
  isFullyPaid: boolean;
  hasExistingInvoice: boolean;
  isReplay: boolean;
}): boolean {
  return a.ticked && a.offered && a.isFullyPaid && !a.hasExistingInvoice && !a.isReplay;
}

/**
 * The payment's one result toast, once the invoice WAS issued with it: the headline says so and
 * the button opens that invoice instead of offering "Generate invoice" for a quote that already
 * has one. Lines (TDS, credit, receipt) are kept as they are.
 */
export function withIssuedInvoice(
  t: PaymentToast,
  invoiceId: string,
): PaymentToast {
  /* The invoice's own page with the PDF open — built here with invoiceHref, the one place
     that knows the deep link (invoice-link.test.ts guards every "View invoice" label). */
  const href: NonNullable<PaymentToastAction["href"]> = `${invoiceHref(invoiceId)}?pdf=1`;
  const send = t.primary?.kind === "send-receipt" ? t.primary : t.secondary;
  return {
    ...t,
    title: `Paid in full · GST invoice ${invoiceId} issued`,
    primary: { kind: "view-invoice", label: "View invoice", href },
    secondary: send?.kind === "send-receipt" ? send : null,
  };
}
