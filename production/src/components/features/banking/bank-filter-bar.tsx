/**
 * R-1869 — the bank page's one filter row: Money in / Money out, a "Filters" panel (popover on a
 * laptop, bottom sheet on a phone), sort, search and Export CSV; then the active filters as
 * removable chips and the totals of what is on screen.
 *
 * The status tabs (All / Unmatched / Reconciled) stay in the page's own row next to
 * Auto-reconcile — they are not repeated here as chips (one fact, one place). All state lives in
 * lib/banking/bank-filters (pure, tested); this file only draws it.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import {
  MATCH_GROUPS,
  MATCH_GROUP_LABEL,
  NEED_KEYS,
  NEED_LABEL,
  SORT_LABEL,
  DATE_PRESET_LABEL,
  activeFilterChips,
  clearFilters,
  datePreset,
  hasAnyFilter,
  panelFilterCount,
  removeFilter,
  type BankFilters,
  type DatePreset,
  type FacetCounts,
  type FilterTotals,
  type NeedKey,
  type SortKey,
} from "@/lib/banking/bank-filters";
import { rupee } from "@/lib/utils";

export type ImportOption = { key: string; label: string; count: number };

export type BankFilterBarProps = {
  filters: BankFilters;
  onChange: (next: BankFilters) => void;
  counts: FacetCounts;
  totals: FilterTotals;
  /** Needs-attention lists this viewer can use (the page leaves out the ones it did not work out). */
  needs: readonly NeedKey[];
  imports: readonly ImportOption[];
  /** IST today, for the date presets. */
  todayIso: string;
  onExport: () => void;
};

const inputCls =
  "w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm focus:outline-none focus:border-hairline-strong";

