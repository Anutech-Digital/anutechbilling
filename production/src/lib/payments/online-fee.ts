/**
 * R-2416 — the online payment fee POLICY: who pays Razorpay's fee on a bill, and how much.
 *
 * Pardeep (3 Nov 2026): "Razorpay fee customer ko deni chahiye, par kai cases me hum dete hai."
 * Razorpay's own "Customer Fee Bearer" is account-wide and breaks UPI payment links, so the app
 * holds the policy (Anutech-HQ/drafts/RAZORPAY-FEE/plan.md):
 *   1. Settings → Company → Online payment fee: who pays by default (Customer / Us), rate %
 *      (default 2), GST 18% on the fee, optional "we absorb when the bill is ₹X or more".
 *   2. Customer: Default / We absorb for this customer (+ reason).
 *   3. Quote / invoice: Waive online fee for this bill (+ reason).
 * Order of precedence: bill waiver > customer absorb > company default "Us" > threshold > customer pays.
 *
 * This card (R-2416) only decides and SHOWS it, and records who bore the fee on each captured
 * payment. No order or link amount changes yet — R-2417 charges it.
 *
 * Money (whole rupees, stated and tested in online-fee.test.ts):
 *   fee = rate % of the bill TOTAL (incl. GST), rounded half up to the rupee;
 *   gst = 18% of that rounded fee, rounded half up to the rupee;
 *   total = fee + gst.
 * Worked in paise × basis points (integers) so 2.15% or ₹1,025 never meets a float edge.
 */
import { rupee } from "@/lib/utils";

export type OnlineFeeBearer = "customer" | "business";

/** GST on the fee we recover (18%, SAC to be confirmed by the CA — plan.md "For Hitesh"). */
export const ONLINE_FEE_GST_PCT = 18;
export const ONLINE_FEE_DEFAULT_RATE_PCT = 2;
/** Same bounds as the tenants_online_fee_rate_check constraint. */
export const ONLINE_FEE_MAX_RATE_PCT = 10;

export interface OnlineFeeSettings {
  /** Who pays by default. */
  bearer: OnlineFeeBearer;
  /** Fee rate in percent of the bill total, e.g. 2 or 2.15. */
  ratePct: number;
  /** We absorb the fee when the bill total is this many rupees or more; null = never. */
  waiveAbove: number | null;
  /** Optional text the pay page / invoice line uses for the fee (R-2417); null = "Online payment fee". */
  lineText: string | null;
}

export const DEFAULT_ONLINE_FEE_SETTINGS: OnlineFeeSettings = {
  bearer: "customer",
  ratePct: ONLINE_FEE_DEFAULT_RATE_PCT,
  waiveAbove: null,
  lineText: null,
};

export interface OnlineFeeCustomer {
  /** null = Default (company setting); "absorb" = we absorb for this customer. */
  override: "absorb" | null;
  reason: string | null;
}

export interface OnlineFeeBill {
  /** The bill total in rupees, GST included. */
  billTotal: number;
  waived?: boolean | null;
  waiveReason?: string | null;
}

export type OnlineFeeReason = "bill_waived" | "customer_absorbs" | "company_default" | "above_threshold" | "customer_pays";

export interface OnlineFeeResult {
  bearer: OnlineFeeBearer;
  /** The fee, whole rupees — what the customer pays when bearer = customer, else what it costs us. */
  fee: number;
  gst: number;
  total: number;
  reason: OnlineFeeReason;
  /** The typed reason of a bill waiver / customer absorb; null otherwise. */
  note: string | null;
}

function cleanNote(v: string | null | undefined): string | null {
  const t = (v ?? "").trim();
  return t ? t : null;
}

/** The fee on a bill, whole rupees (see the header for the rounding). */
export function onlineFeeAmounts(billTotal: number, ratePct: number): { fee: number; gst: number; total: number } {
  if (!Number.isFinite(billTotal) || billTotal <= 0 || !Number.isFinite(ratePct) || ratePct <= 0) {
    return { fee: 0, gst: 0, total: 0 };
  }
  const paise = Math.round(billTotal * 100);
  const bp = Math.round(ratePct * 100); // 2% → 200 basis points
  const fee = Math.round((paise * bp) / 1_000_000);
  const gst = Math.round((fee * ONLINE_FEE_GST_PCT) / 100);
  return { fee, gst, total: fee + gst };
}

