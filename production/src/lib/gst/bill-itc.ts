/**
 * R-1576 (18 Oct 2026) — input tax credit (ITC) on a VENDOR BILL: can its GST be claimed,
 * and if not, why.
 *
 * Before: every vendor bill's cgst + sgst + igst went straight into Input GST — the GST page
 * (accounting/gst/report.ts), GSTR-3B 4(A)(5), the Balance Sheet's GST payable
 * (report_balance_sheet.bills_gst) and the P&L's input GST (report_pnl.bills_gst). Expenses
 * already passed through itcEligibility() (lib/gst/itc.ts); bills did not, so a PROFORMA
 * (a request for payment, not a tax invoice) or a bill with no vendor GSTIN still cut the
 * GST payable — and that GST was never a cost either, so profit was overstated too.
 *
 * Rule (CGST Act s.16(2), s.17(5)) — a bill's GST is credit only when ALL hold:
 *   1. the document is a TAX INVOICE (not a proforma, not a bill of supply, not "other");
 *   2. the vendor has a valid GSTIN (else it can never show in GSTR-2B);
 *   3. the tax head fits the states: a vendor in ANOTHER state charging CGST+SGST is that
 *      state's tax — not creditable here; a vendor in OUR state charging only IGST is the
 *      wrong head (unless the vendor is in an SEZ — then the CA decides);
 *   4. the category is not blocked under s.17(5) — the same list expenses use.
 * GST that fails stays a cost: P&L COGS (with the subtotal), not Input GST.
 *
 * Old bills (saved before document_type existed, NULL): a tax invoice when the bill has a
 * vendor GSTIN, otherwise "other". The migration does NOT rewrite old rows — the guess is
 * made here, the same way everywhere, and a bill re-saved with an explicit type wins.
 *
 * Pure: the GST page, P&L, Balance Sheet, month close and the Add Bill dialog share it.
 */
import { itcEligibility, isGstin, type ItcVerdict, type ItcSplit } from "@/lib/gst/itc";

export const BILL_DOCUMENT_TYPES = ["tax_invoice", "proforma", "bill_of_supply", "other"] as const;
export type BillDocumentType = (typeof BILL_DOCUMENT_TYPES)[number];

export const BILL_DOCUMENT_TYPE_LABEL: Readonly<Record<BillDocumentType, string>> = {
  tax_invoice:    "Tax invoice",
  proforma:       "Proforma invoice",
  bill_of_supply: "Bill of supply",
  other:          "Other / receipt",
};

export function isBillDocumentType(v: unknown): v is BillDocumentType {
  return typeof v === "string" && (BILL_DOCUMENT_TYPES as readonly string[]).includes(v);
}

export interface BillItcInput {
  /** vendor_bills.document_type — NULL on bills saved before R-1576. */
  document_type: string | null | undefined;
  vendor_gstin: string | null | undefined;
  category: string | null | undefined;
  cgst: number | null | undefined;
  sgst: number | null | undefined;
  igst: number | null | undefined;
  /** Our own state code ("07"), from the tenant. Unknown → the state check is skipped. */
  ownStateCode?: string | null;
  /** How many real bills this row stands for (SQL groups them). Default 1. */
  n?: number;
}

/** The document type a bill counts as. NULL (old row) → tax invoice only if it has a GSTIN. */
export function effectiveBillDocType(documentType: string | null | undefined, vendorGstin: string | null | undefined): BillDocumentType {
  if (isBillDocumentType(documentType)) return documentType;
  return isGstin(vendorGstin) ? "tax_invoice" : "other";
}

const DOC_REASON: Readonly<Record<Exclude<BillDocumentType, "tax_invoice">, string>> = {
  proforma:       "Proforma hai, tax invoice nahi — credit nahi; vendor se asli tax invoice maango",
  bill_of_supply: "Bill of supply — vendor GST nahi le sakta, credit nahi",
  other:          "GST tax invoice nahi — credit nahi",
};

