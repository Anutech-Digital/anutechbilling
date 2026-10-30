/**
 * R-2165 (G-ADS-AI, AI-09) — Neo's answer: a short summary, chart JSON and a table, built
 * ONLY from the numbers the database function returned.
 *
 * No AI writes the summary: a model asked to describe numbers can invent one. Every figure
 * in the text comes from `result.total` / `result.rows`, formatted here.
 */
import {
  DIMENSION_LABEL, METRIC_LABEL, MONEY_METRICS, TIME_DIMENSIONS, shortDay,
  type MetricsResult, type NeoDimension, type NeoMetric, type QueryPlan, type ResolvedRange,
} from "./plan";

export type NeoChartType = "line" | "bar";

/** Chart JSON the panel draws (recharts). One series: the plan's first metric. */
export interface NeoChart {
  type: NeoChartType;
  /** Axis title, e.g. "Day". */
  xLabel: string;
  metric: NeoMetric;
  metricLabel: string;
  points: Array<{ x: string; y: number | null }>;
}

export interface NeoTable {
  columns: Array<{ key: string; label: string; kind: "text" | NeoMetric }>;
  rows: Array<Record<string, string | number | null>>;
}

export interface NeoAnswer {
  summary: string;
  notes: string[];
  chart: NeoChart | null;
  table: NeoTable;
  total: MetricsResult["total"];
  rangeLabel: string;
  revenueVisible: boolean;
  truncated: boolean;
}

const INR = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const INR2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });

/** One metric value as people read it. */
export function formatMetric(metric: NeoMetric, v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  switch (metric) {
    case "spend": case "revenue": case "cac": return `₹${INR.format(n)}`;
    case "cpc": case "cpm": return `₹${INR2.format(n)}`;
    case "roas": return `${n.toFixed(2)}×`;
    case "ctr": return `${n.toFixed(2)}%`;
    default: return INR.format(n);
  }
}

/** A dimension value as people read it. */
export function dimensionText(dim: NeoDimension, row: Record<string, string | number | null>): string {
  const v = row[dim];
  if (TIME_DIMENSIONS.includes(dim)) {
    if (typeof v !== "string") return "—";
    if (dim === "month") return shortDay(v).replace(/^1 /, "");
    return dim === "week" ? `Week of ${shortDay(v)}` : shortDay(v);
  }
  if (dim === "campaign") return String(row.campaign_name ?? v ?? "—");
  if (dim === "platform") {
    if (v === "google-ads") return "Google Ads";
    if (v === "meta-ads") return "Meta (Facebook / Instagram)";
    if (v === "linkedin-ads") return "LinkedIn Ads";
    return "Booked costs (no platform)";
  }
  return v === null || v === undefined || v === "" ? "No ad named" : String(v);
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

export function buildAnswer(plan: QueryPlan, range: ResolvedRange, result: MetricsResult, notes: readonly string[] = []): NeoAnswer {
  const metrics = plan.metrics;
  const out: string[] = [...notes];
  const hidden = !result.revenue_visible && metrics.some((m) => MONEY_METRICS.includes(m));
  if (hidden) {
    out.push("Revenue, paid orders, ROAS and CAC come from payments, which your role cannot see. Ask the owner for these numbers.");
  }
  if (result.truncated) out.push(`Showing the first ${result.rows.length} of ${result.row_count} rows.`);

  // ── summary: the totals, then the leader of a split ──────────────────────
  const shown = metrics.filter((m) => !(hidden && MONEY_METRICS.includes(m)));
  const totalText = shown.map((m) => `${METRIC_LABEL[m]} ${formatMetric(m, num(result.total[m]))}`).join(" · ");
  const lines = [`${range.label}: ${totalText || "no numbers your role can see"}.`];
  const split = plan.dimensions.find((d) => !TIME_DIMENSIONS.includes(d));
  const lead = metrics.find((m) => !(hidden && MONEY_METRICS.includes(m)));
  if (split && lead && result.rows.length) {
    const sortMetric = plan.sort?.metric && shown.includes(plan.sort.metric) ? plan.sort.metric : lead;
    const first = result.rows[0];
    const word = plan.sort?.direction === "asc" ? "Lowest" : "Top";
    lines.push(`${word} ${DIMENSION_LABEL[split].toLowerCase()} by ${METRIC_LABEL[sortMetric]}: ${dimensionText(split, first)} (${formatMetric(sortMetric, num(first[sortMetric]))}).`);
  }
  if (!result.rows.length) lines.push("Nothing was recorded in this period.");

  // ── chart: first visible metric over the first dimension ─────────────────
  const xDim = plan.dimensions.find((d) => TIME_DIMENSIONS.includes(d)) ?? plan.dimensions[0];
  let chart: NeoChart | null = null;
  if (xDim && lead && result.rows.length) {
    const isTime = TIME_DIMENSIONS.includes(xDim);
    chart = {
      type: isTime ? "line" : "bar",
      xLabel: DIMENSION_LABEL[xDim],
      metric: lead,
      metricLabel: METRIC_LABEL[lead],
      points: (isTime ? [...result.rows].sort((a, b) => String(a[xDim]).localeCompare(String(b[xDim]))) : result.rows)
        .map((r) => ({ x: dimensionText(xDim, r), y: num(r[lead]) })),
    };
  }

  // ── table ────────────────────────────────────────────────────────────────
  const table: NeoTable = {
    columns: [
      ...plan.dimensions.map((d) => ({ key: d, label: DIMENSION_LABEL[d], kind: "text" as const })),
      ...metrics.map((m) => ({ key: m, label: METRIC_LABEL[m], kind: m })),
    ],
    rows: result.rows.map((r) => ({
      ...Object.fromEntries(plan.dimensions.map((d) => [d, dimensionText(d, r)])),
      ...Object.fromEntries(metrics.map((m) => [m, num(r[m])])),
    })),
  };

  return {
    summary: lines.join(" "),
    notes: out,
    chart,
    table,
    total: result.total,
    rangeLabel: range.label,
    revenueVisible: result.revenue_visible,
    truncated: result.truncated,
  };
}
