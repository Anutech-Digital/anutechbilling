/**
 * R-1869 — ONE filter system for a bank account's lines (/accounting/banking/[id]).
 *
 * Pardeep (24 Oct): "transaction ko filter karne ka bhi option hona chahiye jaise reconcile
 * transaction, debit transaction or credit transaction, aur jo bhi behtar ho sake". R-1863 and the
 * vendor-pay cards were each adding one more button; they all live here now as one filter state:
 *
 *   status  — All / Unmatched / Reconciled (the tabs)
 *   dir     — All · Money in (credits) · Money out (debits)
 *   from/to — date range (presets: This month, Last month, This FY)
 *   min/max/exact — amount (whole rupees; exact wins over the range)
 *   types   — matched to (groups of bank_transactions.matched_to_type)
 *   need    — needs attention (no customer yet, no vendor yet, old one-off bookings, possible
 *             duplicates, large amounts)
 *   imp     — which statement import the line came from (Imports list key)
 *   sort, q — order and the search box
 *
 * Pure: no React, no client. The page passes the sets it already computes (R-1863's
 * isNoCustomerYet list, the old one-off bookings, the lines of each import) in `ctx`; this file
 * never re-derives them, so there is one rule per filter.
 *
 * WHY IN THE BROWSER, NOT A SECOND SERVER QUERY: the page already reads every line of the account
 * once, paged by 1000 (R-1509 fetchBankTransactions) — Balance in bank, the statement check, the
 * Imports list and the salary lines all need the full list. Filtering that list is one pass over
 * ~1,500 rows (well under a millisecond); a filtered server query would be a second read of the
 * same rows. What WAS slow is drawing 1,449 table rows at once — the page shows them in pages
 * ("Load more"), see PAGE_SIZE.
 */
import { bankTxnBalanceKey, bankTxnKey } from "@/lib/queries/bank";
import { fyStartISO, utcDateISO } from "@/lib/dates/ist";
import { formatDate, rupee } from "@/lib/utils";

// ─── Types ─────────────────────────────────────────────────────────────────

export type StatusFilter = "all" | "unmatched" | "matched";
export type Direction = "all" | "in" | "out";
export type SortKey = "newest" | "oldest" | "high" | "low";
export type MatchGroup = "customer" | "vendor" | "salary" | "expense" | "tax" | "owner" | "loan" | "transfer" | "other";
export type NeedKey = "no_customer" | "no_vendor" | "old_one_off" | "duplicates" | "large";
/** The needs-attention lists the PAGE works out (its own rules) and hands in. */
export type PageNeedKey = "no_customer" | "no_vendor" | "old_one_off";
export type DatePreset = "this_month" | "last_month" | "this_fy";

export type BankFilters = {
  status: StatusFilter;
  dir: Direction;
  from: string | null;
  to: string | null;
  min: number | null;
  max: number | null;
  exact: number | null;
  types: MatchGroup[];
  need: NeedKey | null;
  imp: string | null;
  sort: SortKey;
  q: string;
};

/** The bank-line fields the filters read (BankTransactionRow has them all). */
export type FilterLine = {
  id: string;
  txn_date: string;
  description: string;
  reference: string | null;
  debit: number;
  credit: number;
  balance_after: number | null;
  matched_to_type: string | null;
};

export type FilterContext = {
  /** Line ids per page-computed needs-attention list. A list not given matches nothing. */
  sets?: Partial<Record<PageNeedKey, ReadonlySet<string>>>;
  /** Line ids per import key (lib/banking/import-history importKey). */
  importLines?: ReadonlyMap<string, ReadonlySet<string>>;
};

export const DEFAULT_FILTERS: BankFilters = {
  status: "all", dir: "all", from: null, to: null, min: null, max: null, exact: null,
  types: [], need: null, imp: null, sort: "newest", q: "",
};

/** Lines drawn per "Load more". */
export const PAGE_SIZE = 100;
/** "Large amounts" starts here (whole rupees). */
export const LARGE_AMOUNT = 100_000;

export const MATCH_GROUPS: readonly MatchGroup[] = ["customer", "vendor", "salary", "expense", "tax", "owner", "loan", "transfer", "other"];
export const MATCH_GROUP_LABEL: Record<MatchGroup, string> = {
  customer: "Customer payment",
  vendor:   "Vendor bill / payment",
  salary:   "Salary",
  expense:  "Expense",
  tax:      "Tax / statutory",
  owner:    "Owner drawings / capital",
  loan:     "Loan / EMI",
  transfer: "Transfer between accounts",
  other:    "Other",
};

