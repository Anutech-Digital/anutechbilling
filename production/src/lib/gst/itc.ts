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

/**
 * R-2056 (28 Oct 2026) — a foreign online-service provider (OIDAR: e.g. a US SaaS / AI vendor)
 * has its own GSTIN layout: 99 (state code "other countries") + 2-digit year + 3-letter
 * country + 5-digit serial + "OS" + check character. Taken from GSTN's API portal
 * (developer.gst.gov.in/apiportal/taxpayer/returns, gstin(OIDAR) "REGEX_7":
 * [9][9][0-9]{2}[a-zA-Z]{3}[0-9]{5}[O][S][0-9a-zA-Z]{1}, sample 9918IND29061OSS).
 * Such a supplier files GSTR-5A, not GSTR-1, so its GST never shows in our GSTR-2B.
 */
const OIDAR_GSTIN_RE = /^99[0-9]{2}[A-Z]{3}[0-9]{5}OS[0-9A-Z]$/;

/** R-2056: upper-case, spaces / dashes / dots removed — "07 ABCDE-1234F1Z5" → "07ABCDE1234F1Z5". */
export function normalizeGstin(v: string | null | undefined): string {
  return (v ?? "").toString().replace(/[\s.\-]+/g, "").toUpperCase();
}

/** A domestic (regular / composition) GSTIN — the kind that matches in GSTR-2B. */
export function isGstin(v: string | null | undefined): boolean {
  return GSTIN_RE.test(normalizeGstin(v));
}

/** A foreign online-service provider's (OIDAR) GSTIN. */
export function isOidarGstin(v: string | null | undefined): boolean {
  return OIDAR_GSTIN_RE.test(normalizeGstin(v));
}

/** Why a vendor GSTIN gives no GSTR-2B match: nothing typed, a wrong format, or an OIDAR one. null = fine. */
export type GstinIssue = "empty" | "invalid" | "oidar";
export function gstinIssue(v: string | null | undefined): GstinIssue | null {
  const g = normalizeGstin(v);
  if (!g) return "empty";
  if (GSTIN_RE.test(g)) return null;
  if (OIDAR_GSTIN_RE.test(g)) return "oidar";
  return "invalid";
}

/** The words for each GSTIN issue — Add bill / Add expense and the GST page's "Blocked ITC" list. */
export const GSTIN_ISSUE_REASON: Readonly<Record<GstinIssue, string>> = {
  empty:   "Vendor GSTIN box is empty — without a GSTIN it will not match in GSTR-2B",
  invalid: "This GSTIN looks wrong (15 characters, no spaces) — it will not match in GSTR-2B",
  /* Wording from the card (R-2056); the ITC / reverse-charge position is for Hitesh / the CA to confirm. */
  oidar:   "Foreign online service (OIDAR) GSTIN — this GST is not in GSTR-2B, so it goes to cost. " +
           "Add your GSTIN in the vendor's billing settings so future bills are B2B (you pay GST under reverse charge and claim it)",
};

export function itcEligibility(e: ItcInput): ItcVerdict {
  if (!((e.gst_paid ?? 0) > 0)) return { eligible: false, reason: null };
  if (e.bill_type !== "gst") return { eligible: false, reason: "Not a GST tax invoice (kaccha / no bill) — no credit" };
  const issue = gstinIssue(e.vendorGstin);
  if (issue) return { eligible: false, reason: GSTIN_ISSUE_REASON[issue] };
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
