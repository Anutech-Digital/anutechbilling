/**
 * ReceiptVoucherPDF — GST advance Receipt Voucher (CGST Section 31(3)(d)).
 *
 * Issued when a customer pays in advance (before the supply / invoice).
 * Per CGST Section 13(2), time of supply for services is the earlier of
 * invoice or payment, so GST is recognized at receipt — hence the
 * Receipt Voucher is a formal tax document (separate from but adjusted
 * against the eventual Tax Invoice).
 *
 * Mirrors ReceiptVoucherDialog. Differences from Quote/Invoice PDFs:
 *   • Single-line breakdown (no multi-line product table) — one advance amount
 *   • GST is REVERSE-CALCULATED from gross payment.amount (taxable + tax = received)
 *   • "Amount in words" line (Indian lakh/crore format) — common GST requirement
 *   • Two signature blocks at the bottom (customer + supplier)
 */
import {
  Document,
  Page,
  View,
  Text,
  Image,
  StyleSheet,
} from "@react-pdf/renderer";
import { formatDate } from "@/lib/utils";
import { pdfRupee, pdfSafeMoney } from "./pdf-money";
import { pdfText } from "./pdf-text";
import { isRenderableLogo } from "./logo";
import type { Payment } from "@/lib/supabase/database.types";

import { PDF_FONT, PDF_FONT_BOLD, registerPdfFonts } from "./fonts";
import { splitIntraStateTax } from "@/lib/gst/tax-split";

/* Styles ke BANNE se pehle. `StyleSheet.create` ab hi chal jata hai, aur `PDF_FONT`
   ek `let` hai — baad me register karne par style purani value pakde rehti. */
registerPdfFonts();

// ─── Props ────────────────────────────────────────────────────────────────

export interface ReceiptVoucherPDFProps {
  payment:      Payment;

  // Tenant (supplier)
  tenantName:    string;
  tenantGstin?:  string | null;
  tenantEmail?:  string | null;
  tenantPhone?:  string | null;
  tenantAddress?: string | null;
  tenantState?:   string | null;
  /**
   * The company logo as a resolved `data:image/...` URI, from `logoDataUri()`.
   *
   * Never a URL — see the header of lib/pdf/logo.ts. `isRenderableLogo` refuses anything
   * else, so a caller that passes the stored URL gets a document with no logo rather than a
   * render-time network fetch.
   */
  tenantLogo?:    string | null;

  // Customer (recipient)
  customerName:    string;
  customerGstin?:   string | null;
  customerEmail?:   string | null;
  customerAddress?: string | null;

  // Tax context
  interState?: boolean;
  gstRate?:    number;  // default 18% for SaaS

  // Origin context
  quoteId?: string;

  /** R-523: "Received ₹A + TDS ₹B = ₹C" when the customer deducted TDS (receiptSplitLine). */
  splitLine?: string | null;
}

// ─── Styles ───────────────────────────────────────────────────────────────

const COLORS = {
  ink:    "#1A1A1A",
  ink2:   "#3A3A3A",
  ink3:   "#7A7A7A",
  paper:  "#FFFFFF",
  amber:  "#C2410C",
  amberSoft: "#FFFBEB",
  amberInk:  "#92400E",
  hairline: "#E4E4E4",
};

