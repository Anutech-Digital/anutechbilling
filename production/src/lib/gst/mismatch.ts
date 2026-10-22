/**
 * GST defects on an invoice that has already been issued.
 *
 * ─── WHAT THIS IS FOR ───────────────────────────────────────────────────────
 * Every other GST helper here DECIDES something at the moment an invoice is raised.
 * This one goes back over what was decided and asks whether it can be justified. Those are
 * different jobs: the first has to produce an answer, the second is allowed to say "this
 * was a guess".
 *
 * It CHANGES NOTHING. It returns findings. A tax head cannot be corrected by editing an
 * issued invoice anyway — that needs a credit note (CGST s.34) — so an auto-fix here would
 * be both wrong and unlawful.
 *
 * ─── THE FINDING THAT MOTIVATED IT, MEASURED ON THE LIVE BOOKS 22 AUG 2026 ──
 * Nine customers have no state_code and no usable GSTIN, and all their invoices were
 * issued as intra-state — CGST + SGST, Delhi:
 *
 *   Jijo corprotion 2,78,916 · KAILASH 2,13,840 · Pankaj 1,65,600 · abc corporaton 1,13,676
 *   Pardeep Sharma 1,13,676 · POP TECH 81,000 · Demo Co 56,400
 *   Joel 32,400 · ROHINI TECH 32,400          = Rs 10,87,908 taxable
 *
 * Nobody chose that. `isInterStateSupply` returns FALSE when the buyer's state is unknown,
 * and false means intra-state — so "we do not know" and "same state as us" produce an
 * identical, confident invoice. If any of those customers sits outside Delhi, the invoice
 * carries the wrong head: the customer cannot claim the credit, and the seller owes IGST
 * with interest.
 *
 * That is why place_of_supply_unknown is CRITICAL rather than a warning. It is not a
 * missing field. It is a tax decision made by a default.
 *
 * ─── AND WHY THERE IS NO AI IN HERE ─────────────────────────────────────────
 * Every check below is arithmetic or a comparison against a known list. A model would add
 * cost, latency and doubt to answers that are already certain — and on a GST notice,
 * "the model thought so" is not a defence.
 */
import { validateGstin } from "@/lib/utils";
import { stateCodeFromGstin, gstinContradictsState } from "./gstin-state";
import { isInterStateSupply, isExportSupply, treatmentIsAlwaysInterState } from "./place-of-supply";
import { SAAS_GST_RATE } from "./hsn";

export type GstIssueCode =
  /** The GSTIN on file is not a real GSTIN — wrong length, wrong shape, or bad checksum. */
  | "gstin_invalid"
  /** A valid GSTIN whose state disagrees with the state recorded against the customer. */
  | "gstin_contradicts_state"
  /** Neither a state nor a usable GSTIN — yet the invoice picked a tax head anyway. */
  | "place_of_supply_unknown"
  /** Both states known, and the head on the invoice disagrees with them. */
  | "wrong_head"
  /** An overseas customer charged domestic GST. */
  | "export_taxed_as_domestic"
  /** tax_amount is not the rate applied to taxable_value. */
  | "tax_arithmetic"
  /** A rate other than the 18% this business's SAC attracts. */
  | "unexpected_rate";

export interface GstIssue {
  code: GstIssueCode;
  /** critical = the tax head or the amount may be wrong. warning = worth a look. */
  severity: "critical" | "warning";
  /** One line, no jargon — this gets read by an owner, not an auditor. */
  headline: string;
  /** What actually follows from it, and the next step (§24). */
  detail: string;
  /**
   * The rupees this finding puts in question — normally the tax on the invoice, because a
   * wrong head puts the whole of it in question rather than a difference. Null when the
   * finding is about data quality and no specific amount is at stake.
   *
   * Present so a list of findings can be ordered by what it costs to be wrong, rather than
   * by how many there are. Nine small ones and one large one are not the same problem.
   */
  amountAtRisk: number | null;
}

export interface InvoiceGstFacts {
  taxableValue: number;
  taxAmount: number;
  taxRate: number;
  /** What the invoice actually claims: true = IGST, false = CGST + SGST. */
  interState: boolean;
  /** R-1736: the GST treatment frozen on the invoice (null = issued before R-1736). */
  gstTreatment?: string | null;
}