export const NEED_KEYS: readonly NeedKey[] = ["no_customer", "no_vendor", "old_one_off", "duplicates", "large"];
export const NEED_LABEL: Record<NeedKey, string> = {
  no_customer: "Money in · no customer yet",
  no_vendor:   "Money out · no vendor yet",
  old_one_off: "Old one-off bookings",
  duplicates:  "Possible duplicates",
  large:       "Large amounts (≥ ₹1,00,000)",
};

export const SORT_LABEL: Record<SortKey, string> = {
  newest: "Date: newest first",
  oldest: "Date: oldest first",
  high:   "Amount: high to low",
  low:    "Amount: low to high",
};

export const DATE_PRESET_LABEL: Record<DatePreset, string> = {
  this_month: "This month",
  last_month: "Last month",
  this_fy:    "This FY",
};

// ─── Small helpers ─────────────────────────────────────────────────────────

/** The line's amount, whichever side it is on. */
export function amountOf(t: Pick<FilterLine, "debit" | "credit">): number {
  return (t.debit ?? 0) > 0 ? t.debit : (t.credit ?? 0);
}

/**
 * Which "Matched to" group a matched_to_type belongs to. New types (a later migration) fall to
 * Other until they get a group here — they are never hidden.
 */
export function matchGroupOf(type: string | null): MatchGroup | null {
  if (type === null) return null;
  switch (type) {
    case "payment": case "project":                 return "customer";
    case "vendor_bill": case "vendor_payment":      return "vendor";
    case "salary": case "split":                    return "salary";
    case "expense": case "prepaid":                 return "expense";
    case "statutory":                               return "tax";
    case "owner_equity":                            return "owner";
    case "transfer":                                return "transfer";
  }
  if (/loan|emi/.test(type)) return "loan";
  return "other";
}

/** The status word a line shows (and the CSV writes). */
export function lineStatusLabel(type: string | null): string {
  const g = matchGroupOf(type);
  if (g === null) return "Unmatched";
  if (type === "split") return "Salary";
  return g === "other" ? "Reconciled" : MATCH_GROUP_LABEL[g];
}

/**
 * Lines that may be in the account twice — the same rule the importer skips duplicates by
 * (lib/queries/bank splitNewBankLines): two lines with the same date + amount + running balance,
 * or (when one has no balance) the same date + amount + narration prefix. Two real ₹500 payments
 * on one day differ in running balance, so they are NOT flagged.
 */
export function possibleDuplicateIds(lines: readonly FilterLine[]): Set<string> {
  const out = new Set<string>();
  const byPrefix = new Map<string, FilterLine[]>();
  for (const l of lines) {
    const k = bankTxnKey(l);
    const g = byPrefix.get(k);
    if (g) g.push(l); else byPrefix.set(k, [l]);
  }
  const byBal = new Map<string, FilterLine[]>();
  for (const l of lines) {
    const k = bankTxnBalanceKey(l);
    if (!k) continue;
    const g = byBal.get(k);
    if (g) g.push(l); else byBal.set(k, [l]);
  }
  for (const g of byBal.values()) if (g.length > 1) for (const l of g) out.add(l.id);
  for (const g of byPrefix.values()) {
    if (g.length < 2 || !g.some((l) => l.balance_after == null)) continue;
    for (const l of g) out.add(l.id);
  }
  return out;
}

// ─── Filtering ─────────────────────────────────────────────────────────────

type Facet = "status" | "dir" | "types";