const s = StyleSheet.create({
  page: {
    paddingHorizontal: 40,
    paddingVertical:   36,
    fontFamily:        PDF_FONT,
    fontSize:          10,
    color:             COLORS.ink,
    backgroundColor:   COLORS.paper,
  },

  // Title
  titleBar: { textAlign: "center", marginBottom: 14 },
  brandLogo: {
    /* Centred above the title, letterhead-style. Height fixed, width free, so a wide
       wordmark stays wide. The party blocks below carry the legal supplier identity — the
       logo is decoration and must never displace them. */
    height:       32,
    maxWidth:     170,
    objectFit:    "contain",
    alignSelf:    "center",
    marginBottom: 8,
  },
  titleEyebrow: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    PDF_FONT_BOLD,
    textTransform: "uppercase",
  },
  titleMain: {
    fontFamily: PDF_FONT_BOLD,
    fontSize:   22,
    marginTop:  2,
  },
  titleId: {
    fontFamily: "Courier",
    fontSize:   12,
    color:      COLORS.ink2,
    marginTop:  2,
  },

  // Parties block (mirrors invoice)
  partiesBlock: {
    flexDirection:   "row",
    borderTopWidth:  2,
    borderBottomWidth: 2,
    borderColor:     COLORS.ink,
    paddingVertical: 12,
    marginBottom:    14,
  },
  party:   { flex: 1, paddingHorizontal: 4 },
  partyR:  { flex: 1, paddingHorizontal: 4, alignItems: "flex-end" },
  partyLabel: {
    fontSize:      8,
    letterSpacing: 1.5,
    color:         COLORS.ink3,
    fontFamily:    PDF_FONT_BOLD,
    textTransform: "uppercase",
    marginBottom:  4,
  },
  partyName: {
    fontFamily: PDF_FONT_BOLD,
    fontSize:   13,
    color:      COLORS.ink,
  },
  partyGstin: {
    fontFamily: "Courier",
    fontSize:   9,
    color:      COLORS.ink2,
    marginTop:  2,
  },
  partyMeta: {
    fontSize: 9,
    color:    COLORS.ink3,
    marginTop: 2,
  },

  // Meta row — 3-col grid
  metaRow: {
    flexDirection:  "row",
    flexWrap:       "wrap",
    marginBottom:   14,
  },
  metaCell:  { width: "33.3%", paddingRight: 6, marginBottom: 6 },
  metaLabel: {
    fontSize:      8,
    letterSpacing: 1.2,
    color:         COLORS.ink3,
    fontFamily:    PDF_FONT_BOLD,
    textTransform: "uppercase",
    marginBottom:  2,
  },
  metaValue: { fontSize: 10, color: COLORS.ink },
  metaMono:  { fontFamily: "Courier", fontSize: 10 },

  // Breakdown table
  table: {
    borderWidth: 1.5,
    borderColor: COLORS.ink,
    marginBottom: 12,
  },
  tableHeader: {
    flexDirection:    "row",
    backgroundColor:  "#F5F5F5",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.ink,
    paddingVertical:  8,
    paddingHorizontal: 10,
  },
  tableRow: {
    flexDirection:    "row",
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    paddingVertical:  10,
    paddingHorizontal: 10,
  },
  totalRow: {
    flexDirection:    "row",
    backgroundColor:  "#F5F5F5",
    paddingVertical:  10,
    paddingHorizontal: 10,
  },
  thDesc: { flex: 1, fontFamily: PDF_FONT_BOLD, fontSize: 9, textTransform: "uppercase", letterSpacing: 1 },
  thAmt:  { width: 110, fontFamily: PDF_FONT_BOLD, fontSize: 9, textTransform: "uppercase", letterSpacing: 1, textAlign: "right" },
  tdDesc: { flex: 1 },
  tdAmt:  { width: 110, fontSize: 10, textAlign: "right", fontFamily: PDF_FONT_BOLD },

  lineName: { fontFamily: PDF_FONT_BOLD, fontSize: 10 },
  lineMeta: { fontSize: 9, color: COLORS.ink3, marginTop: 2 },

  taxLine: { fontSize: 10, color: COLORS.ink2 },

  totalLabel: {
    fontFamily:    PDF_FONT_BOLD,
    fontSize:      9,
    letterSpacing: 1.2,
    textTransform: "uppercase",
  },
  totalAmount: { fontFamily: PDF_FONT_BOLD, fontSize: 18 },

  // Amount in words
  inWords: {
    fontSize:    10,
    color:       COLORS.ink3,
    marginBottom: 12,
    lineHeight:  1.4,
  },
  inWordsLabel: {
    fontFamily: PDF_FONT_BOLD,
    color:      COLORS.ink2,
  },

  // GST notice
  gstNotice: {
    backgroundColor: COLORS.amberSoft,
    borderWidth:     1,
    borderColor:     "#FCD34D",
    borderRadius:    4,
    padding:         10,
    marginBottom:    14,
  },
  gstNoticeTitle: {
    fontSize:      9,
    fontFamily:    PDF_FONT_BOLD,
    color:         COLORS.amberInk,
    marginBottom:  4,
  },
  gstNoticeBody: {
    fontSize:    9,
    color:       COLORS.amberInk,
    lineHeight:  1.5,
  },

  // Notes
  notesBlock: {
    marginBottom: 14,
  },
  notesText: {
    fontSize:   10,
    color:      COLORS.ink2,
    marginTop:  4,
    lineHeight: 1.4,
  },

  // Signature
  signatures: {
    flexDirection:  "row",
    justifyContent: "space-between",
    marginTop:      30,
    paddingTop:     14,
    borderTopWidth: 1,
    borderTopColor: COLORS.hairline,
  },
  sigBlock: { width: "45%" },
  sigBlockR: { width: "45%", alignItems: "flex-end" },
  sigLabel: {
    fontSize:      8,
    letterSpacing: 1.2,
    color:         COLORS.ink3,
    fontFamily:    PDF_FONT_BOLD,
    textTransform: "uppercase",
    marginBottom:  30,
  },
  sigLine: {
    height:          1,
    backgroundColor: COLORS.ink,
    width:           120,
  },
  sigAuth: {
    fontSize:  9,
    color:     COLORS.ink3,
    marginTop: 4,
  },

  // Footer
  footer: {
    textAlign:  "center",
    fontSize:   8,
    color:      COLORS.ink3,
    marginTop:  20,
  },
});

