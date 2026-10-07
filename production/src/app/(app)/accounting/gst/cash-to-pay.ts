/**
 * R-394 (7 Oct 2026): the GST "cash to pay" figure, worked out ONCE.
 *
 * R-258 made the GST page headline the cash left after input credit is set off in the
 * s.49(5) / Rule 88A order (lib/gst/gstr3b.ts setOffItc → computeGstr3b().pay), less GST
 * already paid for those months. The Accounting Overview tile still showed the old
 * cumulative output − input, so the two screens disagreed. Both now read this file:
 *
 *   gstr3bFromReport  — the period's report rows → computeGstr3b (the 3B worksheet)
 *   gstCashHeadline   — 3B + GST paid → the headline: label, amount, hint, signed net
 *
 * Pure (no React, no Supabase) so the equality is testable: same rows in, same number out
 * on both screens. The data loader is ./report.ts.
 */
import type { ItcSplit } from "@/lib/gst/itc";
import { buildAdvances, docHeads, gstr3bClass, type Advance } from "@/lib/gst/gstr1";
import { computeGstr3b, type Gstr3b, type Heads } from "@/lib/gst/gstr3b";
import type { GstPeriod } from "@/lib/gst/periods";

export interface OutputRow {
  invoiceId:    string;
  invoiceDate:  string;
  customerName: string;
  customerGstin: string | null;
  customerStateCode: string | null;  // buyer's GST state code (place of supply)
  customerState:     string | null;
  /** Customer's country — outside India with no GSTIN = export (GSTR-1 EXP, 3B 3.1(b)). */
  customerCountry:   string | null;
  amount:       number;        // GST-inclusive
  taxableValue: number;        // persisted (migration 0116), else reverse-derived
  gst:          number;        // total GST (persisted, else reverse-derived)
  taxRate:      number;        // GST rate %
  interState:   boolean;       // true → IGST; false → CGST + SGST
  docType:      "invoice" | "credit_note" | "debit_note";  // credit/debit notes net the output tax
  /** R-335: a credit note issued after its invoice's GST s.34 limit (30 Nov after that FY). Warning only. */
  lateCreditNote?: boolean;
  /** Per-line HSN/SAC share of the taxable value (catalogue item's `hsn`). See lib/gst/gstr1.ts. */
  lines?:       { hsn: string; description?: string; taxable: number }[];
}
export interface InputRow {
  source:       "bill" | "expense";
  id:           string;
  date:         string;
  vendor:       string;
  vendorGstin:  string | null;
  taxableValue: number;        // pre-GST
  gst:          number;        // CGST + SGST + IGST or gst_paid
  igst:         number;        // ITC head split. Bill se naapa hua, ya (jab bill par na ho) maana hua — `assumed` batata hai kaun sa.
  /** `true` = ye batwara BILL se nahi aaya, maana gaya hai. Dekho lib/accounting/gst-heads.ts */
  assumed?:     boolean;
  /** Maana gaya ho to kyun — hover/worksheet me dikhane ke liye. */
  assumption?:  string | null;
  cgst:         number;
  sgst:         number;
  category:     string;
  /** Bill / invoice number as entered — the key GSTR-2B matching uses (lib/gst/gstr2b.ts). */
  billNo:       string | null;
}
export interface GstReport {
  outputRows:    OutputRow[];
  inputRows:     InputRow[];
  outputTotal:   number;
  outputGST:     number;
  inputTotal:    number;
  inputGST:      number;
  /** Expense GST that is NOT credit (kaccha bill, no vendor GSTIN, s.17(5)) — lib/gst/itc.ts. Not in inputRows. */
  blockedItc:    ItcSplit;
  /** The s.17(5) part of that, by head — reported gross in 3B 4(A)(5) and reversed in 4(B)(1). */
  blocked17Heads: Heads[];
  /** Imported services under reverse charge this period (expenses.rcm) — 3B 3.1(d) / 4(A)(3). */
  rcmRows:       { id: string; vendor: string; date: string; amount: number; tax: number }[];
  sellerStateCode: string | null;   // your own state — place of supply for intra-state B2C
  sellerState:     string | null;
  /** Company GSTIN from Settings — the Portal JSON is refused without it. */
  sellerGstin:     string | null;
  /** Receipt-voucher advances relevant to GSTR-1 Table 11A / 11B (lib/gst/gstr1.ts buildAdvances). */
  advances:        Advance[];
  /** R-335: credit notes in this period issued after their invoice's s.34 time limit. */
  lateCreditNotes: number;
}