function lineMatches(
  t: FilterLine,
  f: BankFilters,
  ctx: FilterContext,
  dupes: () => Set<string>,
  skip: Facet | null,
): boolean {
  if (skip !== "status") {
    if (f.status === "unmatched" && t.matched_to_type !== null) return false;
    if (f.status === "matched" && t.matched_to_type === null) return false;
  }
  if (skip !== "dir") {
    if (f.dir === "in" && !((t.credit ?? 0) > 0)) return false;
    if (f.dir === "out" && !((t.debit ?? 0) > 0)) return false;
  }
  const d = (t.txn_date ?? "").slice(0, 10);
  if (f.from && d < f.from) return false;
  if (f.to && d > f.to) return false;
  const amt = amountOf(t);
  if (f.exact !== null) {
    if (Math.round(amt) !== Math.round(f.exact)) return false;
  } else {
    if (f.min !== null && amt < f.min) return false;
    if (f.max !== null && amt > f.max) return false;
  }
  if (skip !== "types" && f.types.length > 0) {
    const g = matchGroupOf(t.matched_to_type);
    if (g === null || !f.types.includes(g)) return false;
  }
  if (f.need) {
    if (f.need === "large") { if (amt < LARGE_AMOUNT) return false; }
    else if (f.need === "duplicates") { if (!dupes().has(t.id)) return false; }
    else if (!ctx.sets?.[f.need]?.has(t.id)) return false;
  }
  if (f.imp && !ctx.importLines?.get(f.imp)?.has(t.id)) return false;
  const q = f.q.trim().toLowerCase();
  if (q && ![t.description, t.reference, String(t.debit ?? ""), String(t.credit ?? "")]
    .some((v) => (v ?? "").toString().toLowerCase().includes(q))
    && !amountSearchMatches(q, t)) return false;
  return true;
}

/**
 * R-2097: an amount typed the way it is written — "2,950", "₹2,950", "Rs 2,950.00" — finds the
 * line just as "2950" does. ₹ / Rs / INR / commas / spaces are dropped; whole digits match the
 * amount as a substring (the old "2950" behaviour), and a figure with paise matches it exactly.
 */
function amountSearchMatches(q: string, t: FilterLine): boolean {
  const bare = q.replace(/₹|\brs\.?|\binr\b|[,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(bare)) return false;
  const amounts = [t.debit, t.credit].map((v) => Number(v ?? 0)).filter((v) => v > 0);
  if (bare.includes(".")) {
    const want = Math.round(Number(bare) * 100);
    return amounts.some((a) => Math.round(a * 100) === want);
  }
  return amounts.some((a) => String(a).includes(bare));
}

function lazyDupes(lines: readonly FilterLine[], f: BankFilters): () => Set<string> {
  let cache: Set<string> | null = null;
  return () => (cache ??= f.need === "duplicates" ? possibleDuplicateIds(lines) : new Set());
}

function compare(f: BankFilters) {
  const byDate = (a: FilterLine, b: FilterLine) =>
    a.txn_date < b.txn_date ? -1 : a.txn_date > b.txn_date ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  switch (f.sort) {
    case "oldest": return byDate;
    case "high":   return (a: FilterLine, b: FilterLine) => amountOf(b) - amountOf(a) || -byDate(a, b);
    case "low":    return (a: FilterLine, b: FilterLine) => amountOf(a) - amountOf(b) || -byDate(a, b);
    default:       return (a: FilterLine, b: FilterLine) => -byDate(a, b);
  }
}

/** The lines that pass every filter, in the chosen order. The input list is not changed. */
export function applyBankFilters<T extends FilterLine>(lines: readonly T[], f: BankFilters, ctx: FilterContext = {}): T[] {
  const dupes = lazyDupes(lines, f);
  return lines.filter((t) => lineMatches(t, f, ctx, dupes, null)).sort(compare(f));
}

export type FacetCounts = {
  status: Record<StatusFilter, number>;
  dir: Record<Direction, number>;
  types: Record<MatchGroup, number>;
  need: Record<NeedKey, number>;
};

/**
 * Counts for the tabs and chips: each one counts under every OTHER filter, so "Unmatched (12)"
 * is what you get when you press it with the current direction, dates and search.
 */
export function facetCounts(lines: readonly FilterLine[], f: BankFilters, ctx: FilterContext = {}): FacetCounts {
  const dupesAll = possibleDuplicateIds(lines);
  const dupes = () => dupesAll;
  const c: FacetCounts = {
    status: { all: 0, unmatched: 0, matched: 0 },
    dir: { all: 0, in: 0, out: 0 },
    types: { customer: 0, vendor: 0, salary: 0, expense: 0, tax: 0, owner: 0, loan: 0, transfer: 0, other: 0 },
    need: { no_customer: 0, no_vendor: 0, old_one_off: 0, duplicates: 0, large: 0 },
  };
  const noNeed: BankFilters = { ...f, need: null };
  for (const t of lines) {
    if (lineMatches(t, f, ctx, dupes, "status")) {
      c.status.all += 1;
      c.status[t.matched_to_type === null ? "unmatched" : "matched"] += 1;
    }
    if (lineMatches(t, f, ctx, dupes, "dir")) {
      c.dir.all += 1;
      if ((t.credit ?? 0) > 0) c.dir.in += 1;
      if ((t.debit ?? 0) > 0) c.dir.out += 1;
    }
    if (lineMatches(t, f, ctx, dupes, "types")) {
      const g = matchGroupOf(t.matched_to_type);
      if (g) c.types[g] += 1;
    }
    if (lineMatches(t, noNeed, ctx, dupes, null)) {
      if (amountOf(t) >= LARGE_AMOUNT) c.need.large += 1;
      if (dupesAll.has(t.id)) c.need.duplicates += 1;
      for (const k of ["no_customer", "no_vendor", "old_one_off"] as const) if (ctx.sets?.[k]?.has(t.id)) c.need[k] += 1;
    }
  }
  return c;
}

// ─── Totals ────────────────────────────────────────────────────────────────

export type FilterTotals = { count: number; moneyIn: number; moneyOut: number; net: number };

/** "N lines · In ₹X · Out ₹Y · Net ₹Z" for the lines on screen (all pages, not just the drawn ones). */
export function filterTotals(lines: readonly Pick<FilterLine, "debit" | "credit">[]): FilterTotals {
  // Sum in paise so a statement with paise does not leave 0.30000000000000004.
  let inP = 0, outP = 0;
  for (const t of lines) {
    inP += Math.round((t.credit ?? 0) * 100);
    outP += Math.round((t.debit ?? 0) * 100);
  }
  return { count: lines.length, moneyIn: inP / 100, moneyOut: outP / 100, net: (inP - outP) / 100 };
}

// ─── URL ───────────────────────────────────────────────────────────────────

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v: string | null): v is string => !!v && ISO_DATE.test(v) && !isNaN(Date.parse(`${v}T00:00:00Z`))
  && utcDateISO(new Date(`${v}T00:00:00Z`)) === v;
