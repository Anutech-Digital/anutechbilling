/**
 * R-1832 — P&L comparison: "previous period" or "same period last year".
 *
 * Pardeep (24 Oct 2026): compare the P&L with the period before, or with the same period last
 * year, to take better business decisions. Both periods come from the SAME profit source
 * (usePnL → report_pnl → assemblePnl, depreciation only to today IST — R-1808); this file only
 * decides WHICH dates to compare and how a change is worded and coloured.
 *
 * ─── PERIOD MATHS ──────────────────────────────────────────────────────────
 * A range made of whole calendar months (1st → last day) moves by whole months, so
 * "This month" (1–31 Oct) compares with 1–30 Sep — not with the 31 days before it
 * (31 Aug–30 Sep), which is what a day count gives. A quarter moves to the previous quarter,
 * an FY to the previous FY. Any other range compares with the same number of days just before.
 * "Same period last year" moves both dates back one year (29 Feb → 28 Feb).
 */
import { rupee } from "@/lib/utils";
import type { PnLNumbers } from "@/lib/accounting/pnl-assemble";
import { vendorLabel } from "@/lib/accounting/pnl";
import { utcDateISO } from "@/lib/dates/ist";

export interface DateRange { from: string; to: string }
export type CompareMode = "none" | "prev" | "yoy";

export const COMPARE_OPTIONS: { mode: CompareMode; label: string }[] = [
  { mode: "none", label: "None" },
  { mode: "prev", label: "Previous period" },
  { mode: "yoy", label: "Same period last year" },
];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

interface Ymd { y: number; m: number; d: number }   // m is 1–12

function parse(s: string): Ymd {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return { y, m, d };
}
const pad = (n: number) => String(n).padStart(2, "0");
const fmt = ({ y, m, d }: Ymd) => `${y}-${pad(m)}-${pad(d)}`;
const daysInMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();
const dayMs = (s: string) => Date.parse(`${s.slice(0, 10)}T00:00:00Z`);
const fromMs = (ms: number) => utcDateISO(new Date(ms));

/** Month index (y*12 + m-1) → {y, m}. */
const fromIndex = (i: number) => ({ y: Math.floor(i / 12), m: (i % 12) + 1 });

/** Number of whole calendar months the range covers, or null when it is not whole months. */
export function wholeMonths(r: DateRange): number | null {
  const a = parse(r.from);
  const b = parse(r.to);
  if (a.d !== 1 || b.d !== daysInMonth(b.y, b.m)) return null;
  const n = (b.y * 12 + b.m - 1) - (a.y * 12 + a.m - 1) + 1;
  return n >= 1 ? n : null;
}

function shiftMonths(r: DateRange, by: number): DateRange {
  const a = parse(r.from);
  const b = parse(r.to);
  const s = fromIndex(a.y * 12 + a.m - 1 + by);
  const e = fromIndex(b.y * 12 + b.m - 1 + by);
  return { from: fmt({ ...s, d: 1 }), to: fmt({ ...e, d: daysInMonth(e.y, e.m) }) };
}

function shiftYear(s: string, by: number): string {
  const { y, m, d } = parse(s);
  return fmt({ y: y + by, m, d: Math.min(d, daysInMonth(y + by, m)) });
}

/** The period of the same length immediately before `r`. */
export function previousPeriod(r: DateRange): DateRange {
  const n = wholeMonths(r);
  if (n !== null) return shiftMonths(r, -n);
  const len = dayMs(r.to) - dayMs(r.from) + 86_400_000;
  return { from: fromMs(dayMs(r.from) - len), to: fromMs(dayMs(r.from) - 86_400_000) };
}

/** The same dates one year earlier (an FY → the previous FY). */
export function samePeriodLastYear(r: DateRange): DateRange {
  if (wholeMonths(r) !== null) return shiftMonths(r, -12);
  return { from: shiftYear(r.from, -1), to: shiftYear(r.to, -1) };
}

export function compareRange(r: DateRange, mode: CompareMode): DateRange | null {
  if (mode === "prev") return previousPeriod(r);
  if (mode === "yoy") return samePeriodLastYear(r);
  return null;
}

export function parseCompareMode(v: string | null | undefined): CompareMode {
  return v === "prev" || v === "yoy" ? v : "none";
}

// ─── Labels ─────────────────────────────────────────────────────────────────