// GSTR-1 sections (B2B / B2CL / B2CS / CDNR / CDNUR / HSN) — lib/gst/gstr1.ts.
// Notes are signed rows here, so the page totals net; the builder puts them in
// their own tables with positive values, the way the portal wants them.
export const toGstr1Doc = (r: OutputRow) => ({
  id: r.invoiceId, date: r.invoiceDate, docType: r.docType, customerName: r.customerName,
  customerGstin: r.customerGstin, customerStateCode: r.customerStateCode, customerState: r.customerState, customerCountry: r.customerCountry,
  amount: r.amount, taxableValue: r.taxableValue, gst: r.gst, taxRate: r.taxRate, interState: r.interState, lines: r.lines,
});

/** The period's GSTR-3B worksheet (RCM, s.17(5) reversal, set-off, cash per head) from its report rows. */
export function gstr3bFromReport(data: GstReport, range: Pick<GstPeriod, "from" | "to">): Gstr3b {
  const seller = { stateCode: data.sellerStateCode, state: data.sellerState };
  const adv = buildAdvances(data.advances, range, seller);
  return computeGstr3b({
    output: [
      ...data.outputRows.map((r) => {
        const d = toGstr1Doc(r);
        const c = gstr3bClass(d, seller);
        return { taxableValue: r.taxableValue, heads: docHeads(d), zeroRated: c.zeroRated, unregInterPos: c.unregInterPos };
      }),
      /* Tax on advances: 11A adds to 3.1(a), 11B takes it back out. */
      ...adv.at.map((a) => ({ taxableValue: a.advance, heads: a.heads })),
      ...adv.atadj.map((a) => ({ taxableValue: -a.advance, heads: { igst: -a.heads.igst, cgst: -a.heads.cgst, sgst: -a.heads.sgst } })),
    ],
    itc: data.inputRows.map((r) => ({ igst: r.igst, cgst: r.cgst, sgst: r.sgst })),
    blocked17: data.blocked17Heads,
    notIn2b: data.blockedItc.blocked - data.blocked17Heads.reduce((s, h) => s + h.igst + h.cgst + h.sgst, 0),
    rcm: data.rcmRows,
  });
}

export type GstCashState = "to_pay" | "still_to_pay" | "credit" | "overpaid" | "nil";

export interface GstCashHeadline {
  state: GstCashState;
  /** Headline label — the GST page card and the Overview tile print this same text. */
  label: string;
  /** The big number, unsigned: cash left to pay, the credit carried forward, or the excess paid. */
  amount: number;
  /** Cash due after input credit is set off (all heads, incl. reverse charge), before GST paid. */
  cash: number;
  /** GST already paid for these months (tax_payments, by return month). */
  paid: number;
  /** cash − paid. Positive = still to pay; negative = paid more than due. */
  left: number;
  /** Unused input credit carried forward to next month, all heads. */
  carryForward: number;
  /** One line under the number. */
  hint: string;
  /** Signed for the money inbox: + payable, − credit / excess (lib/accounting/money-inbox gstFolderState). */
  net: number;
}

/**
 * The GST headline for a period. `g3b` null (no data yet) reads as nothing to pay.
 * Same rules the GST page always used (R-258): a month whose only story is unused credit
 * shows that credit, carried forward, instead of a bare ₹0.
 */
export function gstCashHeadline(g3b: Gstr3b | null, paid: number): GstCashHeadline {
  const cash = g3b ? g3b.pay.igst + g3b.pay.cgst + g3b.pay.sgst : 0;
  const so = g3b?.setOff;
  const carryForward = so ? so.carryForward.igst + so.carryForward.cgst + so.carryForward.sgst : 0;
  const left = cash - paid;
  const state: GstCashState =
    left < 0 ? "overpaid"
    : left > 0 ? (paid > 0 ? "still_to_pay" : "to_pay")
    : paid === 0 && carryForward > 0 ? "credit"
    : "nil";
  const label = {
    to_pay: "GST cash to pay",
    still_to_pay: "GST still to pay",
    credit: "GST credit",
    overpaid: "GST paid more than due",
    nil: "GST cash to pay",
  }[state];
  const hint = {
    to_pay: "Payable in cash via GSTR-3B, after input credit is used",
    still_to_pay: "Payable in cash via GSTR-3B, after input credit is used",
    credit: "Unused input credit, carried forward to next month",
    overpaid: "Paid more than the cash due",
    nil: "Nothing to pay in cash",
  }[state];
  const amount = state === "credit" ? carryForward : Math.abs(left);
  const net = state === "credit" ? -carryForward : left;
  return { state, label, amount, cash, paid, left, carryForward, hint, net };
}
