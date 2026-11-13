/**
 * R-2726 — the filter row of /admin/feedback: search, a "Filters" panel, sort, the two quick
 * chips ("New since my last visit", "Real users"), then the active filters as removable chips
 * and the result count. Same shape as the bank page's filter bar (R-1869): all state lives in
 * lib/feedback/list-filters (pure, tested); this file only draws it.
 *
 * The status tabs stay in the page's own row — they are not repeated here (one fact, one place).
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  CARD_FILTERS,
  CARD_FILTER_LABEL,
  SEVERITY_FILTERS,
  SEVERITY_FILTER_LABEL,
  SORT_KEYS,
  SORT_LABEL,
  TYPE_FILTERS,
  TYPE_FILTER_LABEL,
  activeFilterChips,
  hasAnyFilter,
  removeFilter,
  type FacetOption,
  type FeedbackFacets,
  type FeedbackFilters,
  type FeedbackScope,
  type SortKey,
} from "@/lib/feedback/list-filters";

export interface FeedbackFilterBarProps {
  filters: FeedbackFilters;
  /** Every change goes back to page 1 — the caller does not have to remember. */
  onChange: (next: FeedbackFilters) => void;
  onClear: () => void;
  scope: FeedbackScope;
  facets: FeedbackFacets | null | undefined;
  /** Reports matching everything, across pages; undefined while the first load runs. */
  total: number | undefined;
  /** "12 Nov, 02:30 pm" — when this viewer last opened the page; null on a first visit. */
  sinceLabel: string | null;
}

const inputCls =
  "w-full rounded-md border border-hairline bg-paper px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:border-hairline-strong";
const labelCls = "block text-2xs font-semibold uppercase tracking-wide text-ink-3 mb-1";

function chipCls(on: boolean): string {
  return "rounded-full border px-2.5 py-1 text-xs font-medium whitespace-nowrap transition-colors [@media(pointer:coarse)]:min-h-10 " +
    (on ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline text-ink-2 hover:bg-paper-2");
}

/** How many of the panel's filters are on — shown on the Filters button. */
function panelCount(f: FeedbackFilters): number {
  return [f.workspace, f.reporter, f.page, f.from || f.to, f.type !== "all", f.severity !== "all", f.card !== "all"].filter(Boolean).length;
}

export function FeedbackFilterBar({ filters: f, onChange, onClear, scope, facets, total, sinceLabel }: FeedbackFilterBarProps) {
  const set = (patch: Partial<FeedbackFilters>) => onChange({ ...f, ...patch, pageNo: 1 });

  /* The box keeps its own text and hands it over after a short pause (or Enter), so the
     list is not re-read on every key. */
  const [text, setText] = React.useState(f.q);
  React.useEffect(() => { setText(f.q); }, [f.q]);
  const fRef = React.useRef(f);
  fRef.current = f;
  const onChangeRef = React.useRef(onChange);
  onChangeRef.current = onChange;
  React.useEffect(() => {
    if (text.trim() === fRef.current.q) return;
    const t = setTimeout(() => onChangeRef.current({ ...fRef.current, q: text.trim(), pageNo: 1 }), 350);
    return () => clearTimeout(t);
  }, [text]);

  const count = panelCount(f);
  const filtersLabel = count > 0 ? `Filters (${count})` : "Filters";
  const chips = activeFilterChips(scope === "all" ? f : { ...f, workspace: "" }, facets);

  return (
    <div className="space-y-2" data-testid="feedback-filter-bar">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-[14rem] flex-1 basis-full sm:basis-auto">
          <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" />
          <label className="sr-only" htmlFor="feedback-search">Search reports</label>
          <input
            id="feedback-search"
            type="search"
            value={text}
            maxLength={100}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") set({ q: text.trim() }); }}
            placeholder="Search title, report text, reporter, page or card id (R-…)"
            className="h-8 w-full rounded-md border border-hairline bg-paper pl-8 pr-2.5 text-sm text-ink focus:outline-none focus:border-hairline-strong [@media(pointer:coarse)]:min-h-10"
          />
        </div>

        <Popover>
          <PopoverTrigger asChild>
            <Button variant={count > 0 ? "outline" : "default"} size="sm" icon="filter" aria-label={filtersLabel}>
              {filtersLabel}
            </Button>
          </PopoverTrigger>
          {/* Fit the space Radix measured, so a low trigger never pushes the panel off-screen. */}
          <PopoverContent align="start" side="bottom" collisionPadding={12}
            className="w-[22rem] max-w-[calc(100vw-1.5rem)] overflow-y-auto p-3"
            style={{ maxHeight: "min(70vh, var(--radix-popover-content-available-height))" }}>
            <FiltersPanel f={f} set={set} scope={scope} facets={facets} />
          </PopoverContent>
        </Popover>

        <label className="sr-only" htmlFor="feedback-sort">Sort</label>
        <select
          id="feedback-sort"
          value={f.sort}
          onChange={(e) => set({ sort: e.target.value as SortKey })}
          className="h-8 rounded-md border border-hairline bg-paper px-2 text-xs text-ink-2 [@media(pointer:coarse)]:min-h-10"
        >
          {SORT_KEYS.map((k) => <option key={k} value={k}>{SORT_LABEL[k]}</option>)}
        </select>

        <button
          type="button"
          aria-pressed={f.fresh}
          disabled={!sinceLabel}
          onClick={() => set({ fresh: !f.fresh })}
          title={sinceLabel
            ? `Reports filed after you last opened this page (${sinceLabel} IST), on this browser`
            : "Nothing to compare with yet — this is your first visit on this browser"}
          className={chipCls(f.fresh) + " disabled:opacity-50 disabled:cursor-not-allowed"}
        >
          New since my last visit
        </button>
        <button
          type="button"
          aria-pressed={f.real}
          onClick={() => set({ real: !f.real })}
          title="Leaves out reports from the team's own and test addresses (anutech.in, example.*, *.test)"
          className={chipCls(f.real)}
        >
          Real users
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <span data-testid="feedback-result-count" className="font-medium text-ink-2 tabular-nums" aria-live="polite">
          {total === undefined ? "Loading…" : `${total} report${total === 1 ? "" : "s"}`}
        </span>
        {chips.map((c) => (
          <button
            key={c.key}
            type="button"
            onClick={() => onChange(removeFilter(f, c.key))}
            aria-label={`Remove filter: ${c.label}`}
            className="inline-flex max-w-[18rem] items-center gap-1 rounded-full border border-hairline bg-paper-2 px-2 py-0.5 text-ink-2 hover:border-hairline-strong"
          >
            <span className="truncate">{c.label}</span>
            <Icon name="x" size={11} />
          </button>
        ))}
        {hasAnyFilter(f) && (
          <button type="button" onClick={onClear} className="font-medium text-primary hover:underline">
            Clear all filters
          </button>
        )}
      </div>
    </div>
  );
}

function FacetSelect({ id, label, value, options, anyLabel, onPick }: {
  id: string; label: string; value: string; options: FacetOption[]; anyLabel: string; onPick: (v: string) => void;
}) {
  /* A value from the address that is not in the list (yet) still shows as chosen. */
  const known = !value || options.some((o) => o.value === value);
  return (
    <div>
      <label className={labelCls} htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(e) => onPick(e.target.value)} className={inputCls}>
        <option value="">{anyLabel}</option>
        {!known && <option value={value}>{value}</option>}
        {options.map((o) => <option key={o.value} value={o.value}>{`${o.label} (${o.count})`}</option>)}
      </select>
    </div>
  );
}

