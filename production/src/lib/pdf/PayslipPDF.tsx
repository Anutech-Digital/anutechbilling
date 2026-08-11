/**
 * PayslipPDF — a monthly salary slip for one employee.
 *
 * Reads straight off a salary_payments row (migration 0087) plus the employee
 * and tenant. The money model is: earned = gross − loss-of-pay; net = earned −
 * advance recovery − TDS − PF − ESI − other. This document just presents that
 * split cleanly (Earnings vs Deductions) with the net pay in words, so an
 * employee gets a proper record and the numbers reconcile with the P&L.
 *
 * Built-in Helvetica/Courier fonts only (no @font-face registration needed),
 * A4, mirrors the InvoicePDF / QuotePDF visual language.
 */
import {
  Document,
  Page,
  View,
  Text,
  StyleSheet,
} from "@react-pdf/renderer";
import { rupee, formatDate } from "@/lib/utils";

/** PDF-safe rupee. The built-in PDF fonts (Helvetica/Courier) have no ₹ (U+20B9)
 *  glyph, so it renders as a broken mark — use "Rs " instead. */
const inrPdf = (n: number) => rupee(n).replace("₹", "Rs ");

// ─── Amount in words (Indian numbering) ─────────────────────────────────────

const ONES = [
  "", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine",
  "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen",
  "Seventeen", "Eighteen", "Nineteen",
];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const t = TENS[Math.floor(n / 10)];
  return n % 10 ? `${t} ${ONES[n % 10]}` : t;
}
function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : "", r ? twoDigits(r) : ""].filter(Boolean).join(" ");
}

