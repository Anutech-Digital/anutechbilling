/**
 * PendingDuesPDF — R-1526 "Statement of pending dues": every open bill of one customer, the
 * total, where to pay (bank details) and ONE scan-to-pay UPI QR for the whole total.
 *
 * Not a tax invoice (R-1524: issued GST invoices are never merged) — it says so under the title,
 * has no number of its own and lists the real invoice numbers it asks for.
 *
 * Layout (A4 portrait):
 *   1. Header   — company logo/monogram, name, GSTIN, contact | "Statement of pending dues", as-on date
 *   2. To       — customer name, GSTIN, address
 *   3. Table    — invoice / bill, date, due date, days overdue, amount due
 *   4. Total    — TOTAL DUE
 *   5. Pay      — bank details (tenant remit_*), UPI QR for the total, online pay link when one exists
 *
 * Every decision (which lines, the total, whether a QR is allowed) is made by the caller from
 * lib/collections/pending-dues — this component only draws. Money via pdfRupee() (§13).
 */
import { Document, Page, View, Text, Image, Link, StyleSheet } from "@react-pdf/renderer";
import { formatDate } from "@/lib/utils";
import { pdfRupee } from "./pdf-money";
import { pdfText } from "./pdf-text";
import { isRenderableLogo } from "./logo";
import type { ProformaBank } from "./quote-template";
import { STATEMENT_NOTICE, type DuesLine } from "@/lib/collections/pending-dues";
import { PDF_FONT, PDF_FONT_BOLD, registerPdfFonts } from "./fonts";

/* Before StyleSheet.create — PDF_FONT is a `let` that registration may change (see QuotePDF). */
registerPdfFonts();

export const STATEMENT_TITLE = "Statement of pending dues";

export interface PendingDuesPDFProps {
  tenantName: string;
  tenantGstin?: string | null;
  tenantEmail?: string | null;
  tenantPhone?: string | null;
  tenantAddress?: string | null;
  /** Already resolved to a data: URI by logoDataUri() — anything else draws the monogram. */
  tenantLogo?: string | null;

  customerName: string;
  customerGstin?: string | null;
  customerAddress?: string | null;

  /** YYYY-MM-DD (IST). */
  asOn: string;
  lines: readonly DuesLine[];
  /** Whole rupees — the sum of the lines. */
  total: number;

  /** Tenant remit_* (proformaBank()). Null → no bank block. */
  bank?: ProformaBank | null;
  /** PNG data-URL from buildStatementUpiQr(). Null → no QR (no UPI ID / non-INR / nothing due). */
  upiQrDataUrl?: string | null;
  upiVpa?: string | null;
  /** A public online-payment page for the total, when one exists. Null → omitted. */
  payLinkUrl?: string | null;
}

const C = { ink: "#1A1A1A", ink2: "#3A3A3A", ink3: "#7A7A7A", paper: "#FFFFFF", rose: "#B42318", hairline: "#E4E4E4" };

