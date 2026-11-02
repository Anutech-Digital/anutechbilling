/**
 * R-2263 (Design D3) — column budget of the /subscriptions desktop table.
 *
 * Measured 31 Oct at 1280×800 with the sidebar open (Anutech-HQ ZOHO-AUDIT design.md
 * row 3): the table needed ~1,435px but its card had ~944px, so Renewal, Status and the
 * row action sat behind a horizontal scroll — and Renewal is the day's work.
 *
 * Now 8 columns instead of 11: Started is the second line of the Renewal cell, Vendor is
 * a short badge inside the Plan cell, Seats and MRR share one cell, and the row action is
 * one ⋮ menu. With `table-fixed` the columns below keep their width; Customer and Plan
 * (width: null) share what is left and wrap — on a wider screen they grow.
 *
 * R-2382 (2 Nov): a 9th column, Payment, between Renewal and Status — still inside the
 * 944px budget (fixed 620 + 2 × 160).
 */
export type SubsColKey =
  | "select"
  | "customer"
  | "plan"
  | "seats_mrr"
  | "margin"
  | "renewal"
  | "payment"
  | "status"
  | "actions";

export const SUBS_TABLE_COLS: ReadonlyArray<{ key: SubsColKey; width: number | null }> = [
  { key: "select", width: 36 },
  { key: "customer", width: null },
  { key: "plan", width: null },
  { key: "seats_mrr", width: 108 },
  { key: "margin", width: 88 },
  { key: "renewal", width: 112 },
  /* R-2382: Payment (paid till / due since). Paid for by narrower MRR, Renewal and Status —
     the owed ₹ and its due chip moved out of Status into this column. */
  { key: "payment", width: 124 },
  { key: "status", width: 104 },
  { key: "actions", width: 48 },
];

/** Content width of the table's card at a 1280px viewport with the sidebar open. */
export const SUBS_TABLE_BUDGET_PX = 944;

/** The narrowest Customer / Plan may get at that width and still be readable. */
export const SUBS_FLEX_MIN_PX = 160;

/** Short vendor badge for the Plan cell — the full name is its accessible name + tooltip. */
export function vendorShort(v: string | null | undefined): { short: string; name: string; kind: "info" | "success" | "muted" } {
  const s = (v ?? "").toLowerCase();
  if (s === "google") return { short: "G", name: "Google", kind: "info" };
  if (s === "microsoft") return { short: "MS", name: "Microsoft", kind: "info" };
  if (s === "zoho") return { short: "Z", name: "Zoho", kind: "success" };
  if (!v) return { short: "—", name: "No vendor", kind: "muted" };
  const name = v.charAt(0).toUpperCase() + v.slice(1);
  return { short: name.slice(0, 2), name, kind: "muted" };
}
