/**
 * R-2418 — the Online fee report: of every rupee Razorpay kept on an online payment, how much the
 * customer paid back and how much the business still bears — per month and per customer, with
 * the reason.
 *
 * Inputs per payment (R-045 + R-2416):
 *   gateway_fee     whole rupees Razorpay kept, GST included (null = not an online payment → skipped)
 *   gateway_fee_gst the GST part of it
 *   fee_bearer      who the policy said pays the fee at capture: 'customer' | 'business';
 *                   NULL = captured before the policy existed (R-2416) → absorbed, "Before the policy"
 *   fee_charged     whole rupees the customer paid on top of the bill for the fee (R-2417 charges it;
 *                   0 until then)
 *
 * Per payment, whole rupees, no rounding:
 *   recovered = fee_charged (0 when null)
 *   absorbed  = max(0, fee − recovered)      what the business still paid
 *   surplus   = max(0, recovered − fee)      the customer paid more than Razorpay kept (the grossed-up
 *                                            fee + its GST is usually a little above Razorpay's fee)
 *   so fee = recovered + absorbed − surplus, for every row and every total.
 *
 * Reason (business bearer): the bill's waiver, else the customer's "We absorb", else the company
 * rule ("We pay" setting or the bill was at/above the limit) — the same precedence as onlineFeeFor.
 * Customer bearer with nothing charged = "Not charged yet" (the policy said customer pays, but the
 * fee was not added to that payment — before R-2417).
 *
 * Pure: no I/O. lib/queries/online-fee-report.ts reads the rows.
 */
import { toIstDate } from "@/lib/dates/ist";
import { gstinIssue } from "@/lib/gst/itc";
import { rupee } from "@/lib/utils";

export type FeeReportReason =
  | "customer_pays"
  | "not_charged"
  | "bill_waived"
  | "customer_absorbs"
  | "company_rule"
  | "before_policy";

export const FEE_REASON_LABEL: Readonly<Record<FeeReportReason, string>> = {
  customer_pays: "Customer paid the fee",
  not_charged: "Customer should pay — not charged yet",
  bill_waived: "Waived on the bill",
  customer_absorbs: "We absorb for this customer",
  company_rule: "Company rule (we pay / bill above limit)",
  before_policy: "Before the fee policy",
};

export interface FeeReportPayment {
  id: string;
  /** timestamptz — the month is its IST calendar month. */
  receivedAt: string;
  customerId: string | null;
  customerName: string | null;
  gatewayFee: number | null;
  gatewayFeeGst: number | null;
  feeBearer: string | null;
  feeCharged: number | null;
  /** The quote's or its invoice's "Waive online fee". */
  billWaived: boolean;
  /** The customer's "We absorb" override. */
  customerAbsorbs: boolean;
}

export interface FeeReportLine {
  reason: FeeReportReason;
  fee: number;
  gst: number;
  recovered: number;
  absorbed: number;
  surplus: number;
}

export interface FeeSums {
  payments: number;
  fee: number;
  feeGst: number;
  recovered: number;
  absorbed: number;
  surplus: number;
}

export interface FeeReportTotals extends FeeSums {
  /** gateway_fee split by fee_bearer — the three add up to `fee`. */
  byBearer: { customer: number; business: number; beforePolicy: number };
}

export interface FeeReportMonth extends FeeSums {
  /** YYYY-MM, IST */
  month: string;
}

export interface FeeReportCustomer extends FeeSums {
  key: string;
  customerId: string | null;
  customerName: string;
  reason: FeeReportReason;
}

export interface FeeReport {
  totals: FeeReportTotals;
  /** newest month first */
  months: FeeReportMonth[];
  /** customer × reason, the biggest absorbed first */
  customers: FeeReportCustomer[];
}

const wholeNonNeg = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function reasonOf(p: FeeReportPayment, recovered: number): FeeReportReason {
  if (p.feeBearer === "business") {
    if (p.billWaived) return "bill_waived";
    if (p.customerAbsorbs) return "customer_absorbs";
    return "company_rule";
  }
  if (p.feeBearer === "customer") return recovered > 0 ? "customer_pays" : "not_charged";
  return "before_policy";
}