export function BankFilterBar({ filters: f, onChange, counts, totals, needs, imports, todayIso, onExport }: BankFilterBarProps) {
  const set = (patch: Partial<BankFilters>) => onChange({ ...f, ...patch });
  const panelCount = panelFilterCount(f);
  const importLabel = (k: string) => imports.find((i) => i.key === k)?.label ?? null;
  // Status and direction have their own controls on screen — no chip repeats them.
  const chips = activeFilterChips(f, { importLabel }).filter((c) => c.key !== "status" && c.key !== "dir");
  const [sheetOpen, setSheetOpen] = React.useState(false);

  const panel = (
    <FiltersPanel f={f} set={set} counts={counts} needs={needs} imports={imports} todayIso={todayIso} />
  );
  const filtersLabel = panelCount > 0 ? `Filters (${panelCount})` : "Filters";

  return (
    <div className="mb-3 space-y-2">
      {/* One filter row — wraps on a phone. */}
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Money in or out" className="inline-flex rounded-md border border-hairline bg-paper p-0.5">
          {(["all", "in", "out"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={f.dir === d}
              onClick={() => set({ dir: d })}
              className={`rounded px-2.5 py-1 text-xs font-medium whitespace-nowrap [@media(pointer:coarse)]:min-h-10 ${
                f.dir === d ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2"
              }`}
            >
              {d === "all" ? "All" : d === "in" ? "Money in" : "Money out"}
              <span className={`ml-1 tabular-nums ${f.dir === d ? "opacity-80" : "text-ink-3"}`}>{counts.dir[d]}</span>
            </button>
          ))}
        </div>

        {/* Laptop: popover. Phone: bottom sheet (same panel). */}
        <div className="hidden md:block">
          <Popover>
            <PopoverTrigger asChild>
              <Button variant={panelCount > 0 ? "outline" : "default"} size="sm" icon="filter" aria-label={filtersLabel}>
                {filtersLabel}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="start" className="w-[24rem] max-h-[70vh] overflow-y-auto p-0">
              {panel}
            </PopoverContent>
          </Popover>
        </div>
        <div className="md:hidden">
          <Button variant={panelCount > 0 ? "outline" : "default"} size="sm" icon="filter" onClick={() => setSheetOpen(true)} aria-label={filtersLabel}>
            {filtersLabel}
          </Button>
          <Sheet open={sheetOpen} onOpenChange={setSheetOpen}>
            <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto rounded-t-xl p-0">
              <SheetHeader className="p-4">
                <SheetTitle>Filters</SheetTitle>
                <SheetDescription>{totals.count} lines match</SheetDescription>
              </SheetHeader>
              {panel}
              <div className="sticky bottom-0 border-t border-hairline bg-paper p-3">
                <Button variant="primary" className="w-full" onClick={() => setSheetOpen(false)}>
                  {`Show ${totals.count} lines`}
                </Button>
              </div>
            </SheetContent>
          </Sheet>
        </div>

        <label className="sr-only" htmlFor="bank-sort">Sort</label>
        <select
          id="bank-sort"
          value={f.sort}
          onChange={(e) => set({ sort: e.target.value as SortKey })}
          className="h-8 rounded-md border border-hairline bg-paper px-2 text-xs text-ink-2 [@media(pointer:coarse)]:min-h-10"
        >
          {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </select>

        <div className="relative min-w-[12rem] flex-1 basis-full sm:basis-auto">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <input
            type="text"
            value={f.q}
            onChange={(e) => set({ q: e.target.value })}
            placeholder="Search description, reference or amount…"
            aria-label="Search transactions"
            className="h-8 w-full rounded-md border border-hairline bg-paper pl-8 pr-8 text-sm focus:outline-none focus:border-hairline-strong [@media(pointer:coarse)]:min-h-10"
          />
          {f.q && (
            <button type="button" onClick={() => set({ q: "" })}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-ink-3 hover:text-ink" aria-label="Clear search">
              <Icon name="x" size={14} />
            </button>
          )}
        </div>

        <Button variant="default" size="sm" icon="download" onClick={onExport} disabled={totals.count === 0}
          title="Download exactly the lines shown by these filters as a CSV">
          Export CSV
        </Button>
      </div>

      {/* Active filters — each removable — and Clear all. */}
      {(chips.length > 0 || hasAnyFilter(f)) && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label="Active filters">
          {chips.map((c) => (
            <span key={c.key} className="inline-flex items-center gap-1 rounded-full border border-amber/40 bg-amber/10 py-0.5 pl-2.5 pr-1 text-xs text-amber-ink">
              {c.label}
              <button type="button" onClick={() => onChange(removeFilter(f, c.key))}
                className="rounded-full p-0.5 hover:bg-amber/20 [@media(pointer:coarse)]:p-1.5" aria-label={`Remove filter: ${c.label}`}>
                <Icon name="x" size={11} />
              </button>
            </span>
          ))}
          {hasAnyFilter(f) && (
            <button type="button" onClick={() => onChange(clearFilters(f))} className="px-1 text-xs text-ink-3 underline-offset-2 hover:text-ink hover:underline">
              Clear all
            </button>
          )}
        </div>
      )}

      {/* Totals of exactly what the filters show (every page, not just the lines drawn). */}
      <p className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-ink-2 tabular-nums" aria-live="polite">
        <span><b className="text-ink">{totals.count.toLocaleString("en-IN")}</b> {totals.count === 1 ? "line" : "lines"}</span>
        <span>In <b className="text-emerald">{rupee(totals.moneyIn)}</b></span>
        <span>Out <b className="text-rose">{rupee(totals.moneyOut)}</b></span>
        <span>Net <b className={totals.net < 0 ? "text-rose" : "text-ink"}>{rupee(totals.net)}</b></span>
      </p>
    </div>
  );
}

