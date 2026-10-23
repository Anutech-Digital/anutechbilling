/**
 * Laying out a waterfall — the geometry, separated from the drawing.
 *
 * ─── WHY THIS IS A PURE FUNCTION AND NOT JUST JSX ───────────────────────────
 * A waterfall's whole meaning is in where each bar STARTS. Get the running total wrong
 * and the chart still renders beautifully, with bars floating at plausible heights, and
 * nobody can tell by looking. That is a bug you can only catch with arithmetic, so the
 * arithmetic lives here with tests and the component only draws what it is handed.
 *
 * ─── AND WHY NOT RECHARTS ───────────────────────────────────────────────────
 * Recharts is already a dependency and has no waterfall. The usual workaround is a
 * stacked BarChart with an invisible base series — which means the "cost" bar is really
 * two bars, one of them a lie told to the layout engine, and the tooltip then has to be
 * taught to hide it. An inline SVG is fewer moving parts and exact.
 *
 * ─── SIGNS ──────────────────────────────────────────────────────────────────
 * `delta` is signed: revenue is positive, COGS and expenses are negative. Totals
 * (`isTotal`) do not move the running balance — they RESTATE it, which is what makes
 * Gross Margin and Net Profit render as full columns from the axis rather than as
 * floating steps.
 */

import { isEstimatedBasis, type CogsBasis } from "./pnl";
import { netFigure } from "./net-figure";

export interface WaterfallInput {
  key: string;
  label: string;
  /** ₹, signed. Ignored when `isTotal`. */
  delta: number;
  /** A subtotal: draws from zero and restates the running balance. */
  isTotal?: boolean;
  /** Shown under the bar. */
  hint?: string | null;
  /** Set when the figure is not a fact — renders hatched. */
  estimated?: boolean;
}

export interface WaterfallBar extends WaterfallInput {
  /** Running total BEFORE this bar. */
  start: number;
  /** Running total AFTER it. */
  end: number;
  /** ₹ height of the bar — always positive. */
  magnitude: number;
  /** Fraction of the chart's height, 0–1. */
  heightFrac: number;
  /** Fraction from the BOTTOM of the plot to the bar's base, 0–1. */
  baseFrac: number;
  direction: "up" | "down" | "total";
  /**
   * Where the connector leaving this bar sits, 0–1 from the bottom — or null on the last
   * bar, which connects to nothing.
   *
   * It sits at the RUNNING BALANCE after this bar, which is exactly where the next one
   * begins. Without that line the five bars read as five separate quantities of different
   * sizes; with it they read as one balance moving, which is the only thing a waterfall is
   * for.
   *
   * Computed from `end`, never from the bar's own top edge — those differ whenever a bar
   * hangs downwards, which is every cost bar on the chart.
   */
  connectorFrac: number | null;
}

export interface WaterfallLayout {
  bars: WaterfallBar[];
  /** Highest running total reached — the top of the plot. */
  max: number;
  /** Lowest, which is 0 unless the business lost money. */
  min: number;
  /** Where ₹0 sits as a fraction from the bottom. 0 unless `min` is negative. */
  zeroFrac: number;
}

/**
 * Position every bar.
 *
 * The scale spans min..max across the FULL plot height, so a loss renders below the zero
 * line rather than being clipped to nothing. A chart that cannot draw a negative net
 * profit is a chart that hides the only month anybody needed to look at.
 */
export function layoutWaterfall(steps: readonly WaterfallInput[]): WaterfallLayout {
  let running = 0;
  const raw: Omit<WaterfallBar, "heightFrac" | "baseFrac" | "connectorFrac">[] = [];

  for (const s of steps) {
    if (s.isTotal) {
      raw.push({
        ...s, start: 0, end: running,
        magnitude: Math.abs(running),
        direction: "total",
      });
      continue;
    }
    const start = running;
    running += s.delta;
    raw.push({
      ...s, start, end: running,
      magnitude: Math.abs(s.delta),
      direction: s.delta >= 0 ? "up" : "down",
    });
  }

  const points = raw.flatMap((b) => [b.start, b.end, 0]);
  const max = Math.max(...points);
  const min = Math.min(...points);
  /* A flat, all-zero chart would divide by zero. Falling back to 1 draws nothing, which
     is the honest picture of a period with no money in it. */
  const span = max - min || 1;

  return {
    max, min,
    zeroFrac: (0 - min) / span,
    bars: raw.map((b, i) => {
      const lo = Math.min(b.start, b.end);
      const hi = Math.max(b.start, b.end);
      return {
        ...b,
        heightFrac: (hi - lo) / span,
        baseFrac: (lo - min) / span,
        connectorFrac: i === raw.length - 1 ? null : (b.end - min) / span,
      };
    }),
  };
}

