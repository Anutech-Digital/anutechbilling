/**
 * Input tax credit (ITC) on an expense — can this GST be claimed, and if not, why.
 *
 * 27 Sep 2026 audit (accounting #6, #7): every expense with `gst_paid > 0` was claimed as
 * input credit and the same GST was also left inside the P&L expense, so expenses were
 * overstated by the credit and the credit itself was claimed on bills that never qualify.
 *
 * What the law needs before a rupee of GST becomes credit (CGST Act s.16, s.17(5)):
 *   - a tax invoice from a registered supplier (bill_type = 'gst', supplier has a GSTIN);
 *     a kaccha bill or a bill from an unregistered vendor carries no credit, and the
 *     supplier must file it (GSTR-2B) — without a GSTIN nothing can ever match;
 *   - not a blocked category: food, beverages, club membership, health / life insurance of
 *     staff, gifts and free samples, personal use (s.17(5)).
 * GST that fails these stays a cost — it belongs in the expense, not in the credit.
 *
 * Pure: the pages (P&L, GST, Balance Sheet) and their tests share this one rule.
 */

/** Expense categories whose GST is blocked under s.17(5), with the reason shown. */
export const ITC_BLOCKED_CATEGORIES: Readonly<Record<string, string>> = {
  "Staff Welfare":      "s.17(5)(b) — food and beverages, staff health / club: no credit",
  "Business Promotion": "s.17(5)(h) — gifts and free samples: no credit",
};

export interface ItcInput {
  gst_paid: number | null | undefined;
  bill_type: string | null | undefined;      // 'gst' | 'kaccha' | 'none'
  category: string | null | undefined;
  /** The vendor's GSTIN, from the vendor master (expenses.vendor_id → vendors.gstin). */
  vendorGstin: string | null | undefined;
  /**
   * Kitni asli expense rows is row me judi hain (S17: SQL (bill_type, category, GSTIN) par
   * group karke bhejta hai, gst_paid unka jod). Na ho to 1. Sirf `count` par asar.
   */
  n?: number;
}

export interface ItcVerdict {
  eligible: boolean;
  /** Why not — null when eligible or when there is no GST on the row at all. */
  reason: string | null;
}

const GSTIN_RE = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export function isGstin(v: string | null | undefined): boolean {
  return GSTIN_RE.test((v ?? "").trim().toUpperCase());
}

export function itcEligibility(e: ItcInput): ItcVerdict {
  if (!((e.gst_paid ?? 0) > 0)) return { eligible: false, reason: null };
  if (e.bill_type !== "gst") return { eligible: false, reason: "Not a GST tax invoice (kaccha / no bill) — no credit" };
  if (!isGstin(e.vendorGstin)) return { eligible: false, reason: "Vendor has no GSTIN — it will not match in GSTR-2B" };
  const blocked = ITC_BLOCKED_CATEGORIES[(e.category ?? "").trim()];
  if (blocked) return { eligible: false, reason: blocked };
  return { eligible: true, reason: null };
}

export interface ItcSplit {
  /** GST that can be claimed. */
  eligible: number;
  /** GST that stays a cost, by reason. */
  blocked: number;
  blockedByReason: { reason: string; amount: number; count: number }[];
}

/** Split a set of expenses' GST into claimable credit and cost. Whole rupees in, whole out. */
export function splitItc(rows: ItcInput[]): ItcSplit {
  let eligible = 0, blocked = 0;
  const by = new Map<string, { amount: number; count: number }>();
  for (const r of rows) {
    const g = Math.max(0, Math.round(r.gst_paid ?? 0));
    if (g === 0) continue;
    const v = itcEligibility(r);
    if (v.eligible) { eligible += g; continue; }
    blocked += g;
    const k = v.reason ?? "—";
    const cur = by.get(k) ?? { amount: 0, count: 0 };
    cur.amount += g; cur.count += r.n ?? 1;
    by.set(k, cur);
  }
  return {
    eligible, blocked,
    blockedByReason: [...by.entries()].map(([reason, v]) => ({ reason, ...v })).sort((a, b) => b.amount - a.amount),
  };
}