/** "1–31 Oct 2026" · "1 Sep – 31 Oct 2026" · "1 Apr 2026 – 31 Mar 2027". */
export function rangeLabel(r: DateRange): string {
  const a = parse(r.from);
  const b = parse(r.to);
  if (a.y === b.y && a.m === b.m) {
    return a.d === b.d ? `${a.d} ${MONTHS[a.m - 1]} ${a.y}` : `${a.d}–${b.d} ${MONTHS[a.m - 1]} ${a.y}`;
  }
  if (a.y === b.y) return `${a.d} ${MONTHS[a.m - 1]} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
  return `${a.d} ${MONTHS[a.m - 1]} ${a.y} – ${b.d} ${MONTHS[b.m - 1]} ${b.y}`;
}

/** A short name for a period: "Sep 2026", "Jul–Sep 2026", "FY 2025-26", else the dates. */
export function periodName(r: DateRange): string {
  const n = wholeMonths(r);
  const a = parse(r.from);
  const b = parse(r.to);
  if (n === 1) return `${MONTHS[a.m - 1]} ${a.y}`;
  if (n === 12 && a.m === 4) return `FY ${a.y}-${String(a.y + 1).slice(2)}`;
  if (n !== null && a.y === b.y) return `${MONTHS[a.m - 1]}–${MONTHS[b.m - 1]} ${a.y}`;
  if (n !== null) return `${MONTHS[a.m - 1]} ${a.y} – ${MONTHS[b.m - 1]} ${b.y}`;
  return rangeLabel(r);
}

/** "24 of 31 days so far" while `today` is inside the range; null once it has ended. */
export function runningNote(r: DateRange, today: string): string | null {
  if (!(today >= r.from && today < r.to)) return null;
  const total = (dayMs(r.to) - dayMs(r.from)) / 86_400_000 + 1;
  const done = (dayMs(today) - dayMs(r.from)) / 86_400_000 + 1;
  return `runs to today — ${done} of ${total} days so far`;
}

// ─── Change ─────────────────────────────────────────────────────────────────

export interface Change { abs: number; pct: number | null }

/** Change from `was` to `now`. % is against |was|, one decimal; null when `was` is 0. */
export function periodChange(now: number, was: number): Change {
  const abs = now - was;
  if (was === 0) return { abs, pct: null };
  return { abs, pct: Math.round((abs / Math.abs(was)) * 1000) / 10 };
}

/** Which way is good for this line. Revenue and profit: up. Costs: down. GST: neither. */
export type Sense = "more-is-good" | "more-is-bad" | "neutral";
export type ChangeTone = "emerald" | "rose" | "muted";

export function changeTone(abs: number, sense: Sense): ChangeTone {
  if (abs === 0 || sense === "neutral") return "muted";
  const good = sense === "more-is-good" ? abs > 0 : abs < 0;
  return good ? "emerald" : "rose";
}

export const TONE_CLASS: Record<ChangeTone, string> = {
  emerald: "text-emerald", rose: "text-rose", muted: "text-ink-3",
};

function pctText(pct: number | null): string {
  return pct === null ? "—" : `${Math.abs(pct)}%`;
}

/**
 * A figure as the statement prints it: "−₹30,000" for a negative, never "₹-30,000" or "−₹0".
 * `asCost` flips the sign first, so a cost of ₹500 reads "−₹500" and a negative cost (a
 * credit) reads "₹500".
 */
export function signedRupee(v: number, asCost = false): string {
  const s = asCost ? -v : v;
  return s < 0 ? `−${rupee(-s)}` : rupee(s === 0 ? 0 : s);
}

/** "▲ ₹15,000 (12.5%)" · "▼ ₹2,000 (—)" · "No change". */
export function formatChange(c: Change): string {
  if (c.abs === 0) return "No change";
  return `${c.abs > 0 ? "▲" : "▼"} ${rupee(Math.abs(c.abs))} (${pctText(c.pct)})`;
}

// ─── Statement sub-lines (R-1833) ───────────────────────────────────────────

/**
 * One indented sub-line of the statement. `now` / `was` are positive rupees.
 *
 * A group's sub-lines add up to their parent line, to the rupee: "item" and "add" lines add,
 * "less" lines subtract. Revenue: one line per product family, each net of its own notes
 * (R-1835) — on an older database sales + projects − credit notes + debit notes. Licence cost:
 * bills per vendor + other bills + the estimate per vendor. Operating expenses: what was paid
 * per category (GST included, as the Expense report shows it) − GST claimed back − salary on
 * projects moved up to cost of goods.
 */
export interface SubLine {
  key: string;
  label: string;
  now: number;
  was: number;
  kind: "item" | "other" | "less" | "add";
  /** Which way is good for this line, for the change colour. */
  sense: Sense;
  /** An expense category — opens its drill-down. */
  category?: string;
  /** Estimated from the subscription book, not from a bill. */
  estimated?: boolean;
  /** R-2181: the "Other (N …)" line — the keys of the lines rolled into it, so its drill-down
   *  opens exactly those. */
  members?: string[];
}

export interface SubLines { lines: SubLine[]; itemCount: number }

const r2 = (n: number) => Math.round(n * 100) / 100;

/** More than this many items → the top (MAX − 1) plus one "Other" line. */
export const MAX_SUB_LINES = 8;

type Item = Omit<SubLine, "kind">;

/** Largest first (this period, then the compare period, then name); top 7 + "Other" past 8. */
function rollUp(items: Item[], showAll: boolean, otherNoun: string): SubLine[] {
  const sorted = items
    .filter((i) => i.now !== 0 || i.was !== 0)
    .sort((a, b) => b.now - a.now || b.was - a.was || a.label.localeCompare(b.label))
    .map((i): SubLine => ({ ...i, kind: "item" }));
  if (showAll || sorted.length <= MAX_SUB_LINES) return sorted;
  const rest = sorted.slice(MAX_SUB_LINES - 1);
  return [
    ...sorted.slice(0, MAX_SUB_LINES - 1),
    {
      key: "other", kind: "other", sense: rest[0].sense,
      label: `Other (${rest.length} ${otherNoun})`,
      now: r2(rest.reduce((s, c) => s + c.now, 0)),
      was: r2(rest.reduce((s, c) => s + c.was, 0)),
      estimated: rest.some((c) => c.estimated) || undefined,
      members: rest.map((c) => c.key),
    },
  ];
}

const itemCount = (items: Item[]) =>
  items.filter((i) => i.now !== 0 || i.was !== 0).length;

/** Sum of the sub-lines: items and "add" lines add, "less" lines subtract. */
export function subSum(lines: SubLine[], side: "now" | "was"): number {
  return r2(lines.reduce((s, l) => s + (l.kind === "less" ? -l[side] : l[side]), 0));
}

/* Merge this period's and the compare period's items by key — an item in only one period
   still shows, with ₹0 on the other side. */
function merge(now: Item[], was: Item[]): Item[] {
  const out = new Map<string, Item>();
  for (const i of now) out.set(i.key, { ...i, was: 0 });
  for (const i of was) {
    const e = out.get(i.key);
    if (e) e.was = i.now;
    else out.set(i.key, { ...i, was: i.now, now: 0 });
  }
  return [...out.values()];
}

function lessLine(key: string, label: string, now: number, was: number, sense: Sense = "neutral"): SubLine[] {
  return now !== 0 || was !== 0 ? [{ key, label, now, was, kind: "less", sense }] : [];
}
function addLine(key: string, label: string, now: number, was: number, sense: Sense): SubLine[] {
  return now !== 0 || was !== 0 ? [{ key, label, now, was, kind: "add", sense }] : [];
}

type Opts = { showAll?: boolean };

// — Operating expenses —

export type OpexSource = Pick<PnLNumbers, "expenses" | "expenseReport" | "model">;

const opexItems = (d: OpexSource): Item[] => d.expenseReport.byCategory.map((c) => ({
  key: `cat:${c.category}`, label: c.category, category: c.category, now: c.total, was: 0, sense: "more-is-bad",
}));

export function opexBreakdown(cur: OpexSource, prev?: OpexSource | null, opts: Opts = {}): SubLines {
  const items = merge(opexItems(cur), prev ? opexItems(prev) : []);
  const lines = [
    ...rollUp(items, !!opts.showAll, "categories"),
    ...lessLine("less:gst", "Less: GST claimed back (input credit)",
      r2(cur.expenseReport.total - cur.expenses), prev ? r2(prev.expenseReport.total - prev.expenses) : 0),
    ...lessLine("less:project", "Less: salary on projects (in cost of goods)",
      cur.model.projectCost, prev?.model.projectCost ?? 0),
  ];
  return { lines, itemCount: itemCount(items) };
}

// — Revenue —

export type RevenueSource = Pick<PnLNumbers, "revenueParts" | "model"> & Partial<Pick<PnLNumbers, "revenueByProduct">>;

/* R-1835: with the split by what was sold, each family is already net of its own credit / debit
   notes (shared over its invoice's families in SQL), so there are no separate note lines. */
const notesOf = (d: RevenueSource | null | undefined, k: "creditNotes" | "debitNotes") =>
  !d || d.revenueByProduct ? 0 : d.revenueParts?.[k] ?? 0;

const revenueItems = (d: RevenueSource): Item[] => {
  if (d.revenueByProduct) {
    return d.revenueByProduct.map((f) => ({ key: `rev:${f.family}`, label: f.label, now: f.net, was: 0, sense: "more-is-good" }));
  }
  const p = d.revenueParts;
  if (!p) return [{ key: "rev:all", label: "Sales", now: d.model.revenue, was: 0, sense: "more-is-good" }];
  return [
    { key: "rev:sales", label: "Subscriptions, licences & other sales", now: r2(p.invoiced - p.projects), was: 0, sense: "more-is-good" },
    { key: "rev:projects", label: "Software projects", now: p.projects, was: 0, sense: "more-is-good" },
  ];
};

export function revenueBreakdown(cur: RevenueSource, prev?: RevenueSource | null, opts: Opts = {}): SubLines {
  const items = merge(revenueItems(cur), prev ? revenueItems(prev) : []);
  const lines = [
    ...rollUp(items, !!opts.showAll, "lines"),
    ...lessLine("less:cn", "Less: credit notes", notesOf(cur, "creditNotes"), notesOf(prev, "creditNotes"), "more-is-bad"),
    ...addLine("add:dn", "Add: debit notes", notesOf(cur, "debitNotes"), notesOf(prev, "debitNotes"), "more-is-good"),
  ];
  return { lines, itemCount: itemCount(items) };
}

// — Licence cost (R-1645 per-vendor basis) —

export type LicenceSource = Pick<PnLNumbers, "licenceBillsByVendor" | "model">;

/**
 * Split an integer rupee total by weights, largest remainder last, so the parts add up exactly.
 */
export function splitByWeight(total: number, weights: { key: string; w: number }[]): Map<string, number> {
  const sumW = weights.reduce((s, x) => s + x.w, 0);
  const out = new Map<string, number>();
  if (sumW <= 0 || weights.length === 0) return out;
  const raw = weights.map((x) => ({ key: x.key, v: (total * x.w) / sumW }));
  const floored = raw.map((x) => ({ key: x.key, v: Math.floor(x.v), rem: x.v - Math.floor(x.v) }));
  let left = Math.round(total - floored.reduce((s, x) => s + x.v, 0));
  for (const x of [...floored].sort((a, b) => b.rem - a.rem || a.key.localeCompare(b.key))) {
    if (left <= 0) break;
    x.v += 1; left -= 1;
  }
  for (const x of floored) out.set(x.key, x.v);
  return out;
}

const licenceItems = (d: LicenceSource): Item[] => {
  const m = d.model;
  if (m.cogsBasis === "unknown") return [];
  const items: Item[] = [];
  const bills = d.licenceBillsByVendor;
  if (m.billedLicenceCogs > 0) {
    let perVendor = 0;
    for (const [vendor, amt] of Object.entries(bills ?? {})) {
      if (amt <= 0) continue;
      perVendor += amt;
      items.push({ key: `lic:${vendor}`, label: vendorLabel(vendor), now: r2(amt), was: 0, sense: "more-is-bad" });
    }
    const rest = r2(m.billedLicenceCogs - perVendor);
    if (rest !== 0) items.push({ key: "lic:other-bills", label: bills ? "Other vendor bills" : "Vendor bills", now: rest, was: 0, sense: "more-is-bad" });
  }
  for (const e of licenceEstimates(d)) {
    const existing = items.find((i) => i.key === `lic:${e.vendor}`);
    if (existing) existing.now = r2(existing.now + e.amount);
    else items.push({ key: `lic:${e.vendor}`, label: e.label, now: e.amount, was: 0, sense: "more-is-bad", estimated: true });
  }
  return items;
};

/** One vendor's estimated licence cost (no bill yet). vendor "estimate" = no vendor split known. */
export interface LicenceEstimate { vendor: string; label: string; amount: number }

/**
 * The estimated part of the licence cost, per un-billed vendor. The estimate is one ratio over
 * the licence revenue (lib/accounting/pnl.ts); it is shared out by each un-billed vendor's own
 * book cost, so the vendor parts add up to it exactly. R-2181: the COGS drill-down lists these
 * same parts, so its total equals the line clicked.
 */
export function licenceEstimates(d: LicenceSource): LicenceEstimate[] {
  const m = d.model;
  if (m.cogsBasis === "unknown" || !(m.estimatedLicenceCogs > 0)) return [];
  const bills = d.licenceBillsByVendor;
  const unbilled = m.byVendor.filter((v) => !((bills?.[v.vendor] ?? 0) > 0) && v.cost > 0);
  const split = splitByWeight(m.estimatedLicenceCogs, unbilled.map((v) => ({ key: v.vendor, w: v.cost })));
  if (split.size === 0) return [{ vendor: "estimate", label: "Licences", amount: m.estimatedLicenceCogs }];
  return unbilled
    .map((v) => ({ vendor: v.vendor, label: v.label, amount: split.get(v.vendor) ?? 0 }))
    .filter((e) => e.amount !== 0);
}

export function licenceBreakdown(cur: LicenceSource, prev?: LicenceSource | null, opts: Opts = {}): SubLines {
  const items = merge(licenceItems(cur), prev ? licenceItems(prev) : []);
  const lines = rollUp(items, !!opts.showAll, "vendors");
  return { lines, itemCount: itemCount(items) };
}

// ─── CSV ────────────────────────────────────────────────────────────────────

type Cell = string | number;
interface Line { label: string; value: (d: PnLNumbers) => Cell }

/* Sub-lines in the CSV: every item (a file has no "Other" roll-up), signed like their parent
   — revenue positive, costs negative — so the indented rows add up to the line above them. */
function subRows(
  breakdown: (cur: PnLNumbers, prev: PnLNumbers | null, o: Opts) => SubLines,
  data: PnLNumbers, prev: PnLNumbers | null, parentSign: 1 | -1,
): Line[] {
  return breakdown(data, prev, { showAll: true }).lines.map((l): Line => ({
    label: `  ${l.label}${l.estimated ? " (estimated)" : ""}`,
    value: (d) => {
      const own = breakdown(d, null, { showAll: true }).lines.find((x) => x.key === l.key);
      const v = own?.now ?? 0;
      return (l.kind === "less" ? -v : v) * parentSign;
    },
  }));
}

function csvLines(data: PnLNumbers, prev: PnLNumbers | null): Line[] {
  return [
    { label: "Revenue", value: (d) => d.model.revenue },
    ...subRows(revenueBreakdown, data, prev, 1),
    { label: "Cost of goods — project delivery (salary on projects)",
      value: (d) => d.model.projectCostHidden ? "hidden for your role (inside operating expenses)" : -d.model.projectCost },
    { label: "Cost of goods — licence cost", value: (d) => d.model.cogsBasis === "unknown" ? "not recorded" : -d.model.licenceCogs },
    ...subRows(licenceBreakdown, data, prev, -1),
    { label: "Licence cost basis", value: (d) => d.model.cogsBasis },
    { label: "Gross margin",
      value: (d) => d.model.grossMargin ?? (d.model.projectCostHidden ? "hidden for your role (needs project salary)" : "unknown") },
    { label: "Operating expenses", value: (d) => -(d.expenses - d.model.projectCost) },
    ...subRows(opexBreakdown, data, prev, -1),
    { label: "Commissions", value: (d) => -d.commissions },
    { label: "Depreciation", value: (d) => -d.depreciation },
    { label: "Net profit", value: (d) => d.model.netProfit ?? "unknown (cost of goods not recorded)" },
    { label: "", value: () => "" },
    { label: "Output GST (on sales)", value: (d) => d.outputGST },
    { label: "Input GST (ITC)", value: (d) => d.inputGST },
    { label: "Net GST payable", value: (d) => d.netGST },
  ];
}

/** The CSV the Export button writes. With a comparison: compare amount, change ₹ and change %. */
export function pnlCsv(
  data: PnLNumbers, range: DateRange,
  cmp?: { data: PnLNumbers; range: DateRange } | null,
): { headers: string[]; rows: Cell[][] } {
  if (!cmp) {
    return {
      headers: ["Line", "Amount (INR)"],
      rows: [["Period", `${range.from} to ${range.to}`], ...csvLines(data, null).map((l) => [l.label, l.value(data)])],
    };
  }
  return {
    headers: ["Line", "Amount (INR)", "Compare amount (INR)", "Change (INR)", "Change %"],
    rows: [
      ["Period", `${range.from} to ${range.to}`, `${cmp.range.from} to ${cmp.range.to}`, "", ""],
      ...csvLines(data, cmp.data).map((l) => {
        const now = l.value(data);
        const was = l.value(cmp.data);
        if (l.label === "" || typeof now !== "number" || typeof was !== "number") return [l.label, now, was, "", ""];
        const c = periodChange(now, was);
        return [l.label, now, was, r2(c.abs), c.pct === null ? "—" : c.pct];
      }),
    ],
  };
}