export interface PartyGstFacts {
  stateCode?: string | null;
  gstin?: string | null;
  country?: string | null;
  /** R-1736: customers.gst_treatment. */
  gstTreatment?: string | null;
}

/** Rounding slack, in rupees. GST is computed in whole rupees in this schema (§13). */
const TAX_TOLERANCE = 1;

/**
 * Every GST defect this invoice carries, worst first.
 *
 * Order is by severity then by money, so the first line of a list is the one that costs
 * most to ignore — not merely the first one found.
 */
export function auditInvoiceGst(
  invoice: InvoiceGstFacts,
  customer: PartyGstFacts,
  seller: PartyGstFacts,
): GstIssue[] {
  const issues: GstIssue[] = [];
  const tax = Math.max(0, Math.round(invoice.taxAmount ?? 0));

  // ── The GSTIN itself ──────────────────────────────────────────────────────
  const gstin = customer.gstin?.trim();
  if (gstin) {
    const verdict = validateGstin(gstin);
    if (!verdict.ok) {
      issues.push({
        code: "gstin_invalid",
        severity: "critical",
        headline: `The customer's GSTIN is not a valid GSTIN (${verdict.reason}).`,
        /* Named as a filing problem, not a typo, because that is what it becomes: GSTR-1
           is filed against the buyer's GSTIN, and a wrong one puts the supply on nobody's
           return. The customer then cannot claim the credit and comes back asking. */
        detail:
          `${verdict.message}. This number goes on the tax invoice and into GSTR-1, so the ` +
          `supply will not reach the buyer's 2B and they cannot claim the input credit. ` +
          `Get the correct GSTIN from the customer and re-check the invoices already issued.`,
        amountAtRisk: tax || null,
      });
    } else if (gstinContradictsState({ stateCode: customer.stateCode, gstin })) {
      const fromGstin = stateCodeFromGstin(gstin);
      issues.push({
        code: "gstin_contradicts_state",
        severity: "critical",
        headline: `The GSTIN says state ${fromGstin} but the customer is recorded in state ${customer.stateCode}.`,
        detail:
          `One of the two is wrong, and whichever it is has been deciding the tax head on ` +
          `real invoices. Confirm the customer's registered address and correct the record ` +
          `before issuing anything else.`,
        amountAtRisk: tax || null,
      });
    }
  }

  /* An export is a different regime, not a domestic supply with a different answer — so it
     takes the export check and NOTHING else. The first version ran the domestic rules on
     exports too, and a correctly zero-rated invoice to Singapore came back with two
     confident findings: "the place of supply was never established" (an export has no
     Indian place of supply to establish) and "the tax is not 18% of the taxable value"
     (zero-rated is the point). Both were nonsense, and nonsense on a tax screen is how the
     real findings stop being read. Caught by the test, not by re-reading the code. */
  if (isExportSupply(customer.country)) {
    if (tax > 0) {
      issues.push({
        code: "export_taxed_as_domestic",
        severity: "critical",
        headline: "An overseas customer has been charged Indian GST.",
        detail:
          "A supply to a recipient outside India is zero-rated when the seller has filed an " +
          "LUT. Check the LUT is on file and, if it is, this invoice needs a credit note.",
        amountAtRisk: tax || null,
      });
    }
    return sortIssues(issues);
  }

  {
    // ── The tax head, for domestic supplies only ────────────────────────────
    const buyerState = customer.stateCode?.trim() || stateCodeFromGstin(customer.gstin);
    const sellerState = seller.stateCode?.trim() || stateCodeFromGstin(seller.gstin);

    if (!buyerState) {
      /* THE BIG ONE. Not "a field is empty" — a tax decision taken by a default. */
      issues.push({
        code: "place_of_supply_unknown",
        severity: "critical",
        headline: "The place of supply was never established, and the invoice assumed one.",
        detail:
          `This customer has no state on record and no usable GSTIN, so there was nothing ` +
          `to compare against. The invoice was issued as ` +
          `${invoice.interState ? "inter-state (IGST)" : "intra-state (CGST + SGST)"} — not ` +
          `because that was determined, but because that is what the code returns when the ` +
          `buyer is unknown. If this customer is not in the same state as you, the head is ` +
          `wrong: they cannot claim the credit and you owe the other head with interest. ` +
          `Add the customer's state, then check every invoice already raised for them.`,
        amountAtRisk: tax || null,
      });
    } else if (sellerState) {
      /* R-1736: an SEZ invoice is IGST in any state — the treatment it was issued under
         (frozen), else today's customer treatment for an older invoice. */
      const treatment = invoice.gstTreatment ?? customer.gstTreatment;
      const sez = treatmentIsAlwaysInterState(treatment);
      const shouldBeInterState = isInterStateSupply(buyerState, sellerState, { treatment });
      if (shouldBeInterState !== invoice.interState) {
        issues.push({
          code: "wrong_head",
          severity: "critical",
          headline: sez
            ? "Charged as CGST + SGST, but the customer is an SEZ unit — a supply to an SEZ is always IGST."
            : shouldBeInterState
              ? "Charged as CGST + SGST, but the customer is in another state."
              : "Charged as IGST, but the customer is in the same state as you.",
          detail:
            `${sez ? "SEZ customer, " : ""}Buyer state ${buyerState}, seller state ${sellerState}: this should be ` +
            `${shouldBeInterState ? "IGST" : "CGST + SGST"}. The invoice says otherwise. ` +
            `The buyer cannot claim a credit under the wrong head, and the correct head is ` +
            `still owed — this needs a credit note and a fresh invoice.`,
          amountAtRisk: tax || null,
        });
      }
    }
  }

  // ── The arithmetic ────────────────────────────────────────────────────────
  const expected = Math.round((invoice.taxableValue * invoice.taxRate) / 100);
  if (Math.abs(tax - expected) > TAX_TOLERANCE) {
    issues.push({
      code: "tax_arithmetic",
      severity: "critical",
      headline: `The tax on this invoice is not ${invoice.taxRate}% of the taxable value.`,
      detail:
        `Taxable ${invoice.taxableValue} at ${invoice.taxRate}% is ${expected}, but the ` +
        `invoice charges ${tax}. One of the three numbers is wrong, and the invoice has ` +
        `already gone out.`,
      /* Here the risk IS the difference, not the whole tax — the head is fine, the sum is
         not. Reporting the full amount would overstate it beside a wrong-head finding. */
      amountAtRisk: Math.abs(tax - expected),
    });
  }

  if (invoice.taxRate !== SAAS_GST_RATE) {
    issues.push({
      code: "unexpected_rate",
      severity: "warning",
      headline: `Charged at ${invoice.taxRate}% where this business's services attract ${SAAS_GST_RATE}%.`,
      /* A warning, not critical: a tenant may legitimately sell something on another rate,
         and calling every such line an error is how a checker gets ignored. */
      detail:
        `SAC 998313 attracts ${SAAS_GST_RATE}%. If this line is something else, the rate may ` +
        `be right — confirm it. If not, the invoice is short or over by the difference.`,
      amountAtRisk: null,
    });
  }

  return sortIssues(issues);
}

