/**
 * R-2408 — Payment Follow-up as a worklist: age tiles, search, owner filter, sort, the one
 * next-action per row, and the table's column budget. Pure — tested in worklist-r2408.test.ts.
 *
 * Audit 3 Nov (Anutech-HQ/drafts/COLLECTIONS-AUDIT/page-audit.md #1,2,3,7,11): 12 of 16 rows
 * were "Not due yet" mixed into the chase list; no split by age; no search/sort/filter; every
 * row ~110px tall from 4 stacked buttons.
 *
 * Age = the row's oldest line (CollectionRow.daysOverdue — an invoice past its due date, or a
 * renewal past its renewal date). A customer sits in ONE tile, so a tile's click shows exactly
 * the customers its count and ₹ add up, and the tiles add up to the list (same rule as the
 * Renewals tiles, R-2405). ₹ is the real amount due (amountDue); renewals not invoiced yet are
 * shown apart as "+ ₹X renewals" (R-2401: they are not money owed yet).
 */
import type { CollectionRow } from "@/lib/queries/collections";

export const AGE_KEYS = ["overdue", "d30", "d60", "d90", "d90plus", "notDue"] as const;
export type AgeKey = (typeof AGE_KEYS)[number];
/** The list's age filter: a tile, or every row. */
export const AGE_VIEWS = ["overdue", "all", "d30", "d60", "d90", "d90plus", "notDue"] as const;
export type AgeView = (typeof AGE_VIEWS)[number];
/** Default: only money that is late — Not due yet has its own tile (card R-2408). */
export const DEFAULT_AGE: AgeView = "overdue";

export const AGE_LABEL: Record<AgeView, string> = {
  overdue: "Overdue",
  all: "All ages",
  d30: "1–30 days late",
  d60: "31–60 days late",
  d90: "61–90 days late",
  d90plus: "90+ days late",
  notDue: "Not due yet",
};

/** Which late-bucket a number of days falls in (0 or less = not due yet). */
export function ageBucket(days: number): Exclude<AgeKey, "overdue"> {
  if (days <= 0) return "notDue";
  if (days <= 30) return "d30";
  if (days <= 60) return "d60";
  if (days <= 90) return "d90";
  return "d90plus";
}

export function ageMatches(view: AgeView, r: Pick<CollectionRow, "daysOverdue">): boolean {
  if (view === "all") return true;
  if (view === "overdue") return r.daysOverdue > 0;
  return ageBucket(r.daysOverdue) === view;
}

export interface AgeFigure {
  count: number;
  /** Real amount due, whole rupees. */
  amount: number;
  /** Renewals not invoiced yet, whole rupees (shown apart). */
  renewals: number;
}

export type AgeTiles = Record<AgeKey, AgeFigure>;

export function ageTiles(rows: readonly Pick<CollectionRow, "daysOverdue" | "amountDue" | "renewalAmount">[]): AgeTiles {
  const out = Object.fromEntries(AGE_KEYS.map((k) => [k, { count: 0, amount: 0, renewals: 0 }])) as AgeTiles;
  for (const r of rows) {
    const add = (f: AgeFigure) => { f.count += 1; f.amount += Math.round(r.amountDue); f.renewals += Math.round(r.renewalAmount); };
    add(out[ageBucket(r.daysOverdue)]);
    if (r.daysOverdue > 0) add(out.overdue);
  }
  return out;
}

// ─── Search / owner / sort ───────────────────────────────────────────────────

/** Customer name, or any invoice number / plan / domain on the row. Case-insensitive. */
export function matchesSearch(r: Pick<CollectionRow, "customerName" | "items" | "renewals">, q: string): boolean {
  const s = q.trim().toLowerCase();
  if (!s) return true;
  if (r.customerName.toLowerCase().includes(s)) return true;
  return [...r.items, ...r.renewals].some((i) => i.label.toLowerCase().includes(s) || i.id.toLowerCase().includes(s));
}

export const UNASSIGNED = "unassigned";
/** Who chases this row: the follow-up's assignee, else the account manager. */
export function ownerKey(r: Pick<CollectionRow, "assignedTo" | "ownerId">): string {
  return r.assignedTo ?? r.ownerId ?? UNASSIGNED;
}
/** The owners present on the list, for the owner filter (Unassigned last). */
export function ownerKeys(rows: readonly Pick<CollectionRow, "assignedTo" | "ownerId">[]): string[] {
  const keys = [...new Set(rows.map(ownerKey))];
  return [...keys.filter((k) => k !== UNASSIGNED).sort(), ...(keys.includes(UNASSIGNED) ? [UNASSIGNED] : [])];
}

export const SORT_KEYS = ["priority", "daysLate", "amount"] as const;
export type SortKey = (typeof SORT_KEYS)[number];
export const SORT_LABEL: Record<SortKey, string> = {
  priority: "Today's work first",
  daysLate: "Most days late",
  amount: "Biggest amount",
};

/**
 * "priority" keeps buildCollectionRows' order — R-2409 comparePriority: broken promises, then
 * follow-ups / promises due today, then the rest, each by ₹ due × days late.
 */
