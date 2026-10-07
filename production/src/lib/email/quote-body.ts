/**
 * The covering letter for a quotation — the letter a customer's accountant can act on.
 *
 * ─── HOW IT GOT HERE, IN TWO STEPS ──────────────────────────────────────────
 * **First**, 31 Aug 2026, Q-ADPL-2026-27-0068 as the customer received it:
 *
 *     25 × Google Workspace Business Starter — ₹8,125
 *     Subtotal ₹8,125 · GST 18% ₹1,463 · TOTAL ₹9,588
 *     Valid until 2026-09-07.
 *
 * Pardeep's reading was one sentence: "monthly quotation hai" — and the word *monthly* was
 * nowhere in it. ₹8,125 reads as a one-off, or a year. The PDF attached to that same mail said
 * "Rs 325/seat/mo · Commitment — None, cancel any month". The document and its covering letter
 * were describing the same money differently, which is a smaller version of the two defects
 * that have cost this project most: a monthly rate divided by twelve on a GST document, and a
 * flex plan printing a year nobody agreed to.
 *
 * **Then** he asked for it to be fuller and more professional, and he was right again: a B2B
 * quotation letter that omits the supplier's GSTIN, the date, the place of supply and the
 * CGST/SGST split is not a document anybody's accounts department can work from. They should
 * not have to open the PDF to learn who is selling, under what tax head, on what terms.
 *
 * ─── WHAT IS A FACT AND WHAT IS A PROMISE ───────────────────────────────────
 * The distinction this file is built around, and it is the same one the AI guards enforce.
 *
 * FACTS come from the quote row and the tenant row — seats, rate, tax, GSTIN, dates. They are
 * passed in and never recomputed here, because two places doing the same arithmetic is how an
 * email and its attachment come to differ by a rupee.
 *
 * COMMITMENTS — payment terms, a provisioning timeline, free migration — are `terms`, every
 * field optional, every one omitted when absent. "Free migration" is exactly the kind of line
 * this repo refuses to let a model invent; a template inventing it is no better. Today they
 * carry ANUTECH's own standing offer, and a second reseller's will differ.
 *
 * A pure function so it can be read in a test. This was a template literal buried inside
 * `sendAutoQuote`, reachable only by sending real mail — which is why it went months without
 * anybody noticing it never said "monthly".
 */
import { rupee, formatDate } from "@/lib/utils";
import { splitIntraStateTax } from "@/lib/gst/tax-split";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

/** The supplier's own particulars, as they must appear on a GST document. */
export interface SupplierIdentity {
  name: string;
  gstin?: string | null;
  address?: string | null;
  /** Where the supply is made from — the place of supply on an intra-state sale. */
  state?: string | null;
  email?: string | null;
  phone?: string | null;
}

/**
 * The tenant's standing commercial terms. Every field optional; anything absent is left out
 * of the letter rather than guessed at.
 */
export interface QuoteTerms {
  /** e.g. "100% in advance against our GST tax invoice". */
  payment?: string | null;
  /** e.g. "Accounts are provisioned within one working day of payment confirmation". */
  provisioning?: string | null;
  /** e.g. "Existing mail and data are migrated at no extra charge". */
  migration?: string | null;
  /** e.g. "Email and phone support on business days, 10:00–19:00 IST". */
  support?: string | null;
}

export interface QuoteBodyInput {
  quoteId: string;
  customerName: string | null;
  supplier: SupplierIdentity;
  lineItems: QuoteLineItem[];
  /** Quote-level invoice frequency. Null falls back to the line's own commitment. */
  billingCycle: string | null;
  /** All from the quote row — never recalculated here. */
  subtotal: number;
  discountPct: number;
  discount: number;
  taxRate: number;
  tax: number;
  total: number;
  /** Inter-state supply → one IGST line. Intra-state → CGST + SGST at half each. */
  interState: boolean;
  createdDate: string | null;
  expiresDate: string | null;
  terms?: QuoteTerms;
}

/** What one invoice covers, in words a customer reads. */
export function cycleUnitSuffix(cycle: string): string {
  switch (cycle) {
    case "monthly":     return "/month";
    case "quarterly":   return "/quarter";
    case "half_yearly": return "/half-year";
    default:            return "";
  }
}

/**
 * The app's OWN date format, not a second one.
 *
 * The email printed the raw `2026-09-07`. My first fix rolled its own formatter and produced
 * "07 Sep 2026" — which no other screen in this app shows. `formatDate` renders "7 Sept 2026",
 * and every screen and both PDFs already use it. A covering letter dated differently from the
 * document it covers is a smaller version of the problem this file exists to fix.
 *
 * Returns null rather than `formatDate`'s em dash, so an unusable date drops its whole line
 * instead of printing "Valid until —".
 */
export function indianDate(iso: string | null): string | null {
  if (!iso) return null;
  if (Number.isNaN(new Date(iso).getTime())) return null;
  return formatDate(iso);
}

/**
 * One `label   value` line, and the padding has a FLOOR of two spaces.
 *
 * `padEnd(16)` alone was a bug, and the letter showed it: the widest label in the document is
 * "PAYABLE EACH MONTH" at 18 characters, so `padEnd(16)` added nothing and the line came out
 * as `PAYABLE EACH MONTHRs 9,588/month` — the label welded to the total, on the one line a
 * customer actually reads. "Place of supply" at 15 was one space from the same fate.
 *
 * So 16 is the column the short labels align to, and two spaces is the minimum any label
 * gets. A long label breaks the column; it never breaks the sentence.
 */