// ─── Document ─────────────────────────────────────────────────────────────

export function ReceiptVoucherPDF(props: ReceiptVoucherPDFProps) {
  const {
    payment,
    tenantName, tenantGstin, tenantEmail, tenantPhone, tenantAddress, tenantState, tenantLogo,
    customerName, customerGstin, customerEmail, customerAddress,
    interState = false,
    gstRate = 18,
    quoteId,
    splitLine,
  } = props;

  // GST reverse-out from gross amount (Indian standard)
  const taxable  = Math.round((payment.amount * 100) / (100 + gstRate));
  const totalTax = payment.amount - taxable;
  /* R-046: the same shared split the invoice and GSTR-1 use. A receipt voucher is a GST
     document too (CGST 31(3)(d)), so its heads must be derived the same way. */
  const { cgst, sgst } = splitIntraStateTax(totalTax);
  const igst     = totalTax;

  const placeOfSupply = interState
    ? "Inter-state (IGST)"
    : tenantState
      ? `Intra-state, ${tenantState} (CGST + SGST)`
      : "Intra-state (CGST + SGST)";

  return (
    <Document
      title={`Receipt Voucher ${payment.receipt_voucher_no ?? payment.id}`}
      author={tenantName}
      subject={`Receipt Voucher for advance received from ${customerName}`}
    >
      <Page size="A4" style={s.page}>

        {/* ── Title ───────────────────────────────────────────────── */}
        <View style={s.titleBar}>
          {isRenderableLogo(tenantLogo) && <Image src={tenantLogo} style={s.brandLogo} />}
          <Text style={s.titleEyebrow}>GST-compliant advance receipt</Text>
          <Text style={s.titleMain}>Receipt Voucher</Text>
          <Text style={s.titleId}>{payment.receipt_voucher_no ?? "(not numbered)"}</Text>
        </View>

        {/* ── Parties ─────────────────────────────────────────────── */}
        <View style={s.partiesBlock}>
          <View style={s.party}>
            <Text style={s.partyLabel}>From (Supplier)</Text>
            <Text style={s.partyName}>{pdfText(tenantName)}</Text>
            {tenantGstin   && <Text style={s.partyGstin}>GSTIN: {tenantGstin}</Text>}
            {tenantAddress && <Text style={s.partyMeta}>{pdfText(tenantAddress)}</Text>}
            {tenantEmail   && <Text style={[s.partyMeta, { fontFamily: "Courier" }]}>{tenantEmail}</Text>}
            {tenantPhone   && <Text style={[s.partyMeta, { fontFamily: "Courier" }]}>{tenantPhone}</Text>}
          </View>
          <View style={s.partyR}>
            <Text style={s.partyLabel}>To (Recipient)</Text>
            <Text style={s.partyName}>{pdfText(customerName)}</Text>
            {customerGstin   && <Text style={s.partyGstin}>GSTIN: {customerGstin}</Text>}
            {customerAddress && <Text style={s.partyMeta}>{pdfText(customerAddress)}</Text>}
            {customerEmail   && <Text style={[s.partyMeta, { fontFamily: "Courier" }]}>{customerEmail}</Text>}
          </View>
        </View>

        {/* ── Meta row ────────────────────────────────────────────── */}
        <View style={s.metaRow}>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Voucher No.</Text>
            <Text style={[s.metaValue, s.metaMono]}>{payment.receipt_voucher_no ?? "—"}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Date received</Text>
            <Text style={s.metaValue}>{formatDate(payment.received_at)}</Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Payment method</Text>
            <Text style={[s.metaValue, { textTransform: "capitalize" }]}>
              {payment.method.replace("_", " ")}
            </Text>
          </View>
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Transaction ref.</Text>
            <Text style={[s.metaValue, s.metaMono, { fontSize: 9 }]}>
              {payment.reference ?? "—"}
            </Text>
          </View>
          {quoteId && (
            <View style={s.metaCell}>
              <Text style={s.metaLabel}>Against quote</Text>
              <Text style={[s.metaValue, s.metaMono, { fontSize: 9 }]}>{quoteId}</Text>
            </View>
          )}
          <View style={s.metaCell}>
            <Text style={s.metaLabel}>Place of supply</Text>
            <Text style={s.metaValue}>{placeOfSupply}</Text>
          </View>
        </View>

        {/* ── Breakdown ───────────────────────────────────────────── */}
        <View style={s.table}>
          <View style={s.tableHeader}>
            <Text style={s.thDesc}>Description</Text>
            {/* "Rs", not the sign: this header is drawn by the same font as the figures
                below it, and that font has no rupee glyph — see lib/pdf/pdf-money.ts. */}
            <Text style={s.thAmt}>Amount (Rs)</Text>
          </View>

          <View style={s.tableRow}>
            <View style={s.tdDesc}>
              <Text style={s.lineName}>
                Advance received against {quoteId ? `quote ${quoteId}` : "service"}
              </Text>
              <Text style={s.lineMeta}>HSN/SAC: 998313 · Reseller services</Text>
            </View>
            <Text style={s.tdAmt}>{pdfRupee(taxable)}</Text>
          </View>

          {interState ? (
            <View style={s.tableRow}>
              <Text style={[s.tdDesc, s.taxLine]}>IGST @ {gstRate}%</Text>
              <Text style={[s.tdAmt, { fontFamily: PDF_FONT }]}>{pdfRupee(igst)}</Text>
            </View>
          ) : (
            <>
              <View style={s.tableRow}>
                <Text style={[s.tdDesc, s.taxLine]}>CGST @ {gstRate / 2}%</Text>
                <Text style={[s.tdAmt, { fontFamily: PDF_FONT }]}>{pdfRupee(cgst)}</Text>
              </View>
              <View style={s.tableRow}>
                <Text style={[s.tdDesc, s.taxLine]}>SGST @ {gstRate / 2}%</Text>
                <Text style={[s.tdAmt, { fontFamily: PDF_FONT }]}>{pdfRupee(sgst)}</Text>
              </View>
            </>
          )}

          <View style={s.totalRow}>
            <Text style={[s.tdDesc, s.totalLabel]}>Total amount received</Text>
            <Text style={[s.tdAmt, s.totalAmount]}>{pdfRupee(payment.amount)}</Text>
          </View>
          {splitLine ? (
            <View style={s.tableRow}>
              <Text style={[s.tdDesc, s.taxLine, { fontFamily: PDF_FONT }]}>
                {pdfSafeMoney(splitLine)} (TDS deducted by the customer, deposited with the government)
              </Text>
            </View>
          ) : null}
        </View>

        {/* ── Amount in words ─────────────────────────────────────── */}
        <Text style={s.inWords}>
          <Text style={s.inWordsLabel}>Amount received (in words): </Text>
          {amountInWords(payment.amount)} only.
        </Text>

        {/* ── GST treatment notice ────────────────────────────────── */}
        <View style={s.gstNotice}>
          <Text style={s.gstNoticeTitle}>GST treatment of this advance</Text>
          <Text style={s.gstNoticeBody}>
            Per CGST Section 13(2), time of supply for services is the earlier of invoice
            issue or payment receipt — so GST is recognized on this advance. A formal
            Tax Invoice will be issued separately upon completion of service / full payment,
            and this receipt voucher will be adjusted against that invoice.
          </Text>
        </View>

        {/* ── Notes ───────────────────────────────────────────────── */}
        {payment.notes && (
          <View style={s.notesBlock}>
            <Text style={s.partyLabel}>Notes</Text>
            <Text style={s.notesText}>{payment.notes}</Text>
          </View>
        )}

        {/* ── Signatures ──────────────────────────────────────────── */}
        <View style={s.signatures}>
          <View style={s.sigBlock}>
            <Text style={s.sigLabel}>Customer signature</Text>
            <View style={s.sigLine} />
          </View>
          <View style={s.sigBlockR}>
            <Text style={s.sigLabel}>For {tenantName}</Text>
            <View style={s.sigLine} />
            <Text style={s.sigAuth}>Authorized signatory</Text>
          </View>
        </View>

        {/* ── Footer ──────────────────────────────────────────────── */}
        <Text style={s.footer}>
          This is a system-generated receipt voucher — valid without seal.
        </Text>
      </Page>
    </Document>
  );
}

