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
      ...adv.at.map((a) => ({ taxableValue: a.advance, heads: a.heads, advance: "11A" as const })),
      ...adv.atadj.map((a) => ({ taxableValue: -a.advance, heads: { igst: -a.heads.igst, cgst: -a.heads.cgst, sgst: -a.heads.sgst }, advance: "11B" as const })),
    ],
    itc: data.inputRows.map((r) => ({ igst: r.igst, cgst: r.cgst, sgst: r.sgst })),
    blocked17: data.blocked17Heads,
    notIn2b: data.blockedItc.blocked - data.blocked17Heads.reduce((s, h) => s + h.igst + h.cgst + h.sgst, 0),
    rcm: data.rcmRows,
  });
}

/* ── R-521 (9 Oct 2026): where the 3B output tax comes from ────────────────────────────
 *
 * October 2026 on ANUTECH: the Output GST card said ₹1,11,073 (12 invoices = the GSTR-1
 * rows) while the 3B worksheet and the head-wise set-off said ₹1,12,930 — ₹1,857 tax on
 * ₹10,320 taxable with no name anywhere. It was three receipt vouchers received in October
 * on quotes not yet invoiced: tax on advances, GSTR-1 Table 11A, which GSTR-3B 3.1(a)
 * rightly includes. Nothing was wrong in the sum; the page just hid one of its parts.
 *
 * This bridge is the ONE place the parts are listed: invoices, credit notes, debit notes,
 * advances received (11A, +) and advances adjusted (11B, −). Its total is checked against
 * the 3B figures computed from the same report, so a future difference shows up as a
 * mismatch on the page instead of an unexplained number.
 */
export interface BridgeItem { ref: string; date: string; gross: number; taxable: number; tax: number }
export interface BridgeLine {
  key: "invoices" | "credit_notes" | "debit_notes" | "advances_11a" | "advances_11b";
  label: string;
  /** Where the figure is reported. */
  source: string;
  count: number;
  /** Signed: credit notes and 11B are negative. */
  taxable: number;
  heads: Heads;
  tax: number;
  /** Advance lines: one entry per receipt voucher (signed like the line). */
  items?: BridgeItem[];
}
export interface OutputTaxBridge {
  lines: BridgeLine[];
  /** The Output GST card (invoices + notes) — the GSTR-1 document rows. */
  card: { taxable: number; tax: number };
  /** card + 11A − 11B. */
  total: { taxable: number; heads: Heads; tax: number };
  /** The same figure as GSTR-3B reports it: 3.1(a) + 3.1(b) (taxable; tax incl. IGST on exports with payment). */
  gstr3b: { taxable: number; heads: Heads; tax: number };
  /** total − 3B tax. 0 when every rupee is accounted for. */
  difference: number;
}

const ZH: Heads = { igst: 0, cgst: 0, sgst: 0 };
const addH = (a: Heads, b: Heads): Heads => ({ igst: a.igst + b.igst, cgst: a.cgst + b.cgst, sgst: a.sgst + b.sgst });
const negH = (a: Heads): Heads => ({ igst: -a.igst, cgst: -a.cgst, sgst: -a.sgst });
const sumH = (h: Heads) => h.igst + h.cgst + h.sgst;

export function outputTaxBridge(data: GstReport, range: Pick<GstPeriod, "from" | "to">, g3b: Gstr3b): OutputTaxBridge {
  const seller = { stateCode: data.sellerStateCode, state: data.sellerState };
  const docLine = (key: "invoices" | "credit_notes" | "debit_notes", docType: OutputRow["docType"], label: string, source: string): BridgeLine => {
    const rows = data.outputRows.filter((r) => r.docType === docType);
    const heads = rows.reduce((h, r) => addH(h, docHeads(toGstr1Doc(r))), ZH);
    return { key, label, source, count: rows.length, taxable: rows.reduce((s, r) => s + r.taxableValue, 0), heads, tax: rows.reduce((s, r) => s + r.gst, 0) };
  };

  /* Each advance through buildAdvances on its own — the exact rule (period, export, place of
     supply, rounding) the 3B rows and the GSTR-1 11A/11B export use; per-voucher rounding
     adds up to the aggregate because buildAdvances also rounds per voucher. */
  const a11: BridgeItem[] = [], b11: BridgeItem[] = [];
  let aHeads = ZH, bHeads = ZH;
  for (const a of data.advances) {
    const t = buildAdvances([a], range, seller);
    const ref = a.voucherNo ?? `payment ${a.paymentId.slice(0, 8)}`;
    for (const r of t.at) { a11.push({ ref, date: a.receivedDate, gross: a.gross, taxable: r.advance, tax: sumH(r.heads) }); aHeads = addH(aHeads, r.heads); }
    for (const r of t.atadj) { b11.push({ ref, date: a.adjustedOn ?? a.receivedDate, gross: -a.gross, taxable: -r.advance, tax: -sumH(r.heads) }); bHeads = addH(bHeads, negH(r.heads)); }
  }

  const lines: BridgeLine[] = [
    docLine("invoices", "invoice", "Sales invoices", "GSTR-1 B2B / B2CL / B2CS / EXP"),
    docLine("credit_notes", "credit_note", "Credit notes (reduce tax)", "GSTR-1 CDNR / CDNUR"),
    docLine("debit_notes", "debit_note", "Debit notes (add tax)", "GSTR-1 CDNR / CDNUR"),
    { key: "advances_11a", label: "Tax on advances received, not yet invoiced", source: "GSTR-1 Table 11A", count: a11.length,
      taxable: a11.reduce((s, x) => s + x.taxable, 0), heads: aHeads, tax: a11.reduce((s, x) => s + x.tax, 0), items: a11 },
    { key: "advances_11b", label: "Less: earlier advances adjusted on this period's invoices", source: "GSTR-1 Table 11B", count: b11.length,
      taxable: b11.reduce((s, x) => s + x.taxable, 0), heads: bHeads, tax: b11.reduce((s, x) => s + x.tax, 0), items: b11 },
  ];
  const card = { taxable: data.outputTotal, tax: data.outputGST };
  const totalHeads = lines.reduce((h, l) => addH(h, l.heads), ZH);
  const total = { taxable: lines.reduce((s, l) => s + l.taxable, 0), heads: totalHeads, tax: lines.reduce((s, l) => s + l.tax, 0) };
  const g3Heads = addH(g3b.out, { igst: g3b.zeroIgst, cgst: 0, sgst: 0 });
  const gstr3b = { taxable: g3b.outTaxable + g3b.zeroTaxable, heads: g3Heads, tax: sumH(g3Heads) };
  return { lines, card, total, gstr3b, difference: total.tax - gstr3b.tax };
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
