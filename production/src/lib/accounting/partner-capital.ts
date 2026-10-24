/**
 * R-1848 (epic R-1841, Phase 2) — each partner's capital account, as pure, tested sums.
 *
 * Pardeep's decision (R-1841 pardeepDecisions.partnerCapital): ONE fluctuating capital account
 * per partner — capital introduced, share of profit and drawings all go into it:
 *
 *   Opening capital + Capital introduced + Share of profit − Drawings = Closing capital
 *
 *   • Opening    = the partner's capital contribution in the register (R-1847) — their capital
 *                  before the entries recorded in the app (deed / CA).
 *   • Introduced / Drawings = R-1839 entries linked to the partner (partner_id), in the Balance
 *                  Sheet's range (after the CA's opening date, up to the sheet's date).
 *   • Share of profit = the Balance Sheet's profit × the partner's ratio — an ESTIMATE until the
 *                  year-end split (R-1849: interest on capital, remuneration, s.40(b)) is posted.
 *                  Only partners in the firm on the sheet's date share it.
 *
 * Older entries with a typed name (no partner_id) stay under that name, not linked, with no
 * opening or profit share — the screen offers "Link to partner". Whatever the partners'
 * accounts do not cover (the CA's lump opening, hand-entered lines, an unshared % of profit)
 * is returned as `notSplit`, so the equity total on the Balance Sheet never changes.
 * Whole rupees. Pure — no I/O.
 */
import type { FirmPartner } from "./partners";
import { isActivePartner } from "./partners";
import type { OwnerEquityMovement } from "./owner-equity";

type Mv = Pick<OwnerEquityMovement, "kind" | "amount" | "movement_date" | "partner_name" | "partner_id" | "note">;

export interface Range { after?: string | null; upTo?: string | null }

const inRange = (d: string, r: Range) => !(r.after && d <= r.after) && !(r.upTo && d > r.upTo);

/**
 * Profit × each ratio, whole rupees, largest remainder so the parts add up to exactly
 * round(profit × Σratio / 100). A loss splits the same way (negative).
 */
export function splitProfit(profit: number, ratios: readonly number[]): number[] {
  const sumPct = ratios.reduce((s, r) => s + Number(r), 0);
  const sign = profit < 0 ? -1 : 1;
  const abs = Math.abs(profit);
  const total = Math.round((abs * sumPct) / 100);
  const raw = ratios.map((r) => (abs * Number(r)) / 100);
  const parts = raw.map((x) => Math.floor(x + 1e-9));
  let left = total - parts.reduce((s, x) => s + x, 0);
  const order = raw.map((x, i) => ({ i, frac: x - Math.floor(x + 1e-9) })).sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    parts[i] += 1;
    left -= 1;
  }
  return parts.map((x) => (x === 0 ? 0 : sign * x));
}

export interface PartnerCapitalRow {
  key: string;
  /** Register partner; null for an older free-text name. */
  partnerId: string | null;
  name: string;
  linked: boolean;
  /** Left the firm on or before the sheet's date. */
  left: boolean;
  sharePct: number;
  opening: number;
  capitalIntroduced: number;
  profitShare: number;
  drawings: number;
  closing: number;
}

export interface PartnerCapitalAccounts {
  rows: PartnerCapitalRow[];
  totalClosing: number;
  /** Section total − Σ closing; null when no section total was given. */
  notSplit: number | null;
  /** Profit share is ratio × profit until R-1849 posts the year-end split. */
  profitShareIsEstimate: true;
  profitLoading: boolean;
  /** Entries in range that name a partner by typed text only. */
  unlinkedCount: number;
}