function FiltersPanel({ f, set, scope, facets }: {
  f: FeedbackFilters; set: (patch: Partial<FeedbackFilters>) => void; scope: FeedbackScope; facets: FeedbackFacets | null | undefined;
}) {
  return (
    <div className="space-y-3">
      {scope === "all" && (
        <FacetSelect id="feedback-f-ws" label="Workspace" value={f.workspace} options={facets?.workspaces ?? []} anyLabel="Every workspace" onPick={(v) => set({ workspace: v })} />
      )}
      <FacetSelect id="feedback-f-reporter" label="Reporter" value={f.reporter} options={facets?.reporters ?? []} anyLabel="Anyone" onPick={(v) => set({ reporter: v })} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls} htmlFor="feedback-f-type">Type</label>
          <select id="feedback-f-type" value={f.type} onChange={(e) => set({ type: e.target.value as FeedbackFilters["type"] })} className={inputCls}>
            {TYPE_FILTERS.map((t) => <option key={t} value={t}>{TYPE_FILTER_LABEL[t]}</option>)}
          </select>
        </div>
        <div>
          <label className={labelCls} htmlFor="feedback-f-sev">Severity</label>
          <select id="feedback-f-sev" value={f.severity} onChange={(e) => set({ severity: e.target.value as FeedbackFilters["severity"] })} className={inputCls}>
            {SEVERITY_FILTERS.map((s) => <option key={s} value={s}>{SEVERITY_FILTER_LABEL[s]}</option>)}
          </select>
        </div>
      </div>
      <FacetSelect id="feedback-f-page" label="Page it was filed on" value={f.page} options={facets?.pages ?? []} anyLabel="Any page" onPick={(v) => set({ page: v })} />
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className={labelCls} htmlFor="feedback-f-from">Filed from (IST)</label>
          <input id="feedback-f-from" type="date" value={f.from} max={f.to || undefined} onChange={(e) => set({ from: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className={labelCls} htmlFor="feedback-f-to">Filed up to (IST)</label>
          <input id="feedback-f-to" type="date" value={f.to} min={f.from || undefined} onChange={(e) => set({ to: e.target.value })} className={inputCls} />
        </div>
      </div>
      <div>
        <label className={labelCls} htmlFor="feedback-f-card">Work board card</label>
        <select id="feedback-f-card" value={f.card} onChange={(e) => set({ card: e.target.value as FeedbackFilters["card"] })} className={inputCls}>
          {CARD_FILTERS.map((c) => <option key={c} value={c}>{CARD_FILTER_LABEL[c]}</option>)}
        </select>
      </div>
    </div>
  );
}