const COLUMN = 16;
const row = (label: string, value: string): string =>
  `  ${label}${" ".repeat(Math.max(2, COLUMN - label.length))}${value}`;

export function quoteEmailBody(input: QuoteBodyInput): string {
  const first  = input.lineItems[0];
  const isFlex = first?.commitment === "monthly";
  const cycle  = (input.billingCycle ?? (isFlex ? "monthly" : "yearly")).toLowerCase();
  const unit   = cycleUnitSuffix(cycle);

  /* The flex tier's rate is per seat per MONTH; an annual line's is per seat per YEAR. That
     boundary is what `lib/quotes/commitment-rate.ts` documents and three SQL tests pin — and
     stating it wrongly here would put the same 12× error in the covering letter. */
  const perSeat = isFlex ? "per seat per month" : "per seat per year";

  const billingWords = isFlex
    ? "Monthly (flex) — no commitment, cancel or change seats any month"
    : `Annual commitment, ${cycle === "monthly" ? "billed monthly" : "billed yearly"}`;

  const totalLabel = cycle === "yearly" ? "TOTAL PAYABLE"
    : cycle === "monthly" ? "PAYABLE EACH MONTH" : "PAYABLE EACH PERIOD";

  const created = indianDate(input.createdDate);
  const valid   = indianDate(input.expiresDate);
  const seats   = input.lineItems.reduce((n, li) => n + li.qty, 0);
  const product = first?.name ?? "the requirement discussed";

  /* Subject-style opening line. An accounts department files on this. */
  const subjectLine = first
    ? `Sub:  Quotation for ${first.name} — ${seats} seat${seats === 1 ? "" : "s"}`
    : "Sub:  Quotation";

  /* GST heads, split the way the invoice will be raised. Half each and NOT recomputed from
     the rate: the halves must add back to the `tax` the row already committed to. R-212: the
     split is lib/gst/tax-split's — the same one the preview and the PDF print. */
  const intra = splitIntraStateTax(input.tax);
  const gstRows = input.interState
    ? [row(`IGST ${input.taxRate}%`, `${rupee(input.tax)}${unit}`)]
    : [
        row(`CGST ${input.taxRate / 2}%`, `${rupee(intra.cgst)}${unit}`),
        row(`SGST ${input.taxRate / 2}%`, `${rupee(intra.sgst)}${unit}`),
      ];

  const t = input.terms ?? {};
  /* padEnd, haath se ginе hue space nahi — pehli koshish me "Payment" ke baad ek extra
     space reh gaya tha aur column tedha dikh raha tha. */
  const term = (label: string, text: string) =>
    `  · ${label}${" ".repeat(Math.max(2, COLUMN - 2 - label.length))}${text}`;
  const termLines = [
    t.payment      ? term("Payment", t.payment) : null,
    t.provisioning ? term("Provisioning", t.provisioning) : null,
    t.migration    ? term("Migration", t.migration) : null,
    t.support      ? term("Support", t.support) : null,
    valid          ? term("Validity", `This quotation holds until ${valid}`) : null,
  ].filter((l): l is string => l !== null);

  const sig = [
    "Yours faithfully,",
    `For ${input.supplier.name}`,
    [input.supplier.gstin ? `GSTIN ${input.supplier.gstin}` : null,
     input.supplier.email,
     input.supplier.phone].filter(Boolean).join("  ·  "),
    input.supplier.address ?? null,
  ].filter((l): l is string => Boolean(l));

  return [
    `Dear ${input.customerName?.trim() || "Sir/Madam"},`,
    "",
    subjectLine,
    "",
    "Thank you for your enquiry. We are pleased to submit our quotation for the requirement",
    "below. The attached PDF is the formal document for your records; the particulars are set",
    "out here so that nothing needs to be opened to check them.",
    "",
    "QUOTATION",
    row("Quotation no.", input.quoteId),
    ...(created ? [row("Dated", created)] : []),
    ...(valid ? [row("Valid until", valid)] : []),
    row("Prepared for", input.customerName?.trim() || "—"),
    "",
    "SCOPE OF SUPPLY",
    row("Product", product),
    row("Seats", String(seats)),
    ...(first ? [row("Unit price", `${rupee(first.rate)} ${perSeat}`)] : []),
    row("Billing", billingWords),
    row("HSN / SAC", "998313 — software as a service"),
    ...(input.supplier.state
      ? [row("Place of supply", `${input.supplier.state} (${input.interState ? "inter-state" : "intra-state"})`)]
      : []),
    "",
    "COMMERCIALS",
    row("Taxable value", `${rupee(input.subtotal)}${unit}`),
    ...(input.discountPct > 0
      ? [row(`Discount ${input.discountPct}%`, `-${rupee(input.discount)}${unit}`)]
      : []),
    ...gstRows,
    `  ${"─".repeat(34)}`,
    row(totalLabel, `${rupee(input.total)}${unit}`),
    ...(termLines.length ? ["", "TERMS", ...termLines] : []),
    "",
    "NEXT STEPS",
    "  1. Reply confirming this quotation and we will raise the GST tax invoice.",
    "  2. On receipt of payment the accounts are provisioned and migration begins.",
    "",
    "Should anything need changing — the seat count, the plan, or the billing term — please",
    "reply to this email and we will issue a revised quotation.",
    "",
    "We look forward to working with you.",
    "",
    ...sig,
  ].join("\n");
}
