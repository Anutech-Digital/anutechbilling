/**
 * R-2181 (G-ZOHO Wave 1, 31 Oct 2026) — what a P&L row's drill-down lists, and the check that
 * its total equals the number clicked.
 *
 * Found by the Zoho Books audit: the product rows under Revenue ("Microsoft 365", "Google
 * Workspace", …) and the vendor rows under Licence cost all opened EVERY document of the
 * period, and Revenue was listed GST-inclusive with fully credited invoices at full value — so
 * the drill total never matched the row. Zoho: "every report number drills to exactly the
 * transactions behind it".
 *
 *   Revenue → SQL `report_pnl_revenue_lines` (the same rows report_pnl_revenue_by_product adds
 *             up): ex-GST, one row per invoice / credit note (−) / debit note per family.
 *   Licence cost → vendor bills of the row's vendor at what report_pnl counts (pre-GST subtotal
 *             + the GST that is not credit, R-1576) + the R-2095 estimate parts of that vendor.
 *
 * The family / vendor of a row is never re-decided here: revenue families come from SQL
 * `revenue_family()`, a bill's vendor from `vendorOfCogsCategory` (the P&L's own rule).
 */
import { vendorOfCogsCategory } from "@/lib/accounting/pnl";
import { splitBillItc } from "@/lib/gst/bill-itc";
import { rupee } from "@/lib/utils";
import { licenceEstimates, periodName, type LicenceEstimate, type LicenceSource, type SubLine } from "@/lib/accounting/pnl-compare";
import { serviceBasisLabel, type MatchedBill } from "@/lib/accounting/pnl-basis";

export type PnLDrillKind = "revenue" | "cogs" | "expenses";

/** What a click on the P&L opens. Only `kind` → the whole line (old behaviour for expenses). */
export interface PnLDrillTarget {
  kind: PnLDrillKind;
  /** The row's name, for the title and the footer ("Microsoft 365"). */
  label?: string;
  /** The amount on the row clicked — the drill total must equal it. Absent → no tie check. */
  expected?: number | null;
  /** Revenue: only these product families (SQL revenue_family). Absent = every family. */
  families?: string[];
  /** Revenue on an older split (R-1833 "Subscriptions, licences & other sales"): all but these. */
  excludeFamilies?: string[];
  /** Licence cost: only bills of these vendors; "other" = a COGS bill of no subscription vendor. */
  vendors?: string[];
  /** Licence cost: the estimated parts (no bill yet) listed as their own rows. */
  estimates?: LicenceEstimate[];
  /** Cost of goods card: the project delivery cost it includes (salary on projects), as one row. */
  projectCost?: number;
  /** Expenses: one category. */
  category?: string | null;
}

