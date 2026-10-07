/**
 * R-337 — e-invoice readiness: the tenant's aggregate turnover (AATO) bracket, and the
 * warnings it switches on. No client imports, so a server route can use it too.
 *
 * ─── THE RULES THIS ENCODES ────────────────────────────────────────────────
 * - AATO above ₹5 Cr in any financial year since 2017-18 → every B2B invoice (buyer has a
 *   GSTIN) must be reported to the IRP and carry an IRN (Notification 10/2023-CT).
 * - AATO ₹10 Cr or more → the IRN must be taken within 30 days of the invoice date; the
 *   portal refuses it after that (GSTN advisory, from 1 Apr 2025).
 *
 * The app does NOT generate IRNs yet (R-044, waiting on the GSP decision). So these are
 * warnings only: nothing here blocks issuing an invoice or changes any tax figure.
 *
 * ─── UNKNOWN = TODAY'S BEHAVIOUR ───────────────────────────────────────────
 * The bracket lives on tenants.aggregate_turnover (migration
 * 20261007060000_tenant_aggregate_turnover.sql). Before that is applied, or while the
 * owner has not answered, the bracket is null ("not sure") and no banner shows — exactly
 * like profile-row.ts treats the compliance profile.
 */

export type TurnoverBracket = "up_to_5cr" | "5_to_10cr" | "10cr_plus";

export const TURNOVER_BRACKETS: TurnoverBracket[] = ["up_to_5cr", "5_to_10cr", "10cr_plus"];

export const TURNOVER_BRACKET_LABEL: Record<TurnoverBracket, string> = {
  up_to_5cr: "Up to ₹5 Cr",
  "5_to_10cr": "₹5 Cr – ₹10 Cr",
  "10cr_plus": "₹10 Cr or more",
};

export const TURNOVER_BRACKET_HINT: Record<TurnoverBracket, string> = {
  up_to_5cr: "e-Invoice (IRN) is not needed.",
  "5_to_10cr": "Every B2B invoice needs an e-invoice IRN from the IRP portal.",
  "10cr_plus": "Every B2B invoice needs an IRN, taken within 30 days of the invoice date.",
};

/** Days after the invoice date when the /invoices list starts warning (limit is 30). */
export const IRN_WARN_AFTER_DAYS = 25;
export const IRN_LIMIT_DAYS = 30;

export function toTurnoverBracket(v: unknown): TurnoverBracket | null {
  return typeof v === "string" && (TURNOVER_BRACKETS as string[]).includes(v) ? (v as TurnoverBracket) : null;
}

export interface TurnoverState {
  bracket: TurnoverBracket | null;
  /** True when the database has no column for this yet (migration not applied). */
  columnMissing: boolean;
}

interface PgErrorLike { code?: string | null; message?: string | null }

/** 42703 (SELECT) / PGRST204 (UPDATE) = the column is not there yet = "not migrated". */
export function isMissingTurnoverColumn(err: PgErrorLike | null | undefined): boolean {
  if (!err) return false;
  if (err.code === "42703" || err.code === "PGRST204") return true;
  const m = err.message ?? "";
  return /aggregate_turnover/.test(m) && /(does not exist|could not find)/i.test(m);
}

/** A tenants row read (data + error) as a bracket. Any other error is thrown. */
export function turnoverFromRow(
  row: { aggregate_turnover?: unknown } | null,
  err: PgErrorLike | null,
): TurnoverState {
  if (isMissingTurnoverColumn(err)) return { bracket: null, columnMissing: true };
  if (err) throw Object.assign(new Error(err.message ?? "Could not read the turnover"), { code: err.code });
  return { bracket: toTurnoverBracket(row?.aggregate_turnover), columnMissing: false };
}

/** AATO above ₹5 Cr → B2B invoices need an IRN. */
export function einvoiceRequired(bracket: TurnoverBracket | null | undefined): boolean {
  return bracket === "5_to_10cr" || bracket === "10cr_plus";
}

/** AATO ₹10 Cr or more → the IRN must be taken within 30 days. */
export function irnDeadlineApplies(bracket: TurnoverBracket | null | undefined): boolean {
  return bracket === "10cr_plus";
}

/** B2B = the buyer has a GSTIN on the invoice. */
export function isB2B(gstin: string | null | undefined): boolean {
  return typeof gstin === "string" && gstin.trim().length > 0;
}

export interface EinvoiceNoticeText { title: string; body: string }

/**
 * The banner inside the issue dialog. `b2bCount` is how many of the invoices about to be
 * issued have a buyer GSTIN; `total` is how many are being issued.
 */