/**
 * Where every ₹100 of sales goes.
 *
 * ─── WHY THIS EXISTS BESIDE THE WATERFALL ───────────────────────────────────
 * A waterfall on a thin-margin business has a scale problem no styling fixes: ANUTECH's
 * ₹67,000 net profit against ₹9,14,376 of revenue is 7% — a bar four pixels tall next to
 * one that fills the plot. The chart is accurate and the most important number on it is
 * the one you cannot see.
 *
 * Normalising to ₹100 removes the scale entirely. "Of every ₹100 you invoice, ₹63 goes to
 * Google, ₹30 to running the business, ₹7 is yours" is a sentence a reseller can hold in
 * their head and repeat to their accountant. Lakhs are not.
 *
 * ─── THE SHARES ARE FORCED TO SUM TO 100 ────────────────────────────────────
 * Rounding three percentages independently gives 63 + 30 + 7 = 99 or 101, and a bar
 * captioned "of every ₹100" that adds to 101 is the kind of small wrongness that makes a
 * reader distrust the whole page. Profit absorbs the remainder because it is the
 * derived figure — the other two are measured.
 */
export interface HundredRupeeSplit {
  /** ₹ of every 100 that goes to the vendor. */
  licence: number;
  /** ₹ of every 100 spent running the business. */
  running: number;
  /** What is left. Can be NEGATIVE, and then the caption says so. */
  profit: number;
  /** True when the business spends more than it earns. */
  isLoss: boolean;
}

export function hundredRupeeSplit(p: {
  revenue: number;
  cogs: number;
  expenses: number;
}): HundredRupeeSplit | null {
  if (p.revenue <= 0) return null;

  const licence = Math.round((p.cogs / p.revenue) * 100);
  const running = Math.round((p.expenses / p.revenue) * 100);
  /* Derived last so the three always total exactly 100. */
  const profit = 100 - licence - running;

  return { licence, running, profit, isLoss: profit < 0 };
}

/**
 * Build the reseller's money story: what came in, what the licences cost, what is left,
 * what the business spent, what remains.
 *
 * Returns null when the gross margin is unknown. A waterfall implies every step is known
 * — that is what the shape says — so drawing one over a missing COGS would be the same
 * confident lie the numbers version told, only prettier.
 */
export function pnlWaterfall(p: {
  revenue: number;
  cogs: number;
  cogsBasis: CogsBasis;
  grossMargin: number | null;
  expenses: number;
  netProfit: number | null;
}): WaterfallInput[] | null {
  if (p.grossMargin === null || p.netProfit === null) return null;

  return [
    { key: "revenue", label: "Revenue", delta: p.revenue, hint: "Invoiced to customers" },
    {
      key: "cogs", label: "Licence cost", delta: -p.cogs,
      hint: p.cogsBasis === "estimated" ? "Estimated from wholesale rates" : p.cogsBasis === "mixed" ? "Vendor bills + estimate for vendors with no bill" : "Paid to vendors",
      estimated: isEstimatedBasis(p.cogsBasis),
    },
    { key: "gross", label: "Gross margin", delta: 0, isTotal: true, hint: "What resale earns" },
    { key: "opex", label: "Running costs", delta: -p.expenses, hint: "Salaries, hosting, office" },
    // R-1486: a loss month names this bar "Net loss" (the bar text carries the minus).
    {
      key: "net", label: netFigure(p.netProfit).label, delta: 0, isTotal: true,
      hint: p.netProfit < 0 ? "What the business lost" : "What the business kept",
    },
  ];
}