// ─── Amount in words (Indian lakh/crore format) ───────────────────────────
// Mirrors the helper in receipt-voucher-dialog.tsx. Duplicated for now — if
// a third caller needs it, lift to src/lib/utils.ts.

function amountInWords(n: number): string {
  if (n === 0) return "Rupees Zero";
  const ones = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten",
                "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
  const tens = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

  const two = (n: number): string => {
    if (n < 20) return ones[n];
    return tens[Math.floor(n / 10)] + (n % 10 ? " " + ones[n % 10] : "");
  };
  const three = (n: number): string => {
    if (n < 100) return two(n);
    return ones[Math.floor(n / 100)] + " Hundred" + (n % 100 ? " " + two(n % 100) : "");
  };

  const parts: string[] = [];
  const crore = Math.floor(n / 10000000);
  if (crore > 0) { parts.push(three(crore) + " Crore");    n %= 10000000; }
  const lakh  = Math.floor(n / 100000);
  if (lakh > 0)  { parts.push(three(lakh) + " Lakh");      n %= 100000;   }
  const thousand = Math.floor(n / 1000);
  if (thousand > 0) { parts.push(three(thousand) + " Thousand"); n %= 1000; }
  if (n > 0) parts.push(three(n));

  return "Rupees " + parts.join(" ");
}