export interface DrillRow {
  id: string;
  date: string;
  primary: string;
  sub: string;
  amount: number;
  /** An estimate row (no document behind it). */
  estimated?: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── Which documents a statement sub-line opens ─────────────────────────────────────────

const familyOfKey = (key: string) => (key.startsWith("rev:") ? key.slice(4) : null);
const vendorOfKey = (key: string) => (key.startsWith("lic:") ? key.slice(4) : null);

/** A Revenue sub-line (R-1835 family, R-1833 fallback, or the rolled-up "Other") → its drill. */
export function revenueLineTarget(line: Pick<SubLine, "key" | "label" | "now" | "members">): PnLDrillTarget {
  const base = { kind: "revenue" as const, label: line.label, expected: line.now };
  const keys = line.key === "other" ? line.members ?? [] : [line.key];
  const fams = keys.map(familyOfKey).filter((f): f is string => !!f);
  if (fams.includes("all")) return base;
  if (fams.length === 1 && fams[0] === "sales") return { ...base, excludeFamilies: ["projects"] };
  return { ...base, families: fams };
}

/** A Licence-cost sub-line → that vendor's bills + its estimated part. */
export function licenceLineTarget(
  line: Pick<SubLine, "key" | "label" | "now" | "members">,
  estimates: readonly LicenceEstimate[],
): PnLDrillTarget {
  const keys = line.key === "other" ? line.members ?? [] : [line.key];
  const vendors = keys.map(vendorOfKey).filter((v): v is string => !!v).map((v) => (v === "other-bills" ? "other" : v));
  return {
    kind: "cogs", label: line.label, expected: line.now,
    vendors,
    estimates: estimates.filter((e) => vendors.includes(e.vendor)),
  };
}

/**
 * A headline line (card, statement line, waterfall bar) → its drill. Revenue: every family, at
 * the Revenue figure. Cost of goods: every licence bill + every estimated part (+ the project
 * delivery cost when the card includes it), at the figure clicked.
 */
export function lineTarget(
  kind: PnLDrillKind,
  d: LicenceSource,
  opts: { licenceOnly?: boolean } = {},
): PnLDrillTarget {
  const m = d.model;
  if (kind === "revenue") return { kind, label: "Revenue", expected: m.revenue };
  if (kind === "cogs") {
    const known = m.cogsBasis !== "unknown";
    const project = !opts.licenceOnly && !m.projectCostHidden && m.projectCost > 0 ? m.projectCost : 0;
    return {
      kind,
      label: opts.licenceOnly || project === 0 ? "Licence cost" : "Cost of goods",
      expected: known ? (opts.licenceOnly ? m.licenceCogs : m.licenceCogs + project) : null,
      estimates: licenceEstimates(d),
      projectCost: project,
    };
  }
  return { kind };
}

// ─── Rows ──────────────────────────────────────────────────────────────────────────────

/** A row of SQL `report_pnl_revenue_lines`. `amount` is ex-GST, a credit note negative. */
export interface RevenueLineRow {
  doc_kind: "invoice" | "credit_note" | "debit_note" | string;
  doc_id: string;
  invoice_id: string;
  customer_name: string | null;
  doc_date: string;
  status: string | null;
  family: string;
  amount: number;
}

/**
 * The Revenue drill's rows: one per document (a mixed invoice's families added back together when
 * the whole line is open), only the families asked for. A fully credited invoice and its credit
 * note net to ₹0.
 */
export function revenueDrillRows(lines: readonly RevenueLineRow[], t: Pick<PnLDrillTarget, "families" | "excludeFamilies">): DrillRow[] {
  const want = t.families && t.families.length > 0 ? new Set(t.families) : null;
  const skip = new Set(t.excludeFamilies ?? []);
  const byDoc = new Map<string, DrillRow>();
  for (const l of lines) {
    if (want && !want.has(l.family)) continue;
    if (skip.has(l.family)) continue;
    const id = `${l.doc_kind}:${l.doc_id}`;
    const cur = byDoc.get(id);
    if (cur) { cur.amount = r2(cur.amount + Number(l.amount)); continue; }
    const sub = l.doc_kind === "credit_note" ? `${l.doc_id} · credit note on ${l.invoice_id}`
      : l.doc_kind === "debit_note" ? `${l.doc_id} · debit note on ${l.invoice_id}`
      : `${l.doc_id} · ${l.status ?? "invoice"}`;
    byDoc.set(id, { id, date: l.doc_date, primary: l.customer_name || "Customer", sub, amount: Number(l.amount) || 0 });
  }
  return [...byDoc.values()];
}

/** A vendor bill as the drill reads it. */
export interface CogsBillRow {
  id: string;
  vendor_name: string | null;
  bill_no: string | null;
  bill_date: string;
  subtotal: number | null;
  category: string | null;
  cgst: number | null;
  sgst: number | null;
  igst: number | null;
  document_type: string | null;
  vendor_gstin: string | null;
}

/**
 * The Licence-cost drill's rows: each COGS bill at what report_pnl counts — pre-GST subtotal plus
 * its GST that is not credit (R-1576, `billedByVendor`) — only the vendors asked for, then one row
 * per estimated part (R-2095), so the rows add up to the line.
 */
export function cogsDrillRows(
  bills: readonly CogsBillRow[],
  t: Pick<PnLDrillTarget, "vendors" | "estimates" | "projectCost">,
  ownStateCode: string | null,
  range: { to: string },
): DrillRow[] {
  const want = t.vendors && t.vendors.length > 0 ? new Set(t.vendors) : null;
  const rows: DrillRow[] = [];
  for (const b of bills) {
    const vendor = vendorOfCogsCategory(b.category) ?? "other";
    if (want && !want.has(vendor)) continue;
    const blocked = splitBillItc([{ ...b, ownStateCode }]).blocked;
    rows.push({
      id: b.id,
      date: b.bill_date,
      primary: b.vendor_name || "Vendor",
      sub: [b.category?.replace(/^COGS-/, ""), b.bill_no, blocked > 0 ? "incl. GST not claimable" : null].filter(Boolean).join(" · "),
      amount: r2((Number(b.subtotal) || 0) + blocked),
    });
  }
  for (const e of t.estimates ?? []) {
    rows.push({
      id: `estimate:${e.vendor}`,
      date: range.to,
      primary: e.label,
      sub: "Estimated — no vendor bill yet",
      amount: e.amount,
      estimated: true,
    });
  }
  if ((t.projectCost ?? 0) > 0) {
    rows.push({
      id: "project-cost",
      date: range.to,
      primary: "Project delivery cost",
      sub: "Salary on customer projects + project expenses (see the project cost line)",
      amount: t.projectCost ?? 0,
    });
  }
  return rows;
}

/**
 * R-2622: the Management (matched) view's Licence-cost drill — the bills placed in this period by
 * their SERVICE month (report_pnl_cogs_matched, R-2156): each at the part that falls in the range,
 * with its service period and how that month was decided (a month misread from the bill text is
 * visible at once). GST that cannot be claimed stays on the bill DATE in both views, so each bill
 * dated in the range with such GST is its own row. Then the estimate rows and the project cost,
 * as in the GST view — the rows add up to the line.
 */
export function matchedCogsDrillRows(
  matched: readonly MatchedBill[],
  billsByDate: readonly CogsBillRow[],
  t: Pick<PnLDrillTarget, "vendors" | "estimates" | "projectCost">,
  ownStateCode: string | null,
  range: { to: string },
): DrillRow[] {
  const want = t.vendors && t.vendors.length > 0 ? new Set(t.vendors) : null;
  /* Which statement line each row belongs to — the same rule as billedByVendor + licenceItems:
     a vendor's line = its matched bills + the non-claimable GST of ITS categories that have a
     matched bill in the range; a vendor whose total is 0 or less has no line of its own and, like
     COGS-Other and GST of a category with no matched bill, sits in "Other vendor bills". */
  const matchedCategories = new Set(matched.map((b) => b.category));
  const tagged: { vendor: string; row: DrillRow }[] = [];
  for (const b of matched) {
    const part = Number(b.amount) !== Number(b.subtotal) ? `part of the ${rupee(Number(b.subtotal))} bill` : null;
    tagged.push({
      vendor: vendorOfCogsCategory(b.category) ?? "other",
      row: {
        id: b.id,
        date: b.bill_date,
        primary: b.vendor_name || "Vendor",
        sub: [b.category?.replace(/^COGS-/, ""), b.bill_no, `for ${periodName({ from: b.service_from, to: b.service_to })}`,
              serviceBasisLabel(b.basis), part].filter(Boolean).join(" · "),
        amount: r2(Number(b.amount) || 0),
      },
    });
  }
  for (const b of billsByDate) {
    const blocked = splitBillItc([{ ...b, ownStateCode }]).blocked;
    if (!(blocked > 0)) continue;
    tagged.push({
      vendor: matchedCategories.has(b.category) ? (vendorOfCogsCategory(b.category) ?? "other") : "other",
      row: {
        id: `gst:${b.id}`,
        date: b.bill_date,
        primary: b.vendor_name || "Vendor",
        sub: [b.bill_no, "GST not claimable (counted on the bill date)"].filter(Boolean).join(" · "),
        amount: r2(blocked),
      },
    });
  }
  const vendorTotal = new Map<string, number>();
  for (const x of tagged) vendorTotal.set(x.vendor, (vendorTotal.get(x.vendor) ?? 0) + x.row.amount);
  const lineOf = (vendor: string) => (vendor !== "other" && (vendorTotal.get(vendor) ?? 0) > 0 ? vendor : "other");
  /* assemblePnl counts bills only when their total is above 0 (`cogs > 0 ? cogs : null`) — a month that
     nets to a credit shows no billed cost on the card, so the drill lists none either. */
  const billedTotal = tagged.reduce((sum, x) => sum + x.row.amount, 0);
  const rows = billedTotal > 0 ? tagged.filter((x) => !want || want.has(lineOf(x.vendor))).map((x) => x.row) : [];
  return [...rows, ...cogsDrillRows([], t, ownStateCode, range)];
}

// ─── The tie ───────────────────────────────────────────────────────────────────────────

/** Does the drill total equal the row clicked? `diff` = total − expected. */
export function drillTie(total: number, expected: number | null | undefined): { ties: boolean; diff: number } | null {
  if (expected === null || expected === undefined) return null;
  const diff = r2(total - expected);
  return { ties: Math.abs(diff) < 0.5, diff };
}