const s = StyleSheet.create({
  page: { paddingHorizontal: 40, paddingVertical: 36, fontFamily: PDF_FONT, fontSize: 10, color: C.ink, backgroundColor: C.paper },
  header: {
    flexDirection: "row", justifyContent: "space-between", alignItems: "flex-start",
    borderBottomWidth: 2, borderBottomColor: C.ink, paddingBottom: 14, marginBottom: 16,
  },
  brand: { flexDirection: "row", alignItems: "flex-start", maxWidth: 300 },
  monogram: {
    width: 36, height: 36, backgroundColor: C.ink, color: C.paper, fontFamily: PDF_FONT_BOLD,
    fontSize: 18, textAlign: "center", paddingTop: 7, marginRight: 10,
  },
  logo: { height: 36, maxWidth: 150, objectFit: "contain", marginRight: 10 },
  brandName: { fontFamily: PDF_FONT_BOLD, fontSize: 15 },
  meta: { fontSize: 9, color: C.ink3, marginTop: 2 },
  titleBlock: { alignItems: "flex-end" },
  title: { fontFamily: PDF_FONT_BOLD, fontSize: 16 },
  notice: { fontSize: 9, color: C.rose, marginTop: 3 },
  label: { fontSize: 8, letterSpacing: 1.5, color: C.ink3, fontFamily: PDF_FONT_BOLD, textTransform: "uppercase", marginBottom: 3 },
  customer: { fontFamily: PDF_FONT_BOLD, fontSize: 13 },
  line: { fontSize: 10, color: C.ink2, marginTop: 2 },
  toBlock: { marginBottom: 16 },
  thRow: { flexDirection: "row", borderTopWidth: 2, borderBottomWidth: 2, borderColor: C.ink, paddingVertical: 6 },
  tr: { flexDirection: "row", borderBottomWidth: 1, borderBottomColor: C.hairline, paddingVertical: 6 },
  th: { fontFamily: PDF_FONT_BOLD, fontSize: 8, textTransform: "uppercase", letterSpacing: 1 },
  cBill: { flex: 3, paddingRight: 6 },
  cDate: { width: 72 },
  cDue: { width: 72 },
  cLate: { width: 64, textAlign: "right" },
  cAmt: { width: 88, textAlign: "right" },
  kind: { fontSize: 7, color: C.ink3, textTransform: "uppercase", letterSpacing: 1 },
  late: { color: C.rose },
  totalRow: { flexDirection: "row", justifyContent: "flex-end", borderTopWidth: 2, borderTopColor: C.ink, paddingTop: 8, marginTop: 2 },
  totalLabel: { fontFamily: PDF_FONT_BOLD, fontSize: 11, marginRight: 16 },
  totalValue: { fontFamily: PDF_FONT_BOLD, fontSize: 14, width: 140, textAlign: "right" },
  payRow: { flexDirection: "row", marginTop: 22, borderTopWidth: 1, borderTopColor: C.hairline, paddingTop: 12 },
  payCol: { flex: 1, paddingRight: 12 },
  sub: { fontSize: 9, color: C.ink2, marginTop: 2 },
  qrBlock: { flexDirection: "row", alignItems: "flex-start" },
  qr: { width: 92, height: 92, marginRight: 10 },
  payLink: { fontSize: 9, color: C.ink, textDecoration: "underline", marginTop: 2 },
  foot: { marginTop: 24, fontSize: 8, color: C.ink3 },
});

