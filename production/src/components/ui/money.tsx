/**
 * Money — the one way a rupee figure is rendered.
 *
 * WHY: `rupee()` returns a string, so the typography was up to each of ~120
 * files. Most got `tabular-nums` right; some didn't, and a non-tabular figure
 * REFLOWS as it updates — the KPI strip visibly jitters while numbers land.
 * This component makes the correct treatment the default instead of a habit.
 *
 * TYPOGRAPHY — deliberately NOT `font-mono`.
 * CLAUDE.md §6 reserves mono for IDs, GSTIN and IRN, and gives big numbers the
 * serif face; the codebase already renders money as `font-serif tabular-nums`.
 * Switching ~900 call sites to mono would break that hierarchy for no gain —
 * what actually prevents the jitter is `tabular-nums`, which every variant here
 * sets. `display` keeps the serif; `cell` uses the UI sans at table density.
 *
 * SEMANTIC COLOUR (the roles are fixed — don't pass arbitrary classes):
 *   positive → emerald · paid, active, money in
 *   negative → rose    · overdue, suspended, money out
 *   muted    → ink-3   · secondary or historical figures
 *   default  → ink     · a neutral amount
 */
import { rupee } from "@/lib/utils";
import { cn } from "@/lib/utils";

export type MoneyTone = "default" | "positive" | "negative" | "muted";
export type MoneySize = "display" | "cell" | "inline";

interface MoneyProps {
  /** Whole rupees. `null`/`undefined` renders an em dash, never "₹0" or "₹NaN". */
  amount: number | null | undefined;
  tone?: MoneyTone;
  size?: MoneySize;
  /** ₹1.5L / ₹1.2Cr instead of the full figure — for dense KPI tiles. */
  compact?: boolean;
  /**
   * Colour a negative amount rose automatically. On by default because a
   * negative is nearly always money out; pass `false` where a negative is
   * expected and neutral (a GST input credit, say).
   */
  autoNegative?: boolean;
  className?: string;
  title?: string;
}

const TONE: Record<MoneyTone, string> = {
  default:  "text-ink",
  positive: "text-emerald",
  negative: "text-rose",
  muted:    "text-ink-3",
};

const SIZE: Record<MoneySize, string> = {
  // Serif for the figures that carry a page — KPI values, totals (§6).
  display: "font-serif text-[22px] leading-none font-bold",
  // Table density: the UI sans, still tabular so columns stay aligned.
  cell:    "text-sm font-semibold",
  // Inside a sentence — inherits size, only the numerals are constrained.
  inline:  "font-medium",
};

export function Money({
  amount, tone = "default", size = "cell", compact = false,
  autoNegative = true, className, title,
}: MoneyProps) {
  const missing = amount === null || amount === undefined;
  const effectiveTone: MoneyTone =
    !missing && autoNegative && amount < 0 && tone === "default" ? "negative" : tone;

  return (
    <span
      // `tabular-nums` is the whole point: without it a figure changes width as
      // it updates and the row jumps. `tracking-tight` keeps long ₹ figures from
      // pushing a column wide.
      className={cn(
        "tabular-nums tracking-tight",
        SIZE[size],
        missing ? "text-ink-3" : TONE[effectiveTone],
        className,
      )}
      // The full figure stays reachable when the display is compacted.
      title={title ?? (compact && !missing ? rupee(amount) : undefined)}
    >
      {missing ? "—" : rupee(amount, { compact })}
    </span>
  );
}
