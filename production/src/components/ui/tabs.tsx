/**
 * Tabs — accessible tab navigation built on Radix.
 *
 * Two API styles:
 *
 * 1. Headless (Radix) — for layouts with custom tab content panes
 * @example
 * <Tabs defaultValue="active">
 *   <TabsList>
 *     <TabsTrigger value="active">Active <TabBadge>14</TabBadge></TabsTrigger>
 *     <TabsTrigger value="expired">Expired</TabsTrigger>
 *   </TabsList>
 *   <TabsContent value="active">...</TabsContent>
 * </Tabs>
 *
 * 2. Simple — like prototype's <Tabs> with count badges
 * @example
 * <TabBar
 *   value={tab}
 *   onChange={setTab}
 *   items={[
 *     { id: "all",      label: "All",      count: 24 },
 *     { id: "active",   label: "Active",   count: 14, dot: "emerald" },
 *     { id: "expired",  label: "Expired",  count: 3,  dot: "rose" },
 *   ]}
 * />
 */
"use client";

import * as React from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import { cn } from "@/lib/utils";

// ============================================================
// Radix headless tabs (for complex layouts)
// ============================================================
const Tabs = TabsPrimitive.Root;

const TabsList = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.List
    ref={ref}
    className={cn(
      "inline-flex items-center gap-1 border-b border-hairline w-full",
      className
    )}
    {...props}
  />
));
TabsList.displayName = "TabsList";

const TabsTrigger = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Trigger
    ref={ref}
    className={cn(
      "relative inline-flex items-center gap-2 px-3 py-2 text-sm font-medium",
      "text-ink-3 hover:text-ink transition-colors",
      "border-b-2 border-transparent -mb-px",
      "data-[state=active]:text-ink data-[state=active]:border-amber",
      "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 rounded-t-md",
      "disabled:opacity-50",
      className
    )}
    {...props}
  />
));
TabsTrigger.displayName = "TabsTrigger";

const TabsContent = React.forwardRef<
  React.ElementRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      "mt-4 focus-visible:outline-none",
      className
    )}
    {...props}
  />
));
TabsContent.displayName = "TabsContent";

// ============================================================
// Simple TabBar (matches prototype API — no content panes)
// ============================================================
export interface TabBarItem {
  id: string;
  label: string;
  count?: number;
  /** Status dot color (left of label) */
  dot?: "emerald" | "amber" | "rose" | "indigo" | "slate";
  /** Disable this tab */
  disabled?: boolean;
}

interface TabBarProps {
  value: string;
  onChange: (id: string) => void;
  items: TabBarItem[];
  className?: string;
}

/**
 * When the tabs do not fit, the bar becomes ONE dropdown (2 Oct 2026, Pardeep: "dropdown me
 * dikhao saare tabs ko, overflow ho rahe hai"). It measures, rather than switching at a
 * breakpoint: three short tabs fit on a phone and stay tabs; seven long ones on a laptop
 * side pane become a dropdown. A hidden copy of the row gives the natural width; the bar
 * re-checks on every resize. First paint (and jsdom) is the tab row.
 */
function useTabsOverflow(deps: unknown) {
  const wrapRef = React.useRef<HTMLDivElement | null>(null);
  const measureRef = React.useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = React.useState(false);
  React.useLayoutEffect(() => {
    const wrap = wrapRef.current, measure = measureRef.current;
    if (!wrap || !measure || typeof ResizeObserver === "undefined") return;
    const check = () => setOverflow(wrap.clientWidth > 0 && measure.scrollWidth > wrap.clientWidth + 1);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [deps]);
  return { wrapRef, measureRef, overflow };
}

function TabBar({ value, onChange, items, className }: TabBarProps) {
  const sig = items.map((i) => `${i.id}:${i.label}:${i.count ?? ""}`).join("|");
  const { wrapRef, measureRef, overflow } = useTabsOverflow(sig);
  return (
    <div ref={wrapRef} className={cn("relative w-full", className)}>
      {/* Natural width of the row, never seen — only measured. */}
      <div ref={measureRef} aria-hidden className="invisible pointer-events-none absolute left-0 top-0 h-0 overflow-hidden inline-flex gap-1 whitespace-nowrap">
        {items.map((item) => (
          <span key={item.id} className="inline-flex items-center gap-2 px-3 py-2 text-sm font-medium">
            {item.dot && <span className="w-1.5 h-1.5" />}
            <span>{item.label}</span>
            {item.count !== undefined && <span className="ml-0.5 text-xs px-1.5 py-0.5">{item.count}</span>}
          </span>
        ))}
      </div>
      {overflow ? (
        <label className="flex items-center gap-2 border-b border-hairline pb-2 text-sm">
          <span className="text-ink-3">Show</span>
          <select
            aria-label="View"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            className="flex-1 min-w-0 rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm font-medium text-ink focus:outline-none focus:ring-2 focus:ring-amber/40"
          >
            {items.map((item) => (
              <option key={item.id} value={item.id} disabled={item.disabled}>
                {item.label}{item.count !== undefined ? ` (${item.count})` : ""}
              </option>
            ))}
          </select>
        </label>
      ) : (
    <div
      role="tablist"
      className="inline-flex items-center gap-1 border-b border-hairline w-full overflow-x-auto overflow-y-hidden"
    >
      {items.map((item) => {
        const active = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={item.disabled}
            onClick={() => onChange(item.id)}
            className={cn(
              "relative inline-flex items-center gap-2 px-3 py-2 text-sm font-medium whitespace-nowrap",
              "transition-colors border-b-2 -mb-px",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber focus-visible:ring-offset-2 rounded-t-md",
              active
                ? "text-ink border-amber"
                : "text-ink-3 hover:text-ink border-transparent",
              item.disabled && "opacity-50 cursor-not-allowed"
            )}
          >
            {item.dot && (
              <span
                className={cn(
                  "w-1.5 h-1.5 rounded-full flex-shrink-0",
                  item.dot === "emerald" && "bg-emerald",
                  item.dot === "amber" && "bg-amber",
                  item.dot === "rose" && "bg-rose",
                  item.dot === "indigo" && "bg-indigo",
                  item.dot === "slate" && "bg-slate"
                )}
              />
            )}
            <span>{item.label}</span>
            {item.count !== undefined && (
              <span
                className={cn(
                  "ml-0.5 text-xs px-1.5 py-0.5 rounded-full tabular-nums",
                  active ? "bg-amber-soft text-amber-ink" : "bg-paper-2 text-ink-3"
                )}
              >
                {item.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
      )}
    </div>
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, TabBar };
