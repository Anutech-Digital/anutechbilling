/**
 * KPI — dashboard / report metric tile.
 *
 * @example
 * <KPI label="MRR" value={420000} unit="₹" trend="+12%" trendKind="up" />
 * <KPI label="High-risk renewals" value={3} trend="₹8.5L ARR at risk" trendKind="down" icon="alert" />
 */
import Link from "next/link";
import type { Route } from "next";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, num } from "@/lib/utils";

interface KPIProps {
  label: string;
  value: string | number;
  /** Optional unit suffix (e.g., "%", "/5") */
  unit?: string;
  /** Trend label */
  trend?: string;
  /** Trend direction */
  trendKind?: "up" | "down" | "neutral";
  /** Icon name (lucide-compatible) */
  icon?: string;
  /** Trend-specific icon (overrides default arrow) */
  trendIcon?: string;
  /** Format the value as INR rupee */
  asCurrency?: boolean;
  /** Compact INR (e.g., ₹4.2L) */
  compact?: boolean;
  /** Loading state */
  loading?: boolean;
  className?: string;
  /** Colour the big value to signal meaning (money = emerald, risk = rose). */
  accent?: "emerald" | "amber" | "rose" | "ink";
  /** Click handler — makes the tile interactive */
  onClick?: () => void;
  /**
   * R-118: the list that holds exactly the records this number counts. Renders a real link
   * (middle-click / new tab work), and wins over onClick.
   */
  href?: string;
}

export function KPI({
  label,
  value,
  unit,
  trend,
  trendKind = "neutral",
  icon,
  trendIcon,
  asCurrency,
  compact,
  loading,
  className,
  accent = "ink",
  onClick,
  href,
}: KPIProps) {
  const valueColor = {
    emerald: "text-emerald",
    amber:   "text-amber-ink",
    rose:    "text-rose",
    ink:     "text-ink",
  }[accent];
  const Component = onClick ? "button" : "div";

  // Format value
  let displayValue: string | number = value;
  if (typeof value === "number") {
    if (asCurrency) displayValue = rupee(value, { compact });
    else if (compact) displayValue = num(value);
  }

  const trendColor = {
    up:     "text-emerald",
    down:   "text-rose",
    neutral: "text-ink-3",
  }[trendKind];

  const defaultTrendIcon = trendKind === "up" ? "trending_up" : trendKind === "down" ? "trending_down" : undefined;
  const effectiveTrendIcon = trendIcon ?? defaultTrendIcon;

  const tileClass = cn(
    "block w-full text-left p-4 bg-paper border border-hairline rounded-lg",
    "transition-shadow",
    (onClick || href) && "hover:shadow-md hover:border-hairline-strong cursor-pointer focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2",
    className,
  );
  const body = (
    <>
      {/* Label row */}
      <div className="flex items-center gap-2 text-xs text-ink-3 mb-2">
        {icon && <Icon name={icon} size={13} />}
        <span className="font-medium uppercase tracking-wide text-2xs">{label}</span>
      </div>

      {/* Value */}
      {loading ? (
        <div className="h-8 w-24 skeleton-shimmer rounded" />
      ) : (
        <div className={cn("font-serif text-3xl tabular-nums leading-none mb-2", valueColor)}>
          {displayValue}
          {/* R-316: a word unit ("days") gets a real space — copied/read text said "0days".
              A symbol unit ("%", "/5") stays tight with only the visual margin. */}
          {unit && /^[A-Za-z]/.test(unit) ? " " : null}
          {unit && <span className={cn("text-base text-ink-3 font-sans", !/^[A-Za-z]/.test(unit) && "ml-1")}>{unit}</span>}
        </div>
      )}

      {/* Trend */}
      {trend && !loading && (
        <div className={cn("flex items-center gap-1 text-xs", trendColor)}>
          {effectiveTrendIcon && <Icon name={effectiveTrendIcon} size={11} />}
          <span>{trend}</span>
        </div>
      )}
    </>
  );

  if (href) {
    return <Link href={href as Route} className={tileClass}>{body}</Link>;
  }
  return <Component onClick={onClick} className={tileClass}>{body}</Component>;
}