/** Who pays the online fee on this bill, and how much. Pure — the same answer on screen and on capture. */
export function onlineFeeFor(
  bill: OnlineFeeBill,
  customer: OnlineFeeCustomer | null | undefined,
  settings: OnlineFeeSettings,
): OnlineFeeResult {
  const amounts = onlineFeeAmounts(bill.billTotal, settings.ratePct);
  const business = (reason: OnlineFeeReason, note: string | null = null): OnlineFeeResult =>
    ({ bearer: "business", ...amounts, reason, note });

  if (bill.waived) return business("bill_waived", cleanNote(bill.waiveReason));
  if (customer?.override === "absorb") return business("customer_absorbs", cleanNote(customer.reason));
  if (settings.bearer === "business") return business("company_default");
  if (settings.waiveAbove !== null && settings.waiveAbove > 0 && bill.billTotal >= settings.waiveAbove) {
    return business("above_threshold");
  }
  return { bearer: "customer", ...amounts, reason: "customer_pays", note: null };
}

/** One read-only line for the quote / invoice page. */
export function onlineFeeLine(r: OnlineFeeResult, settings?: Pick<OnlineFeeSettings, "waiveAbove">): string {
  const why = r.note ? ` — ${r.note}` : "";
  switch (r.reason) {
    case "customer_pays":
      return `Online fee: customer pays ${rupee(r.total)} (${rupee(r.fee)} + ${rupee(r.gst)} GST) if paid online. Bank transfer is free.`;
    case "bill_waived":
      return `Online fee: waived for this bill${why}`;
    case "customer_absorbs":
      return `Online fee: we absorb it for this customer${why}`;
    case "company_default":
      return "Online fee: we absorb it (company setting)";
    case "above_threshold":
      return settings?.waiveAbove ? `Online fee: we absorb it — bill is ${rupee(settings.waiveAbove)} or more` : "Online fee: we absorb it — bill is above the company's limit";
  }
}

/** The tenant row's online_fee_* columns → settings. Missing columns (before the migration) → defaults. */
export function parseOnlineFeeSettings(row: Record<string, unknown> | null | undefined): OnlineFeeSettings {
  if (!row) return { ...DEFAULT_ONLINE_FEE_SETTINGS };
  const rate = Number(row.online_fee_rate_pct);
  const above = row.online_fee_waive_above == null ? null : Number(row.online_fee_waive_above);
  const text = typeof row.online_fee_line_text === "string" ? cleanNote(row.online_fee_line_text) : null;
  return {
    bearer: row.online_fee_bearer === "business" ? "business" : "customer",
    ratePct: Number.isFinite(rate) && rate > 0 ? rate : ONLINE_FEE_DEFAULT_RATE_PCT,
    waiveAbove: above !== null && Number.isFinite(above) && above > 0 ? above : null,
    lineText: text,
  };
}

/** customers.online_fee_override / _reason → the customer half of the policy. */
export function parseOnlineFeeCustomer(row: Record<string, unknown> | null | undefined): OnlineFeeCustomer {
  return {
    override: row?.online_fee_override === "absorb" ? "absorb" : null,
    reason: typeof row?.online_fee_override_reason === "string" ? cleanNote(row.online_fee_override_reason) : null,
  };
}

/** The columns of the policy, for selects. */
export const TENANT_ONLINE_FEE_COLUMNS = "online_fee_bearer, online_fee_rate_pct, online_fee_waive_above, online_fee_line_text";
export const CUSTOMER_ONLINE_FEE_COLUMNS = "online_fee_override, online_fee_override_reason";
export const BILL_ONLINE_FEE_COLUMNS = "online_fee_waived, online_fee_waive_reason";

/** Before the migration: the column is not there (Postgres 42703 / PostgREST PGRST204 or a schema-cache miss). */
export function isOnlineFeeColumnMissing(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  return /online_fee|fee_bearer/.test(err.message ?? "") && /(does not exist|could not find)/i.test(err.message ?? "");
}
