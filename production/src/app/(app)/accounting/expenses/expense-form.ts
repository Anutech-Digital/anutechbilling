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