export function sortRows(rows: readonly CollectionRow[], sort: SortKey): CollectionRow[] {
  const out = [...rows];
  const name = (a: CollectionRow, b: CollectionRow) => a.customerName.localeCompare(b.customerName);
  if (sort === "daysLate") out.sort((a, b) => b.daysOverdue - a.daysOverdue || b.amountDue - a.amountDue || name(a, b));
  if (sort === "amount") out.sort((a, b) => b.amountDue - a.amountDue || b.renewalAmount - a.renewalAmount || name(a, b));
  return out;
}

export interface WorklistFilter {
  q: string;
  /** "" = everyone, else an ownerKey. */
  owner: string;
  age: AgeView;
  sort: SortKey;
}

export interface Worklist {
  /** Tiles over the rows that pass search + owner (every age). */
  tiles: AgeTiles;
  /** What the table shows. */
  shown: CollectionRow[];
  /** Totals of `shown`, whole rupees. */
  total: number;
  renewalTotal: number;
}

export function buildWorklist(rows: readonly CollectionRow[], f: WorklistFilter): Worklist {
  const base = rows.filter((r) => matchesSearch(r, f.q) && (!f.owner || ownerKey(r) === f.owner));
  const shown = sortRows(base.filter((r) => ageMatches(f.age, r)), f.sort);
  return {
    tiles: ageTiles(base),
    shown,
    total: shown.reduce((s, r) => s + Math.round(r.amountDue), 0),
    renewalTotal: shown.reduce((s, r) => s + Math.round(r.renewalAmount), 0),
  };
}

// ─── One next step per row ───────────────────────────────────────────────────

export type NextAction = "followup" | "pay" | "none";

/**
 * The row's one button: "Record payment" when money is expected today (the promise falls
 * today) and the person may record money; otherwise "Follow-up". A line with no customer record
 * cannot carry either.
 */
export function nextAction(
  r: Pick<CollectionRow, "customerId" | "amountDue" | "promiseStatus">,
  canPay: boolean,
): NextAction {
  if (!r.customerId) return "none";
  if (canPay && r.amountDue > 0 && r.promiseStatus === "due") return "pay";
  return "followup";
}

/** "No follow-up for 7+ days" counts only customers with a line that is actually late. */
export function hasOverdueLine(r: Pick<CollectionRow, "items">): boolean {
  return r.items.some((i) => i.daysOverdue > 0 && i.amountDue > 0);
}

/** Amount due cell: real dues, or — for a renewal-only row — its renewal amount (R-2401 rows showed "—"). */
export function amountCell(r: Pick<CollectionRow, "amountDue" | "renewalAmount">): { main: number; kind: "due" | "renewal"; extraRenewal: number } {
  if (r.amountDue > 0) return { main: Math.round(r.amountDue), kind: "due", extraRenewal: Math.round(r.renewalAmount) };
  return { main: Math.round(r.renewalAmount), kind: "renewal", extraRenewal: 0 };
}

// ─── Desktop table column budget ─────────────────────────────────────────────

/**
 * At 1280 with the sidebar open the page card is ~944px wide (measured for /subscriptions,
 * R-2263; same budget as Renewals R-2403). Fixed-width columns + the two flexible ones at their
 * minimum must fit inside it, the action column included.
 */
export const WORKLIST_TABLE_BUDGET_PX = 944;
/**
 * R-2413: the tick-box column (32px: 12px left pad + 16px box + 4px) was paid for by Promise to
 * pay 108→100, Next follow-up 96→88, Owner 96→88 (their longest content — "12 Nov 2026",
 * "₹1,23,456", a truncated name with a title — is ≤ 76px of text) and the two flexible columns'
 * floor 140→136. Before: 664 fixed + 2×140 = 944; after: 672 + 2×136 = 944.
 */
export const WORKLIST_FLEX_MIN_PX = 136;
export type WorklistColKey = "select" | "customer" | "owed" | "amount" | "late" | "promise" | "next" | "owner" | "action";
export const WORKLIST_COLS: ReadonlyArray<{ key: WorklistColKey; label: string; width: number | null; align: "left" | "right" }> = [
  { key: "select", label: "", width: 32, align: "left" },
  { key: "customer", label: "Customer", width: null, align: "left" },
  { key: "owed", label: "What's owed", width: null, align: "left" },
  { key: "amount", label: "Amount due", width: 100, align: "right" },
  { key: "late", label: "Overdue", width: 88, align: "left" },
  { key: "promise", label: "Promise to pay", width: 100, align: "left" },
  { key: "next", label: "Next follow-up", width: 88, align: "left" },
  { key: "owner", label: "Owner", width: 88, align: "left" },
  { key: "action", label: "Action", width: 176, align: "left" },
];

/** R-2413: the tick-box column only for people who may act on many rows (bulk-actions mayBulkCollect). */
export function worklistCols(withSelect: boolean): typeof WORKLIST_COLS {
  return withSelect ? WORKLIST_COLS : WORKLIST_COLS.filter((c) => c.key !== "select");
}