export function issueEinvoiceNotice(
  bracket: TurnoverBracket | null | undefined,
  b2bCount: number,
  total: number,
): EinvoiceNoticeText | null {
  if (!einvoiceRequired(bracket) || b2bCount <= 0) return null;
  const which = total <= 1
    ? "This is a B2B invoice"
    : `${b2bCount} of these ${total} invoices are B2B`;
  const deadline = irnDeadlineApplies(bracket)
    ? ` Take it within ${IRN_LIMIT_DAYS} days of the invoice date — the portal refuses it after that.`
    : "";
  return {
    title: "e-Invoice IRN needed",
    body: `${which} and your turnover is over ₹5 Cr, so it needs an IRN from the IRP portal. This app does not generate IRNs yet — get it on einvoice1.gst.gov.in after issuing.${deadline}`,
  };
}

/** The banner on one invoice's page: B2B, over ₹5 Cr, no IRN recorded. */
export function invoiceEinvoiceNotice(
  bracket: TurnoverBracket | null | undefined,
  inv: { customerGstin: string | null | undefined; gstIrn: string | null | undefined; status?: string | null; invoiceDate?: string | null },
  now: Date = new Date(),
): EinvoiceNoticeText | null {
  if (!einvoiceRequired(bracket) || !isB2B(inv.customerGstin)) return null;
  if (inv.gstIrn && inv.gstIrn.trim()) return null;
  if (inv.status === "void" || inv.status === "draft") return null;
  let deadline = "";
  if (irnDeadlineApplies(bracket) && inv.invoiceDate) {
    const age = invoiceAgeDays(inv.invoiceDate, now);
    deadline = age > IRN_LIMIT_DAYS
      ? ` It is ${age} days old — past the ${IRN_LIMIT_DAYS}-day IRN limit; talk to your CA.`
      : ` ${IRN_LIMIT_DAYS - age} day${IRN_LIMIT_DAYS - age === 1 ? "" : "s"} left of the ${IRN_LIMIT_DAYS}-day IRN limit.`;
  }
  return {
    title: "No e-invoice IRN on this invoice",
    body: `Your turnover is over ₹5 Cr, so this B2B invoice needs an IRN from the IRP portal. This app does not generate IRNs yet — get it on einvoice1.gst.gov.in.${deadline}`,
  };
}

/** Whole days from the invoice date (YYYY-MM-DD or ISO) to `now`, by calendar date in UTC. */
export function invoiceAgeDays(invoiceDate: string, now: Date = new Date()): number {
  const d = Date.parse(invoiceDate.length === 10 ? `${invoiceDate}T00:00:00Z` : invoiceDate);
  if (Number.isNaN(d)) return 0;
  const start = Date.UTC(new Date(d).getUTCFullYear(), new Date(d).getUTCMonth(), new Date(d).getUTCDate());
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.max(0, Math.round((today - start) / 86400000));
}

export interface IrnAgeInvoice {
  id: string;
  invoice_date: string;
  gst_irn?: string | null;
  customer_gstin?: string | null;
  status?: string | null;
}

/**
 * The /invoices list banner (₹10 Cr+ only): B2B invoices with no IRN that are
 * IRN_WARN_AFTER_DAYS or more days old. `pastLimit` counts the ones already over 30.
 */
export function irnAgeingInvoices<T extends IrnAgeInvoice>(
  bracket: TurnoverBracket | null | undefined,
  invoices: readonly T[],
  now: Date = new Date(),
): { ageing: T[]; pastLimit: number } {
  if (!irnDeadlineApplies(bracket)) return { ageing: [], pastLimit: 0 };
  const ageing = invoices.filter((i) =>
    isB2B(i.customer_gstin) &&
    !(i.gst_irn && i.gst_irn.trim()) &&
    i.status !== "void" && i.status !== "draft" &&
    invoiceAgeDays(i.invoice_date, now) >= IRN_WARN_AFTER_DAYS,
  );
  const pastLimit = ageing.filter((i) => invoiceAgeDays(i.invoice_date, now) > IRN_LIMIT_DAYS).length;
  return { ageing, pastLimit };
}

export function irnAgeingNotice(count: number, pastLimit: number): EinvoiceNoticeText | null {
  if (count <= 0) return null;
  const s = count === 1 ? "" : "s";
  const past = pastLimit > 0 ? ` ${pastLimit} ${pastLimit === 1 ? "is" : "are"} already past ${IRN_LIMIT_DAYS} days — talk to your CA.` : "";
  return {
    title: `${count} B2B invoice${s} near the ${IRN_LIMIT_DAYS}-day IRN limit`,
    body: `Your turnover is ₹10 Cr or more, so each B2B invoice needs an IRN within ${IRN_LIMIT_DAYS} days of its date. ${count === 1 ? "This one is" : "These are"} ${IRN_WARN_AFTER_DAYS}+ days old with no IRN. This app does not generate IRNs yet — get them on einvoice1.gst.gov.in.${past}`,
  };
}