export function PendingDuesPDF(p: PendingDuesPDFProps) {
  const logo = isRenderableLogo(p.tenantLogo) ? p.tenantLogo : null;
  const contact = [p.tenantEmail, p.tenantPhone].filter((x) => x && x.trim()).join(" · ");
  return (
    <Document title={`${STATEMENT_TITLE} — ${pdfText(p.customerName)}`} author={pdfText(p.tenantName)}>
      <Page size="A4" style={s.page}>
        <View style={s.header}>
          <View style={s.brand}>
            {logo ? <Image src={logo} style={s.logo} /> : <Text style={s.monogram}>{(p.tenantName.trim()[0] ?? "R").toUpperCase()}</Text>}
            <View>
              <Text style={s.brandName}>{pdfText(p.tenantName)}</Text>
              {p.tenantGstin ? <Text style={s.meta}>GSTIN: {p.tenantGstin}</Text> : null}
              {p.tenantAddress ? <Text style={s.meta}>{pdfText(p.tenantAddress)}</Text> : null}
              {contact ? <Text style={s.meta}>{pdfText(contact)}</Text> : null}
            </View>
          </View>
          <View style={s.titleBlock}>
            <Text style={s.title}>{STATEMENT_TITLE}</Text>
            <Text style={s.meta}>As on {formatDate(p.asOn)}</Text>
            <Text style={s.notice}>{STATEMENT_NOTICE}</Text>
          </View>
        </View>

        <View style={s.toBlock}>
          <Text style={s.label}>Statement for</Text>
          <Text style={s.customer}>{pdfText(p.customerName)}</Text>
          {p.customerGstin ? <Text style={s.line}>GSTIN: {p.customerGstin}</Text> : null}
          {p.customerAddress ? <Text style={s.line}>{pdfText(p.customerAddress)}</Text> : null}
        </View>

        <View style={s.thRow} fixed>
          <Text style={[s.th, s.cBill]}>Invoice / bill</Text>
          <Text style={[s.th, s.cDate]}>Date</Text>
          <Text style={[s.th, s.cDue]}>Due date</Text>
          <Text style={[s.th, s.cLate]}>Overdue</Text>
          <Text style={[s.th, s.cAmt]}>Amount due</Text>
        </View>
        {p.lines.map((l) => (
          <View key={`${l.kind}:${l.id}`} style={s.tr} wrap={false}>
            <View style={s.cBill}>
              <Text style={s.kind}>{l.kind === "invoice" ? "Tax invoice" : "Subscription"}</Text>
              <Text>{pdfText(l.label)}</Text>
            </View>
            <Text style={s.cDate}>{l.date ? formatDate(l.date) : "—"}</Text>
            <Text style={s.cDue}>{l.dueDate ? formatDate(l.dueDate) : "—"}</Text>
            <Text style={l.daysOverdue > 0 ? [s.cLate, s.late] : s.cLate}>
              {l.daysOverdue > 0 ? `${l.daysOverdue} ${l.daysOverdue === 1 ? "day" : "days"}` : "Not yet due"}
            </Text>
            <Text style={s.cAmt}>{pdfRupee(l.amountDue)}</Text>
          </View>
        ))}
        <View style={s.totalRow} wrap={false}>
          <Text style={s.totalLabel}>TOTAL DUE</Text>
          <Text style={s.totalValue}>{pdfRupee(p.total)}</Text>
        </View>

        {(p.bank || p.upiQrDataUrl || p.payLinkUrl) ? (
          <View style={s.payRow} wrap={false}>
            {p.bank ? (
              <View style={s.payCol}>
                <Text style={s.label}>Pay by bank transfer</Text>
                {p.bank.accountName ? <Text style={s.sub}>Account name: {pdfText(p.bank.accountName)}</Text> : null}
                {p.bank.bankName ? <Text style={s.sub}>Bank: {pdfText(p.bank.bankName)}</Text> : null}
                <Text style={s.sub}>Account no.: {p.bank.accountNumber}</Text>
                {p.bank.ifsc ? <Text style={s.sub}>IFSC: {p.bank.ifsc}</Text> : null}
                {p.bank.branch ? <Text style={s.sub}>Branch: {pdfText(p.bank.branch)}</Text> : null}
              </View>
            ) : null}
            {p.upiQrDataUrl ? (
              <View style={[s.payCol, s.qrBlock]}>
                <Image src={p.upiQrDataUrl} style={s.qr} />
                <View>
                  <Text style={s.label}>Scan to pay the total</Text>
                  <Text style={s.sub}>{pdfRupee(p.total)} by UPI</Text>
                  {p.upiVpa ? <Text style={s.sub}>UPI ID: {p.upiVpa}</Text> : null}
                </View>
              </View>
            ) : null}
            {p.payLinkUrl ? (
              <View style={s.payCol}>
                <Text style={s.label}>Pay online</Text>
                <Link src={p.payLinkUrl} style={s.payLink}>{p.payLinkUrl}</Link>
              </View>
            ) : null}
          </View>
        ) : null}

        <Text style={s.foot}>
          {STATEMENT_NOTICE} It lists tax invoices already issued to you; please quote the invoice numbers with your payment.
          Paid already? Please ignore this statement, or reply to let us know.
        </Text>
      </Page>
    </Document>
  );
}
