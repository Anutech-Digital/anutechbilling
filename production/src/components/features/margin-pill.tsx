/**
 * MarginPill — the reseller moat indicator.
 *
 * Shows your margin (price − cost) with color-coded tier.
 * Use this everywhere you display revenue: subscriptions, invoices, quotes, dashboard.
 *
 * Tiers:
 * - Healthy:  ≥ 18% (green) — your strongest deals
 * - OK:       14-17% (amber) — typical
 * - Squeeze:  < 14% (red) — barely worth it, push for upgrade
 *
 * @example
 * <MarginPill margin={{ cost: 6500, price: 8640, margin: 2140, marginPct: 25 }} />
 * <MarginPill margin={...} variant="compact" />  // just the %, no ₹
 * <MarginPill margin={...} period="monthly" />   // annotates the period
 */
import { cn, rupee } from "@/lib/utils";
import type { Margin } from "@/lib/types";

interface MarginPillProps {
  margin: Margin;
  /** Display style */
  variant?: "default" | "compact" | "detailed";
  /** Annotates the time period */
  period?: "monthly" | "annual" | "one-time";
  /** Override the tier thresholds */
  thresholds?: { healthy: number; squeeze: number };
  /** When true, flags this as an ESTIMATE (cost is assumed/catalog, not actual
   *  procurement cost yet) so we never present a guessed margin as hard fact. */
  estimated?: boolean;
  className?: string;
}

export function MarginPill({
  margin,
  variant = "default",
  period,
  thresholds = { healthy: 18, squeeze: 14 },
  estimated = false,
  className,
}: MarginPillProps) {
  const estHint = estimated
    ? " · estimate (based on assumed/catalog cost — edit each line's cost to make it exact)"
    : "";
  const tier =
    margin.marginPct >= thresholds.healthy
      ? "healthy"
      : margin.marginPct >= thresholds.squeeze
        ? "ok"
        : "squeeze";

  const colors = {
    healthy: "text-emerald",
    ok: "text-amber-ink",
    squeeze: "text-rose",
  }[tier];

  const bg = {
    healthy: "bg-emerald-soft",
    ok: "bg-amber-soft",
    squeeze: "bg-rose-soft",
  }[tier];

  if (variant === "compact") {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-semibold tabular-nums",
          bg,
          colors,
          className
        )}
        title={`Margin: ${rupee(margin.margin)} / ${margin.marginPct}% (cost: ${rupee(margin.cost)}, price: ${rupee(margin.price)})${estHint}`}
      >
        {estimated ? "~" : ""}{margin.marginPct}%
      </span>
    );
  }

  if (variant === "detailed") {
    return (
      <div
        className={cn(
          "inline-flex flex-col items-end px-2 py-1 rounded border border-hairline bg-paper text-right",
          className
        )}
      >
        <span className={cn("font-semibold text-sm tabular-nums", colors)}>
          {rupee(margin.margin)}
        </span>
        <span className="text-[10px] text-ink-3 tabular-nums">
          {margin.marginPct}%{estimated ? " est." : ""} margin · ₹{margin.cost.toLocaleString("en-IN")} cost
          {period && ` · ${period}`}
        </span>
      </div>
    );
  }

  // default
  return (
    <span
      className={cn(
        "inline-flex flex-col items-end tabular-nums leading-tight",
        className
      )}
      title={`Cost: ${rupee(margin.cost)} · Price: ${rupee(margin.price)} · Margin: ${rupee(margin.margin)} (${margin.marginPct}%)${estHint}`}
    >
      <span className={cn("font-semibold text-sm", colors)}>{rupee(margin.margin)}</span>
      <span className="text-[10px] text-ink-3">
        {estimated ? "~" : ""}{margin.marginPct}%{estimated ? " est." : ""}
        {period && ` ${period === "monthly" ? "/mo" : period === "annual" ? "/yr" : ""}`}
      </span>
    </span>
  );
}

/**
 * Compute Margin from cost + price.
 * Use this helper in feature code so all margin objects are consistent.
 */
export function computeMargin(cost: number, price: number): Margin {
  const margin = price - cost;
  const marginPct = price > 0 ? Math.round((margin / price) * 100) : 0;
  return { cost, price, margin, marginPct };
}
