/**
 * CollapsibleKpiStrip — R-2266 (Design D6, "work list above the fold").
 *
 * Quotes, Invoices, Renewals, Companies and Subscriptions each opened with a block of
 * KPI tiles (plus intelligence / commitment banners) above the list, so the owner
 * scrolled past them on every visit before reaching the first row (design audit 31 Oct,
 * 1280×800: first row at y=874 on Quotes, 686 on Invoices). This is the ONE strip all
 * five pages use:
 *
 *  - closed by default — the closed line carries the key numbers inline (`summary`), so
 *    closing hides the detail, never the fact;
 *  - open, the header shows only the title: the tiles below carry the same numbers, and
 *    printing them twice breaks "one fact, one place" (rule 1);
 *  - `extras` stay on the line open or closed — short linked counts for banners that used
 *    to sit under the strip (e.g. "Commitment due 2 · ₹6,257"), one click to their list;
 *  - open / closed is remembered per user (this browser), keyed by the signed-in user id,
 *    wrapped in try/catch: private mode or blocked storage just means "closed".
 *
 * Starts closed on the server and on first paint, then reads the saved choice — reading
 * storage during render would make server and client disagree.
 */
"use client";

import * as React from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";

/** Storage key of one strip for one user. Null without a user — nothing is read or written. */
export function kpiStripKey(stripId: string, userId: string | null | undefined): string | null {
  return userId ? `ros.kpi-strip.${stripId}.${userId}` : null;
}

/** Open / closed state of one strip, remembered per user. Closed until a saved "open" is read. */
export function useKpiStripOpen(stripId: string, userId: string | null | undefined) {
  const key = kpiStripKey(stripId, userId);
  const [open, setOpen] = React.useState(false);
  React.useEffect(() => {
    if (!key) return;
    try { setOpen(window.localStorage.getItem(key) === "open"); } catch { /* storage blocked */ }
  }, [key]);
  const toggle = React.useCallback(() => {
    setOpen((o) => {
      const next = !o;
      if (key) {
        try { window.localStorage.setItem(key, next ? "open" : "closed"); } catch { /* storage blocked */ }
      }
      return next;
    });
  }, [key]);
  return [open, toggle] as const;
}

const TONE: Record<NonNullable<StripFactProps["tone"]>, string> = {
  default: "text-ink",
  rose: "text-rose-ink",
  emerald: "text-emerald",
  amber: "text-amber-ink",
};

export interface StripFactProps {
  label: string;
  value: React.ReactNode;
  /** Optional count shown after the value in brackets, e.g. "₹2.1L (4)". */
  count?: number;
  tone?: "default" | "rose" | "emerald" | "amber";
}

/** One "Label ₹value (n)" fact on the closed line, with the dot separator before it. */
export function StripFact({ label, value, count, tone = "default" }: StripFactProps) {
  return (
    <>
      <span className="text-ink-3" aria-hidden>·</span>
      <span className="text-ink-2 whitespace-nowrap">
        {label} <b className={cn("tabular-nums", TONE[tone])}>{value}</b>
        {count != null && <span className="tabular-nums"> ({count})</span>}
      </span>
    </>
  );
}

/** A short linked count on the strip line (stays visible open or closed). */
export function StripLink({
  children, onClick, href, tone = "amber", title,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  href?: string;
  tone?: "amber" | "rose" | "default";
  title?: string;
}) {
  const cls = cn(
    "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-2xs font-semibold whitespace-nowrap tabular-nums",
    "hover:underline underline-offset-2 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber",
    tone === "rose" ? "bg-rose-soft text-rose-ink" : tone === "amber" ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-2",
  );
  if (href) return <a href={href} className={cls} title={title}>{children}<Icon name="arrow_right" size={11} /></a>;
  return (
    <button type="button" onClick={onClick} className={cls} title={title}>
      {children}<Icon name="arrow_right" size={11} />
    </button>
  );
}

export function CollapsibleKpiStrip({
  stripId, userId, title, summary, extras, children, className,
}: {
  /** Stable id of the page's strip ("quotes", "invoices", …) — part of the storage key. */
  stripId: string;
  /** Signed-in user's id; the open/closed choice is remembered per user. */
  userId: string | null | undefined;
  title: string;
  /** Key numbers for the CLOSED line (StripFact …). Hidden when open — the tiles carry them. */
  summary?: React.ReactNode;
  /** Linked counts / actions kept on the line open or closed. */
  extras?: React.ReactNode;
  /** The tiles and cards shown when open. */
  children: React.ReactNode;
  className?: string;
}) {
  const [open, toggle] = useKpiStripOpen(stripId, userId);
  const bodyId = React.useId();
  return (
    <div
      data-kpi-strip={stripId}
      data-open={open ? "true" : "false"}
      className={cn("mb-3 bg-paper border border-hairline rounded-lg overflow-hidden shadow-xs", className)}
    >
      <div className="flex items-center gap-2 bg-paper-2/70">
        <button
          type="button"
          onClick={toggle}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex-1 min-w-0 flex items-center justify-between gap-2 px-3.5 py-2 hover:bg-paper-2 transition-colors text-left cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-amber"
        >
          <span className="flex items-center gap-x-2 gap-y-1 flex-wrap text-xs min-w-0">
            <Icon name="bar_chart" size={15} className="text-amber-ink" />
            <span className="font-semibold text-ink">{title}</span>
            {!open && summary}
          </span>
          <span className="flex items-center gap-1 text-xs font-semibold text-amber-ink shrink-0">
            <span>{open ? "Collapse" : "Expand"}</span>
            <Icon name={open ? "chevron_up" : "chevron_down"} size={14} />
          </span>
        </button>
        {extras && (
          <div data-kpi-strip-extras className="flex items-center gap-1.5 flex-wrap pr-3 py-1.5 shrink-0">
            {extras}
          </div>
        )}
      </div>
      <div id={bodyId} hidden={!open} className="p-3 border-t border-hairline space-y-3 bg-paper">
        {open && children}
      </div>
    </div>
  );
}