const gstOf = (b: Pick<BillItcInput, "cgst" | "sgst" | "igst">) =>
  Math.max(0, Math.round(b.cgst ?? 0)) + Math.max(0, Math.round(b.sgst ?? 0)) + Math.max(0, Math.round(b.igst ?? 0));

export function billItcEligibility(b: BillItcInput): ItcVerdict {
  const gst = gstOf(b);
  if (gst <= 0) return { eligible: false, reason: null };
  const doc = effectiveBillDocType(b.document_type, b.vendor_gstin);
  if (doc !== "tax_invoice") return { eligible: false, reason: DOC_REASON[doc] };
  if (!isGstin(b.vendor_gstin)) return { eligible: false, reason: "Vendor ka GSTIN nahi — GSTR-2B mein match nahi hoga" };

  const own = (b.ownStateCode ?? "").trim();
  if (/^\d{2}$/.test(own)) {
    const vendorState = (b.vendor_gstin ?? "").trim().slice(0, 2);
    const local = Math.max(0, b.cgst ?? 0) + Math.max(0, b.sgst ?? 0);
    const inter = Math.max(0, b.igst ?? 0);
    if (vendorState !== own && local > 0) {
      return { eligible: false, reason: `Vendor doosre rajya (${vendorState}) ka hai aur CGST+SGST lagaya — wo us rajya ka tax hai, yahan credit nahi` };
    }
    if (vendorState === own && inter > 0 && local === 0) {
      return { eligible: false, reason: "Vendor aur hum ek hi rajya mein, phir bhi IGST lagaya — galat head; vendor se sahi invoice maango (SEZ vendor ho to CA se poochho)" };
    }
  }

  /* Tax invoice + GSTIN + right head → the SAME s.17(5) check expenses use. */
  return itcEligibility({ gst_paid: gst, bill_type: "gst", category: b.category, vendorGstin: b.vendor_gstin });
}

/** Split bills' GST into claimable credit and cost, by reason. Whole rupees. */
export function splitBillItc(rows: BillItcInput[]): ItcSplit {
  let eligible = 0, blocked = 0;
  const by = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    const g = gstOf(r);
    if (g === 0) continue;
    const v = billItcEligibility(r);
    if (v.eligible) { eligible += g; continue; }
    blocked += g;
    const k = v.reason ?? "—";
    const cur = by.get(k) ?? { amount: 0, count: 0 };
    cur.amount += g; cur.count += r.n ?? 1;
    by.set(k, cur);
  }
  return {
    eligible, blocked,
    blockedByReason: [...by.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.amount - a.amount),
  };
}

/** Expense split + bill split, one list (the GST page's "Blocked ITC" card). */
export function mergeItcSplits(a: ItcSplit, b: ItcSplit): ItcSplit {
  const by = new Map<string, { amount: number; count: number }>();
  for (const r of [...a.blockedByReason, ...b.blockedByReason]) {
    const cur = by.get(r.reason) ?? { amount: 0, count: 0 };
    cur.amount += r.amount; cur.count += r.count;
    by.set(r.reason, cur);
  }
  return {
    eligible: a.eligible + b.eligible,
    blocked: a.blocked + b.blocked,
    blockedByReason: [...by.entries()].map(([reason, v]) => ({ reason, ...v })).sort((x, y) => y.amount - x.amount),
  };
}

/**
 * One row of `bill_itc_groups` (report_pnl / report_balance_sheet, migration R-1576):
 * bills grouped by (document_type, category, vendor GSTIN, heads). `cogs` = category COGS-*.
 */
export interface BillItcGroup {
  document_type: string | null;
  category: string | null;
  vendorGstin: string | null;
  cgst: number;
  sgst: number;
  igst: number;
  n: number;
  ownStateCode: string | null;
}

export function splitBillGroups(groups: BillItcGroup[]): ItcSplit {
  return splitBillItc(groups.map((g) => ({
    document_type: g.document_type, vendor_gstin: g.vendorGstin, category: g.category,
    cgst: g.cgst, sgst: g.sgst, igst: g.igst, ownStateCode: g.ownStateCode, n: g.n,
  })));
}