const num = (v: string | null): number | null => {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
};
function oneOf<T extends string>(v: string | null, all: readonly T[], dflt: T): T;
function oneOf<T extends string>(v: string | null, all: readonly T[], dflt: null): T | null;
function oneOf<T extends string>(v: string | null, all: readonly T[], dflt: T | null): T | null {
  return v !== null && (all as readonly string[]).includes(v) ? (v as T) : dflt;
}

/** The query string for a filter state — only what differs from the default. */
export function filtersToQuery(f: BankFilters): URLSearchParams {
  const p = new URLSearchParams();
  if (f.status !== "all") p.set("status", f.status);
  if (f.dir !== "all") p.set("dir", f.dir);
  if (f.from) p.set("from", f.from);
  if (f.to) p.set("to", f.to);
  if (f.min !== null) p.set("min", String(f.min));
  if (f.max !== null) p.set("max", String(f.max));
  if (f.exact !== null) p.set("amt", String(f.exact));
  if (f.types.length) p.set("types", f.types.join(","));
  if (f.need) p.set("need", f.need);
  if (f.imp) p.set("imp", f.imp);
  if (f.sort !== "newest") p.set("sort", f.sort);
  if (f.q.trim()) p.set("q", f.q);
  return p;
}

/** Read a filter state back from a (possibly hand-edited) query string. Junk → default, never throws. */
export function filtersFromQuery(p: URLSearchParams): BankFilters {
  const types = (p.get("types") ?? "").split(",").filter((t): t is MatchGroup => (MATCH_GROUPS as readonly string[]).includes(t));
  const from = p.get("from"), to = p.get("to");
  return {
    status: oneOf(p.get("status"), ["all", "unmatched", "matched"] as const, "all"),
    dir:    oneOf(p.get("dir"), ["all", "in", "out"] as const, "all"),
    from:   isDate(from) ? from : null,
    to:     isDate(to) ? to : null,
    min:    num(p.get("min")),
    max:    num(p.get("max")),
    exact:  num(p.get("amt")),
    types:  [...new Set(types)],
    need:   oneOf(p.get("need"), NEED_KEYS, null),
    imp:    p.get("imp") || null,
    sort:   oneOf(p.get("sort"), ["newest", "oldest", "high", "low"] as const, "newest"),
    q:      p.get("q") ?? "",
  };
}

// ─── Date presets ──────────────────────────────────────────────────────────

const pad2 = (n: number) => String(n).padStart(2, "0");
const lastDay = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12