/** Critical before warning, then bigger money first — so the top line is the costly one. */
function sortIssues(issues: GstIssue[]): GstIssue[] {
  return issues.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return (b.amountAtRisk ?? 0) - (a.amountAtRisk ?? 0);
  });
}

/** Roll a set of audited invoices into the one number that decides whether to act. */
export function summariseGstIssues(all: readonly GstIssue[][]): {
  invoicesWithIssues: number;
  criticalCount: number;
  totalAtRisk: number;
  byCode: Record<string, number>;
} {
  const byCode: Record<string, number> = {};
  let criticalCount = 0;
  let totalAtRisk = 0;
  let invoicesWithIssues = 0;

  for (const issues of all) {
    if (issues.length > 0) invoicesWithIssues += 1;
    /* Count each invoice's exposure ONCE, at its worst finding. Adding every issue's
       amountAtRisk would double-count the same rupees — an invoice with a bad GSTIN AND an
       unknown place of supply does not put its tax at risk twice, and a total that
       overstates itself is one nobody trusts the second time. */
    let worst = 0;
    for (const i of issues) {
      byCode[i.code] = (byCode[i.code] ?? 0) + 1;
      if (i.severity === "critical") criticalCount += 1;
      worst = Math.max(worst, i.amountAtRisk ?? 0);
    }
    totalAtRisk += worst;
  }

  return { invoicesWithIssues, criticalCount, totalAtRisk, byCode };
}
