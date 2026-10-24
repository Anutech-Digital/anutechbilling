/**
 * R-1835 — the P&L's Revenue split by what was sold.
 *
 * SQL `report_pnl_revenue_by_product` (migration 20261024110239) gives one row per product family
 * — Google Workspace, Microsoft 365, Zoho, Hosting, Domains, In-House Support, Software projects,
 * Other — with the ex-GST invoiced value and the credit / debit notes shared over the same
 * families. Which family a line belongs to is decided ONCE, in SQL `public.revenue_family`
 * (item vendor first, then the line's own text); this file only names the families and checks
 * that the parts add up.
 *
 * The parts are shown only when they add up to report_pnl's figures to the rupee (invoiced,
 * credit notes and debit notes each). Anything else — an older database without the function,
 * a failed call, an invoice written between the two calls — returns null and the statement keeps
 * R-1833's lines. A split that does not add up to the line above it is never shown.
 */
import { vendorLabel } from "@/lib/accounting/pnl";

/** One row of `report_pnl_revenue_by_product`, as PostgREST returns it. */
export interface RevenueByProductRow {
  family: string;
  invoiced: number;
  credit_notes: number;
  debit_notes: number;
  invoice_count: number;
}

export interface RevenueFamily {
  family: string;
  label: string;
  /** invoiced − credit notes + debit notes, ex-GST. */
  net: number;
  invoiced: number;
  creditNotes: number;
  debitNotes: number;
  invoiceCount: number;
}

const LABELS: Record<string, string> = {
  google: vendorLabel("google"),
  microsoft: vendorLabel("microsoft"),
  zoho: vendorLabel("zoho"),
  hosting: "Hosting",
  domain: "Domains",
  support: vendorLabel("support"),
  projects: "Software projects",
  other: "Other sales",
};

/** The statement's name for a family; an unknown key is shown as it is, never dropped. */
export function revenueFamilyLabel(family: string): string {
  return LABELS[family] ?? family;
}

/**
 * The families, or null when they do not add up to report_pnl's own totals exactly.
 */
export function revenueByProduct(
  rows: readonly RevenueByProductRow[] | null | undefined,
  totals: { invoiced: number; creditNotes: number; debitNotes: number },
): RevenueFamily[] | null {
  if (!Array.isArray(rows)) return null;
  const out = rows.map((r): RevenueFamily => {
    const invoiced = Number(r.invoiced) || 0;
    const creditNotes = Number(r.credit_notes) || 0;
    const debitNotes = Number(r.debit_notes) || 0;
    return {
      family: r.family, label: revenueFamilyLabel(r.family),
      net: invoiced - creditNotes + debitNotes, invoiced, creditNotes, debitNotes,
      invoiceCount: Number(r.invoice_count) || 0,
    };
  });
  const sum = (k: "invoiced" | "creditNotes" | "debitNotes") => out.reduce((s, f) => s + f[k], 0);
  if (sum("invoiced") !== totals.invoiced || sum("creditNotes") !== totals.creditNotes || sum("debitNotes") !== totals.debitNotes) {
    return null;
  }
  return out;
}
