/**
 * R-1729 (owner journey audit, 21 Oct 2026) — pure helpers for the Add expense form.
 *
 * The form used to open on Category = "Hosting" for every new expense, so a quick entry that
 * skipped the field went into the wrong account. Category now starts EMPTY and is required;
 * the form only SUGGESTS the category last used (for this payee if we have paid them before,
 * else the latest expense), and the operator clicks it to accept.
 *
 * GST, TDS and reverse charge sit under "More". It opens by itself whenever the entry needs
 * it, so no rule (ITC on a GST invoice, RCM on a foreign bill, a recorded TDS) is ever hidden.
 */

export interface LastUsedRow {
  category?: string | null;
  vendor_name?: string | null;
}

/**
 * The category to suggest: the newest row for this payee (same name, case-insensitive),
 * else the newest row overall. Rows are newest first (fetchExpenseDupList's order). Only
 * categories in `allowed` count — never "Salaries" (Payroll's) or a retired name.
 */
export function lastUsedCategory(
  rows: readonly LastUsedRow[] | null | undefined,
  allowed: readonly string[],
  vendorName?: string | null,
): string | null {
  const ok = (c: string | null | undefined): c is string => !!c && c !== "Salaries" && allowed.includes(c);
  const list = rows ?? [];
  const name = (vendorName ?? "").trim().toLowerCase();
  if (name) {
    const forPayee = list.find((r) => (r.vendor_name ?? "").trim().toLowerCase() === name && ok(r.category));
    if (forPayee) return forPayee.category as string;
  }
  const latest = list.find((r) => ok(r.category));
  return latest ? (latest.category as string) : null;
}

/** "More" (GST · TDS · reverse charge) is open when the entry needs one of them. */
export function moreNeeded(o: { billType: string; rcm: boolean; tdsSection?: string | null; foreign: boolean }): boolean {
  return o.billType === "gst" || o.rcm || o.foreign || !!(o.tdsSection ?? "").trim();
}

/* ── R-2683 (12 Nov 2026) ─────────────────────────────────────────────────────────────────
   1) A row imported from Zoho Books (`zoho_doc_id` set by import_zoho_fy_purchases) may be
      booked as Salaries — salary paid to someone who is not in Payroll (Pardeep's call for the
      9 "Emp Prashant (Salary)" bills). Hand-made rows still never offer Salaries, and a row
      Payroll made keeps it as before.
   2) Saving "Edit expense" re-sent every field from the form, so an UNPAID row got the form's
      default "bank_transfer" as its payment method (the list then showed "bank_transfer · …"),
      and an imported row lost its IGST/CGST/SGST split and its paid date. Fields the user did
      not change now keep what is stored. */

/** Help line shown under Category when Salaries is offered for an imported row. */
export const SALARY_OUTSIDE_PAYROLL_HELP = "Salary paid outside Payroll";

/** The bits of a stored expense these helpers read. `zoho_doc_id` is not in the generated types. */
export interface StoredExpenseLike {
  category?: string | null;
  payment_method?: string | null;
  zoho_doc_id?: string | null;
  vendor_id?: string | null;
  vendor_name?: string | null;
  paid?: boolean | null;
  paid_date?: string | null;
  expense_date?: string | null;
  bank_account_id?: string | null;
  amount?: number | null;
  gst_paid?: number | null;
  bill_type?: string | null;
  currency?: string | null;
  fx_rate?: number | null;
  igst?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  line_items?: readonly { name?: string | null; qty?: number | null; amount?: number | null }[] | null;
}

/** True for a row the Zoho Books purchase import created. */
export function isZohoImportedExpense(e: StoredExpenseLike | null | undefined): boolean {
  return !!(e?.zoho_doc_id ?? "").trim();
}

/** May the category picker offer "Salaries" for this row? Only on edit: a Payroll row that is
 *  already Salaries, or a Zoho-imported row (salary paid outside Payroll). Never a new entry. */
export function salariesOffered(e: StoredExpenseLike | null | undefined): boolean {
  if (!e) return false;
  return e.category === "Salaries" || isZohoImportedExpense(e);
}

/** The patch fields keepUntouchedOnEdit looks at (a subset of the expenses Update type). */
export interface EditPatchLike {
  vendor_id?: string | null;
  vendor_name?: string | null;
  paid?: boolean | null;
  payment_method?: string | null;
  bank_account_id?: string | null;
  paid_date?: string | null;
  expense_date?: string | null;
  amount?: number | null;
  gst_paid?: number | null;
  bill_type?: string | null;
  currency?: string | null;
  fx_rate?: number | null;
  igst?: number | null;
  cgst?: number | null;
  sgst?: number | null;
  line_items?: readonly { name?: string | null; qty?: number | null; amount?: number | null }[] | null;
}

const sameLines = (a: EditPatchLike["line_items"], b: EditPatchLike["line_items"]): boolean => {
  const x = a ?? [], y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((l, i) =>
    (l.name ?? "") === (y[i].name ?? "") &&
    Number(l.qty ?? 1) === Number(y[i].qty ?? 1) &&
    Number(l.amount ?? 0) === Number(y[i].amount ?? 0));
};

/**
 * The Edit expense patch with every field the user did not change put back to what is stored.
 * - Stays unpaid: no payment method or bank is written — the stored ones stay. Paid → unpaid
 *   (review F1): both are cleared, an unpaid row carries no payment method.
 * - GST split (IGST/CGST/SGST): kept unless a bill was just read for it, or GST / bill type /
 *   vendor changed (review F2: another vendor can sit in another state — IGST vs CGST+SGST).
 * - Paid date: kept on a row that was and stays paid when its date is unchanged.
 * - Amount: kept when the items, GST, currency and rate are unchanged (an imported bill's amount
 *   can carry GST Zoho could not claim, which the item total does not show).
 */
export function keepUntouchedOnEdit<P extends EditPatchLike>(
  stored: StoredExpenseLike,
  patch: P,
  ctx: { gstHeadsFromBill: boolean; itemised: boolean },
): P {
  const out: P = { ...patch };
  if (out.paid === false) {
    out.payment_method = stored.paid ? null : (stored.payment_method ?? null);
    out.bank_account_id = stored.paid ? null : (stored.bank_account_id ?? null);
  }
  const gstSame = Number(out.gst_paid ?? 0) === Number(stored.gst_paid ?? 0) && (out.bill_type ?? null) === (stored.bill_type ?? null);
  const name = (v: string | null | undefined) => (v ?? "").trim().toLowerCase();
  const vendorSame = (out.vendor_id ?? null) === (stored.vendor_id ?? null) && name(out.vendor_name) === name(stored.vendor_name);
  if (!ctx.gstHeadsFromBill && gstSame && vendorSame) {
    out.igst = stored.igst ?? null;
    out.cgst = stored.cgst ?? null;
    out.sgst = stored.sgst ?? null;
  }
  if (stored.paid && out.paid && out.expense_date === stored.expense_date && stored.paid_date) {
    out.paid_date = stored.paid_date;
  }
  const fxSame = (out.currency ?? "INR") === (stored.currency ?? "INR") && Number(out.fx_rate ?? 1) === Number(stored.fx_rate ?? 1);
  if (ctx.itemised && gstSame && fxSame && sameLines(out.line_items, stored.line_items) && stored.amount != null) {
    out.amount = stored.amount;
  }
  return out;
}