/** One payment's line, or null when its fee is unknown (manual payment) or not a whole rupee. */
export function feeReportLine(p: FeeReportPayment): FeeReportLine | null {
  if (!wholeNonNeg(p.gatewayFee)) return null;
  const fee = p.gatewayFee;
  const gst = wholeNonNeg(p.gatewayFeeGst) && p.gatewayFeeGst <= fee ? p.gatewayFeeGst : 0;
  const recovered = wholeNonNeg(p.feeCharged) ? p.feeCharged : 0;
  return {
    reason: reasonOf(p, recovered),
    fee,
    gst,
    recovered,
    absorbed: Math.max(0, fee - recovered),
    surplus: Math.max(0, recovered - fee),
  };
}

const zero = (): FeeSums => ({ payments: 0, fee: 0, feeGst: 0, recovered: 0, absorbed: 0, surplus: 0 });

function add(s: FeeSums, l: FeeReportLine): void {
  s.payments += 1;
  s.fee += l.fee;
  s.feeGst += l.gst;
  s.recovered += l.recovered;
  s.absorbed += l.absorbed;
  s.surplus += l.surplus;
}

export function buildFeeReport(rows: readonly FeeReportPayment[]): FeeReport {
  const totals: FeeReportTotals = { ...zero(), byBearer: { customer: 0, business: 0, beforePolicy: 0 } };
  const months = new Map<string, FeeReportMonth>();
  const customers = new Map<string, FeeReportCustomer>();

  for (const p of rows) {
    const l = feeReportLine(p);
    if (!l) continue;
    add(totals, l);
    if (p.feeBearer === "customer") totals.byBearer.customer += l.fee;
    else if (p.feeBearer === "business") totals.byBearer.business += l.fee;
    else totals.byBearer.beforePolicy += l.fee;

    const month = toIstDate(p.receivedAt).slice(0, 7);
    let m = months.get(month);
    if (!m) months.set(month, (m = { month, ...zero() }));
    add(m, l);

    const name = (p.customerName ?? "").trim() || "Unknown customer";
    const who = p.customerId ?? `name:${name}`;
    const key = `${who}|${l.reason}`;
    let c = customers.get(key);
    if (!c) customers.set(key, (c = { key, customerId: p.customerId, customerName: name, reason: l.reason, ...zero() }));
    add(c, l);
  }

  return {
    totals,
    months: [...months.values()].sort((a, b) => b.month.localeCompare(a.month)),
    customers: [...customers.values()].sort(
      (a, b) => b.absorbed - a.absorbed || b.fee - a.fee || a.customerName.localeCompare(b.customerName),
    ),
  };
}

/**
 * GST on the fee that cannot be claimed: ITC needs Razorpay's GSTIN on the vendor (lib/gst/itc.ts,
 * the same rule fee-expense.ts books under). No vendor, an empty or a wrong GSTIN → all of it.
 */
export function blockedFeeGst(rows: readonly FeeReportPayment[], razorpayVendorGstin: string | null | undefined): number {
  if (!gstinIssue(razorpayVendorGstin)) return 0;
  let gst = 0;
  for (const p of rows) {
    const l = feeReportLine(p);
    if (l) gst += l.gst;
  }
  return gst;
}

export function feeGstBlockedText(gst: number): string {
  return `Fee GST ${rupee(gst)} credit blocked — add Razorpay's GSTIN`;
}

/** One settlement: Razorpay's fee on it vs what its matched payments recovered from customers. */
export function settlementFeeSplit(
  fee: number,
  feeCharged: readonly (number | null | undefined)[],
): { fee: number; recovered: number; absorbed: number; surplus: number } {
  const f = Number.isFinite(fee) && fee > 0 ? Math.round(fee) : 0;
  const recovered = feeCharged.reduce<number>((s, v) => s + (wholeNonNeg(v) ? v : 0), 0);
  return { fee: f, recovered, absorbed: Math.max(0, f - recovered), surplus: Math.max(0, recovered - f) };
}