// ============================================================
// The panel — date, amount, matched to, needs attention, statement file
// ============================================================
function FiltersPanel({ f, set, counts, needs, imports, todayIso }: {
  f: BankFilters;
  set: (patch: Partial<BankFilters>) => void;
  counts: FacetCounts;
  needs: readonly NeedKey[];
  imports: readonly ImportOption[];
  todayIso: string;
}) {
  const presetActive = (p: DatePreset) => {
    const r = datePreset(p, todayIso);
    return f.from === r.from && f.to === r.to;
  };
  const groups = MATCH_GROUPS.filter((g) => counts.types[g] > 0 || f.types.includes(g));
  const needList = NEED_KEYS.filter((k) => needs.includes(k));
  const numVal = (v: string) => (v.trim() === "" ? null : Math.max(0, Math.round(Number(v))) || 0);

  return (
    <div className="divide-y divide-hairline text-sm">
      <Section title="Date">
        <div className="flex flex-wrap gap-1.5">
          {(Object.keys(DATE_PRESET_LABEL) as DatePreset[]).map((p) => (
            <Chip key={p} pressed={presetActive(p)} onClick={() => set(presetActive(p) ? { from: null, to: null } : datePreset(p, todayIso))}>
              {DATE_PRESET_LABEL[p]}
            </Chip>
          ))}
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-2xs text-ink-3">From
            <input type="date" value={f.from ?? ""} max={f.to ?? undefined} onChange={(e) => set({ from: e.target.value || null })} className={inputCls} />
          </label>
          <label className="text-2xs text-ink-3">To
            <input type="date" value={f.to ?? ""} min={f.from ?? undefined} onChange={(e) => set({ to: e.target.value || null })} className={inputCls} />
          </label>
        </div>
      </Section>

      <Section title="Amount (₹)">
        <div className="grid grid-cols-3 gap-2">
          <label className="text-2xs text-ink-3">Min
            <input type="number" inputMode="numeric" min={0} value={f.min ?? ""} disabled={f.exact !== null}
              onChange={(e) => set({ min: numVal(e.target.value) })} className={inputCls} />
          </label>
          <label className="text-2xs text-ink-3">Max
            <input type="number" inputMode="numeric" min={0} value={f.max ?? ""} disabled={f.exact !== null}
              onChange={(e) => set({ max: numVal(e.target.value) })} className={inputCls} />
          </label>
          <label className="text-2xs text-ink-3">Exact
            <input type="number" inputMode="numeric" min={0} value={f.exact ?? ""}
              onChange={(e) => set({ exact: numVal(e.target.value) })} className={inputCls} />
          </label>
        </div>
      </Section>

      <Section title="Matched to">
        {groups.length === 0 ? (
          <p className="text-xs text-ink-3">No reconciled lines in this view yet.</p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {groups.map((g) => {
              const on = f.types.includes(g);
              return (
                <Chip key={g} pressed={on} onClick={() => set({ types: on ? f.types.filter((x) => x !== g) : [...f.types, g] })}>
                  {MATCH_GROUP_LABEL[g]} <span className="tabular-nums text-ink-3">{counts.types[g]}</span>
                </Chip>
              );
            })}
          </div>
        )}
      </Section>

      <Section title="Needs attention">
        <div className="flex flex-col items-start gap-1.5">
          {needList.map((k) => (
            <Chip key={k} pressed={f.need === k} onClick={() => set({ need: f.need === k ? null : k })}>
              {NEED_LABEL[k]} <span className="tabular-nums text-ink-3">{counts.need[k]}</span>
            </Chip>
          ))}
        </div>
      </Section>

      {imports.length > 0 && (
        <Section title="Statement file">
          <label className="sr-only" htmlFor="bank-import-filter">Statement file</label>
          <select id="bank-import-filter" value={f.imp ?? ""} onChange={(e) => set({ imp: e.target.value || null })} className={inputCls}>
            <option value="">All imports</option>
            {imports.map((i) => <option key={i.key} value={i.key}>{`${i.label} · ${i.count} lines`}</option>)}
          </select>
        </Section>
      )}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="p-4">
      <p className="mb-2 text-3xs font-semibold uppercase tracking-wider text-ink-3">{title}</p>
      {children}
    </div>
  );
}

function Chip({ pressed, onClick, children }: { pressed: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium [@media(pointer:coarse)]:min-h-10 ${
        pressed ? "border-amber bg-amber/10 text-amber-ink" : "border-hairline bg-paper text-ink-2 hover:border-hairline-strong"
      }`}
    >
      {children}
    </button>
  );
}