export function partnerCapitalAccounts(input: {
  partners: readonly FirmPartner[];
  movements: readonly Mv[];
  /** The Balance Sheet's profit for the same range. Null = still loading. */
  profit: number | null;
  range?: Range;
  /** What the equity section adds up to on the Balance Sheet (for `notSplit`). */
  sectionTotal: number | null;
}): PartnerCapitalAccounts {
  const range = input.range ?? {};
  const onDate = range.upTo ?? "9999-12-31";
  const inRangeMv = input.movements.filter((m) => inRange(m.movement_date, range));

  const byId = new Map<string, Mv[]>();
  const byName = new Map<string, { name: string; items: Mv[] }>();
  let unlinkedCount = 0;
  for (const m of inRangeMv) {
    if (m.partner_id) {
      byId.set(m.partner_id, [...(byId.get(m.partner_id) ?? []), m]);
    } else {
      const name = m.partner_name?.trim() || "No partner named";
      const k = name.toLowerCase();
      const g = byName.get(k) ?? { name, items: [] };
      g.items.push(m);
      byName.set(k, g);
      if (m.partner_name) unlinkedCount += 1;
    }
  }

  const sums = (items: readonly Mv[]) => items.reduce(
    (s, m) => (m.kind === "drawings" ? { ...s, drawings: s.drawings + m.amount } : { ...s, capitalIntroduced: s.capitalIntroduced + m.amount }),
    { capitalIntroduced: 0, drawings: 0 },
  );

  /* Register partners in the firm on the date, plus anyone with entries in range. */
  const listed = input.partners
    .filter((p) => isActivePartner(p, onDate) || byId.has(p.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const sharing = listed.filter((p) => isActivePartner(p, onDate));
  const shares = splitProfit(input.profit ?? 0, sharing.map((p) => Number(p.profit_share_pct)));
  const shareOf = new Map(sharing.map((p, i) => [p.id, shares[i]]));

  const rows: PartnerCapitalRow[] = listed.map((p) => {
    const s = sums(byId.get(p.id) ?? []);
    const opening = Number(p.capital_contribution) || 0;
    const profitShare = shareOf.get(p.id) ?? 0;
    return {
      key: p.id, partnerId: p.id, name: p.name, linked: true, left: !isActivePartner(p, onDate),
      sharePct: Number(p.profit_share_pct), opening, ...s, profitShare,
      closing: opening + s.capitalIntroduced + profitShare - s.drawings,
    };
  });
  for (const [k, g] of [...byName.entries()].sort((a, b) => a[1].name.localeCompare(b[1].name))) {
    const s = sums(g.items);
    rows.push({
      key: `name:${k}`, partnerId: null, name: g.name, linked: false, left: false, sharePct: 0,
      opening: 0, ...s, profitShare: 0, closing: s.capitalIntroduced - s.drawings,
    });
  }

  const totalClosing = rows.reduce((s, r) => s + r.closing, 0);
  return {
    rows,
    totalClosing,
    notSplit: input.sectionTotal === null ? null : input.sectionTotal - totalClosing,
    profitShareIsEstimate: true,
    profitLoading: input.profit === null,
    unlinkedCount,
  };
}

// ── Drill-down statement + CSV ─────────────────────────────────────────────────────────────

export interface StatementLine { date: string | null; label: string; amount: number; note: string | null; total?: boolean }

/** One partner's account: opening, each dated entry (oldest first), share of profit, closing. */
export function partnerStatement(row: PartnerCapitalRow, movements: readonly Mv[], range: Range): StatementLine[] {
  const mine = movements
    .filter((m) => inRange(m.movement_date, range))
    .filter((m) => (row.partnerId ? m.partner_id === row.partnerId
      : !m.partner_id && (m.partner_name?.trim() || "No partner named").toLowerCase() === row.key.slice(5)))
    .sort((a, b) => a.movement_date.localeCompare(b.movement_date));
  const lines: StatementLine[] = [{ date: null, label: "Opening capital", amount: row.opening, note: null }];
  for (const m of mine) {
    lines.push({
      date: m.movement_date,
      label: m.kind === "drawings" ? "Drawings" : "Capital introduced",
      amount: m.kind === "drawings" ? -m.amount : m.amount,
      note: m.note ?? null,
    });
  }
  if (row.linked && row.profitShare !== 0) {
    lines.push({ date: null, label: `Share of profit (${row.sharePct}%, estimate)`, amount: row.profitShare, note: null });
  }
  lines.push({ date: null, label: "Closing capital", amount: row.closing, note: null, total: true });
  return lines;
}

export function partnerCapitalCsv(row: PartnerCapitalRow, movements: readonly Mv[], range: Range): { header: string[]; rows: (string | number)[][] } {
  return {
    header: ["Date", "Particulars", "Amount (INR)", "Note"],
    rows: partnerStatement(row, movements, range).map((l) => [l.date ?? "", l.label, l.amount, l.note ?? ""]),
  };
}