/** e.g. 48667 → "Forty Eight Thousand Six Hundred Sixty Seven Rupees Only". */
export function rupeesInWords(amount: number): string {
  let n = Math.round(Math.max(0, amount));
  if (n === 0) return "Zero Rupees Only";
  const crore = Math.floor(n / 10000000); n %= 10000000;
  const lakh = Math.floor(n / 100000); n %= 100000;
  const thousand = Math.floor(n / 1000); n %= 1000;
  const rest = n;
  const parts: string[] = [];
  if (crore) parts.push(`${threeDigits(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return `${parts.join(" ")} Rupees Only`;
}

/** "2026-07" → "July 2026". */
export function periodLabel(period: string): string {
  const [yy, mm] = period.split("-").map(Number);
  const MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];
  if (!yy || !mm || mm < 1 || mm > 12) return period;
  return `${MONTHS[mm - 1]} ${yy}`;
}

// ─── Props ──────────────────────────────────────────────────────────────────

export interface PayslipPDFProps {
  company: {
    name:     string;
    address?: string | null;
    email?:   string | null;
    phone?:   string | null;
    gstin?:   string | null;
  };
  employee: {
    name:  string;
    pan?:  string | null;
    pfNo?: string | null;
    esiNo?: string | null;
  };
  period:  string;          // 'YYYY-MM'
  payDate: string;          // ISO date
  paidVia?: string | null;  // bank/cash account name

  gross:            number;
  lopDays:          number;
  lopAmount:        number;
  incentive?:       number;
  advanceRecovered: number;
  tds:              number;
  pf:               number;
  esi:              number;
  other:            number;
  net:              number;
}

// ─── Styles ──────────────────────────────────────────────────────────────────

const COLORS = {
  ink:      "#1A1A1A",
  ink2:     "#3A3A3A",
  ink3:     "#7A7A7A",
  paper:    "#FFFFFF",
  amber:    "#C2410C",
  hairline: "#E4E4E4",
  soft:     "#F5F5F5",
  emerald:  "#059669",
  emeraldSoft: "#ECFDF5",
};

const s = StyleSheet.create({
  page: {
    paddingHorizontal: 40,
    paddingVertical:   36,
    fontFamily:        "Helvetica",
    fontSize:          10,
    color:             COLORS.ink,
    backgroundColor:   COLORS.paper,
  },

  // Header
  header: {
    flexDirection:     "row",
    justifyContent:    "space-between",
    alignItems:        "flex-start",
    borderBottomWidth: 2,
    borderBottomColor: COLORS.ink,
    paddingBottom:     12,
    marginBottom:      14,
  },
  coName:  { fontFamily: "Helvetica-Bold", fontSize: 16, color: COLORS.ink },
  coMeta:  { fontSize: 9, color: COLORS.ink3, marginTop: 2, lineHeight: 1.4 },
  coMono:  { fontFamily: "Courier", fontSize: 9, color: COLORS.ink3, marginTop: 1 },
  slipBox: { alignItems: "flex-end" },
  slipEyebrow: {
    fontSize: 8, letterSpacing: 1.5, color: COLORS.ink3,
    fontFamily: "Helvetica-Bold", textTransform: "uppercase",
  },
  slipTitle:  { fontFamily: "Helvetica-Bold", fontSize: 15, color: COLORS.amber, marginTop: 2 },
  slipPeriod: { fontSize: 11, color: COLORS.ink2, marginTop: 2 },

  // Employee meta block
  metaBlock: {
    flexDirection:   "row",
    backgroundColor: COLORS.soft,
    borderRadius:    4,
    padding:         12,
    marginBottom:    16,
  },
  metaCol:   { flex: 1, paddingHorizontal: 4 },
  metaLabel: {
    fontSize: 7.5, letterSpacing: 1, color: COLORS.ink3,
    fontFamily: "Helvetica-Bold", textTransform: "uppercase", marginBottom: 2,
  },
  metaValue:     { fontSize: 10, color: COLORS.ink, marginBottom: 8 },
  metaValueBold: { fontSize: 11, color: COLORS.ink, marginBottom: 8, fontFamily: "Helvetica-Bold" },
  metaMono:      { fontFamily: "Courier", fontSize: 9.5 },

  // Earnings / deductions
  columns:  { flexDirection: "row", gap: 14, marginBottom: 14 },
  col:      { flex: 1, borderWidth: 1, borderColor: COLORS.hairline, borderRadius: 4 },
  colHead: {
    backgroundColor: COLORS.soft,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.hairline,
    paddingVertical: 6, paddingHorizontal: 10,
  },
  colHeadText: {
    fontSize: 8.5, letterSpacing: 1.2, color: COLORS.ink2,
    fontFamily: "Helvetica-Bold", textTransform: "uppercase",
  },
  row: {
    flexDirection: "row", justifyContent: "space-between",
    paddingVertical: 5, paddingHorizontal: 10,
    borderBottomWidth: 0.5, borderBottomColor: COLORS.hairline,
  },
  rowLabel:  { fontSize: 10, color: COLORS.ink2 },
  rowValue:  { fontSize: 10, color: COLORS.ink, fontFamily: "Courier" },
  rowValueNeg: { fontSize: 10, color: COLORS.amber, fontFamily: "Courier" },
  subtotal: {
    flexDirection: "row", justifyContent: "space-between",
    paddingVertical: 7, paddingHorizontal: 10,
    borderTopWidth: 1, borderTopColor: COLORS.ink,
  },
  subLabel: { fontSize: 9.5, fontFamily: "Helvetica-Bold", textTransform: "uppercase", letterSpacing: 0.8 },
  subValue: { fontSize: 11, fontFamily: "Helvetica-Bold" },
  emptyLine: { fontSize: 9.5, color: COLORS.ink3, fontStyle: "italic", paddingVertical: 5, paddingHorizontal: 10 },

  // Net pay
  netBox: {
    backgroundColor:  COLORS.emeraldSoft,
    borderWidth:      1,
    borderColor:      "#A7F3D0",
    borderRadius:     4,
    padding:          14,
    marginBottom:     14,
  },
  netRow:   { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  netLabel: { fontSize: 11, fontFamily: "Helvetica-Bold", color: "#047857", textTransform: "uppercase", letterSpacing: 1 },
  netValue: { fontSize: 22, fontFamily: "Helvetica-Bold", color: COLORS.ink },
  netWords: { fontSize: 9.5, color: COLORS.ink2, marginTop: 6, fontStyle: "italic" },
  netPaid:  { fontSize: 9, color: COLORS.ink3, marginTop: 4 },

  // Footer
  footer: {
    borderTopWidth: 1, borderTopColor: COLORS.hairline,
    paddingTop: 10, marginTop: 6,
  },
  footerBold: { fontFamily: "Helvetica-Bold", fontSize: 9.5, color: COLORS.ink2, marginBottom: 3 },
  footerLine: { fontSize: 8.5, color: COLORS.ink3, lineHeight: 1.4 },
});

// ─── Document ─────────────────────────────────────────────────────────────

export function PayslipPDF(props: PayslipPDFProps) {
  const {
    company, employee, period, payDate, paidVia,
    gross, lopDays, lopAmount, advanceRecovered, tds, pf, esi, other, net,
  } = props;
  const incentive = Math.max(0, props.incentive ?? 0);

  const earned = Math.max(0, gross - lopAmount) + incentive;
  const deductions: Array<{ label: string; amount: number }> = [
    { label: "Advance recovery", amount: advanceRecovered },
    { label: "TDS",              amount: tds },
    { label: "Provident Fund (PF)", amount: pf },
    { label: "ESI",              amount: esi },
    { label: "Other",            amount: other },
  ].filter((d) => d.amount > 0);
  const totalDeductions = deductions.reduce((acc, d) => acc + d.amount, 0);

  return (
    <Document
      title={`Payslip ${periodLabel(period)} — ${employee.name}`}
      author={company.name}
      subject={`Salary slip for ${employee.name}, ${periodLabel(period)}`}
    >
      <Page size="A4" style={s.page}>

        {/* ── Header ─────────────────────────────────────────────── */}
        <View style={s.header}>
          <View style={{ flex: 1, paddingRight: 12 }}>
            <Text style={s.coName}>{company.name}</Text>
            {company.address && <Text style={s.coMeta}>{company.address}</Text>}
            {company.gstin   && <Text style={s.coMono}>GSTIN: {company.gstin}</Text>}
            {(company.email || company.phone) && (
              <Text style={s.coMono}>
                {[company.email, company.phone].filter(Boolean).join("  ·  ")}
              </Text>
            )}
          </View>
          <View style={s.slipBox}>
            <Text style={s.slipEyebrow}>Salary Slip</Text>
            <Text style={s.slipTitle}>PAYSLIP</Text>
            <Text style={s.slipPeriod}>{periodLabel(period)}</Text>
          </View>
        </View>

        {/* ── Employee meta ──────────────────────────────────────── */}
        <View style={s.metaBlock}>
          <View style={s.metaCol}>
            <Text style={s.metaLabel}>Employee</Text>
            <Text style={s.metaValueBold}>{employee.name}</Text>
            <Text style={s.metaLabel}>PAN</Text>
            <Text style={[s.metaValue, s.metaMono]}>{employee.pan || "—"}</Text>
          </View>
          <View style={s.metaCol}>
            <Text style={s.metaLabel}>PF No.</Text>
            <Text style={[s.metaValue, s.metaMono]}>{employee.pfNo || "—"}</Text>
            <Text style={s.metaLabel}>ESI No.</Text>
            <Text style={[s.metaValue, s.metaMono]}>{employee.esiNo || "—"}</Text>
          </View>
          <View style={s.metaCol}>
            <Text style={s.metaLabel}>Pay date</Text>
            <Text style={s.metaValue}>{formatDate(payDate)}</Text>
            <Text style={s.metaLabel}>Loss of pay</Text>
            <Text style={s.metaValue}>{lopDays > 0 ? `${lopDays} day${lopDays === 1 ? "" : "s"}` : "None"}</Text>
          </View>
        </View>

        {/* ── Earnings / Deductions ──────────────────────────────── */}
        <View style={s.columns}>
          {/* Earnings */}
          <View style={s.col}>
            <View style={s.colHead}><Text style={s.colHeadText}>Earnings</Text></View>
            <View style={s.row}>
              <Text style={s.rowLabel}>Gross salary</Text>
              <Text style={s.rowValue}>{inrPdf(gross)}</Text>
            </View>
            {lopAmount > 0 && (
              <View style={s.row}>
                <Text style={s.rowLabel}>Less: Loss of pay ({lopDays}d)</Text>
                <Text style={s.rowValueNeg}>-{inrPdf(lopAmount)}</Text>
              </View>
            )}
            {incentive > 0 && (
              <View style={s.row}>
                <Text style={s.rowLabel}>Bonus / Incentive</Text>
                <Text style={s.rowValue}>{inrPdf(incentive)}</Text>
              </View>
            )}
            <View style={s.subtotal}>
              <Text style={s.subLabel}>Earned</Text>
              <Text style={s.subValue}>{inrPdf(earned)}</Text>
            </View>
          </View>

          {/* Deductions */}
          <View style={s.col}>
            <View style={s.colHead}><Text style={s.colHeadText}>Deductions</Text></View>
            {deductions.length === 0 ? (
              <Text style={s.emptyLine}>No deductions</Text>
            ) : (
              deductions.map((d) => (
                <View key={d.label} style={s.row}>
                  <Text style={s.rowLabel}>{d.label}</Text>
                  <Text style={s.rowValue}>{inrPdf(d.amount)}</Text>
                </View>
              ))
            )}
            <View style={s.subtotal}>
              <Text style={s.subLabel}>Total deductions</Text>
              <Text style={s.subValue}>{inrPdf(totalDeductions)}</Text>
            </View>
          </View>
        </View>

        {/* ── Net pay ────────────────────────────────────────────── */}
        <View style={s.netBox}>
          <View style={s.netRow}>
            <Text style={s.netLabel}>Net pay</Text>
            <Text style={s.netValue}>{inrPdf(net)}</Text>
          </View>
          <Text style={s.netWords}>{rupeesInWords(net)}</Text>
          <Text style={s.netPaid}>
            Paid{paidVia ? ` via ${paidVia}` : ""} on {formatDate(payDate)}.
          </Text>
        </View>

        {/* ── Footer ─────────────────────────────────────────────── */}
        <View style={s.footer}>
          <Text style={s.footerBold}>For {company.name}</Text>
          <Text style={s.footerLine}>
            This is a computer-generated payslip and does not require a signature.
            Earned salary (gross minus loss of pay) is the company&apos;s expense; only the net amount was paid out. Statutory deductions (TDS/PF/ESI) are held and remitted to the authorities.
          </Text>
        </View>
      </Page>
    </Document>
  );
}