/** from/to for a preset, given today's IST date (lib/dates/ist istToday). */
export function datePreset(preset: DatePreset, todayIso: string): { from: string; to: string } {
  let y = Number(todayIso.slice(0, 4)), m = Number(todayIso.slice(5, 7));
  if (preset === "this_fy") {
    const from = fyStartISO(todayIso);
    return { from, to: `${Number(from.slice(0, 4)) + 1}-03-31` };
  }
  if (preset === "last_month") { m -= 1; if (m === 0) { m = 12; y -= 1; } }
  return { from: `${y}-${pad2(m)}-01`, to: `${y}-${pad2(m)}-${pad2(lastDay(y, m))}` };
}

// ─── Chips ─────────────────────────────────────────────────────────────────

/** A removable chip's key: "status", "dir", "date", "amount", "need", "imp", "q" or "type:<group>". */
export type ChipKey = string;
export type ActiveChip = { key: ChipKey; label: string };

export function activeFilterChips(f: BankFilters, opts: { importLabel?: (key: string) => string | null } = {}): ActiveChip[] {
  const chips: ActiveChip[] = [];
  if (f.status !== "all") chips.push({ key: "status", label: f.status === "unmatched" ? "Unmatched" : "Reconciled" });
  if (f.dir !== "all") chips.push({ key: "dir", label: f.dir === "in" ? "Money in" : "Money out" });
  if (f.from || f.to) {
    const label = f.from && f.to ? `${formatDate(f.from)} – ${formatDate(f.to)}`
      : f.from ? `From ${formatDate(f.from)}` : `Up to ${formatDate(f.to)}`;
    chips.push({ key: "date", label });
  }
  if (f.exact !== null) chips.push({ key: "amount", label: `Exactly ${rupee(f.exact)}` });
  else if (f.min !== null || f.max !== null) {
    const label = f.min !== null && f.max !== null ? `${rupee(f.min)} – ${rupee(f.max)}`
      : f.min !== null ? `${rupee(f.min)} and up` : `Up to ${rupee(f.max)}`;
    chips.push({ key: "amount", label });
  }
  for (const g of f.types) chips.push({ key: `type:${g}`, label: `Matched to: ${MATCH_GROUP_LABEL[g]}` });
  if (f.need) chips.push({ key: "need", label: NEED_LABEL[f.need] });
  if (f.imp) chips.push({ key: "imp", label: `File: ${opts.importLabel?.(f.imp) ?? "one import"}` });
  if (f.q.trim()) chips.push({ key: "q", label: `Search: ${f.q.trim()}` });
  return chips;
}

export function removeFilter(f: BankFilters, key: ChipKey): BankFilters {
  if (key.startsWith("type:")) return { ...f, types: f.types.filter((g) => `type:${g}` !== key) };
  switch (key) {
    case "status": return { ...f, status: "all" };
    case "dir":    return { ...f, dir: "all" };
    case "date":   return { ...f, from: null, to: null };
    case "amount": return { ...f, min: null, max: null, exact: null };
    case "need":   return { ...f, need: null };
    case "imp":    return { ...f, imp: null };
    case "q":      return { ...f, q: "" };
  }
  return f;
}

/** Clear every filter; the sort stays (it is not a filter). */
export function clearFilters(f: BankFilters): BankFilters {
  return { ...DEFAULT_FILTERS, sort: f.sort };
}

/** The number on the "Filters" button: how many filters inside the panel are set. */
export function panelFilterCount(f: BankFilters): number {
  return (f.from || f.to ? 1 : 0)
    + (f.exact !== null || f.min !== null || f.max !== null ? 1 : 0)
    + (f.types.length ? 1 : 0)
    + (f.need ? 1 : 0)
    + (f.imp ? 1 : 0);
}

export function hasAnyFilter(f: BankFilters): boolean {
  return f.status !== "all" || f.dir !== "all" || panelFilterCount(f) > 0 || f.q.trim() !== "";
}

// ─── CSV ───────────────────────────────────────────────────────────────────

/** Export CSV of exactly the filtered lines (lib/csv downloadCSV writes it). Amounts raw, whole ₹. */
export function bankLinesCsv(lines: readonly FilterLine[]): { headers: string[]; rows: (string | number)[][] } {
  return {
    headers: ["Date", "Description", "Reference", "Money out", "Money in", "Status", "Balance after"],
    rows: lines.map((t) => [
      t.txn_date.slice(0, 10),
      t.description ?? "",
      t.reference ?? "",
      (t.debit ?? 0) > 0 ? t.debit : "",
      (t.credit ?? 0) > 0 ? t.credit : "",
      lineStatusLabel(t.matched_to_type),
      t.balance_after ?? "",
    ]),
  };
}
