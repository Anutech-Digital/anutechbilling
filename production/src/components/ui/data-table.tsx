"use client";

/**
 * DataTable — the one list/table every page should use (R-085, 1 Oct 2026).
 *
 * What it gives a page for free:
 *   - click a header to sort (asc → desc → back to the page's order); empty values last
 *   - select-all / per-row checkboxes, on desktop AND phone (feeds the page's BulkActionBar)
 *   - "Views": save the current filters + sort under a name, re-apply in one click
 *     (this browser only — localStorage, see lib/table/data-table.ts)
 *   - a phone/tablet card list below the breakpoint, the table above it
 *   - "Showing x of y" + the page's own filter controls in one toolbar row
 *   - with `urlKey`, the sort lives in the address bar (?sort=amount.desc), so opening a row
 *     and pressing Back returns to the same order (R-297; filters went there in R-272)
 *
 * Filtering stays with the page (each list filters differently); the page passes the
 * filtered rows and, for Views, its filter state + how to apply one.
 *
 * Simple rows: give each column a `cell`. Rows with their own dialogs/menus (invoices):
 * pass `renderRow` — it gets the checkbox cell to put first, so selection and the column
 * order still come from here.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAskText } from "@/components/providers/confirm-provider";
import { cn } from "@/lib/utils";
import { useUrlState } from "@/lib/hooks/use-url-state";
import {
  sortRows, nextSort, toggleAllIds, toggleId, loadViews, saveView, deleteView, isViewActive, pagedCount,
  type SortState, type SortValue, type SavedView, type ViewStorage,
} from "@/lib/table/data-table";

export interface DataTableColumn<T> {
  id: string;
  header: React.ReactNode;
  /** Column width for the fixed layout, e.g. "15%". */
  width?: string;
  align?: "left" | "right";
  /** Makes the header clickable. Return null/"" for "no value" (sorted last). */
  sortValue?: (row: T) => SortValue;
  /** Cell content for the built-in row. Not needed when the page passes renderRow. */
  cell?: (row: T) => React.ReactNode;
}

export interface DataTableViews {
  /** Unique per list, e.g. "invoices". */
  storageKey: string;
  /** The page's current filter state — must be plain JSON. */
  current: Record<string, unknown>;
  /** Put a saved filter state back. */
  apply: (state: Record<string, unknown>) => void;
}

export interface RowCtx {
  checked: boolean;
  toggle: () => void;
  /** The ready checkbox cell — first <td> of a custom row. */
  checkboxCell: React.ReactNode;
}

interface DataTableProps<T> {
  rows: T[];
  columns: DataTableColumn<T>[];
  getRowId: (row: T) => string;
  /** Rows before the page's filters — for "Showing x of y". */
  totalCount?: number;
  /** e.g. "invoice" → "Showing 4 of 21 invoices". */
  noun?: string;
  selected?: Set<string>;
  onSelectedChange?: (next: Set<string>) => void;
  /** Page filters (tabs live above; selects/search go here). */
  toolbar?: React.ReactNode;
  views?: DataTableViews;
  defaultSort?: SortState | null;
  /** Below this width the card list shows instead of the table. */
  cardsBelow?: "md" | "lg" | "xl";
  /** One row as a card for phones/tablets. */
  mobileCard: (row: T, ctx: { checked: boolean; toggle: () => void }) => React.ReactNode;
  /** Custom desktop row (must render a <tr>). */
  renderRow?: (row: T, ctx: RowCtx) => React.ReactNode;
  onRowClick?: (row: T) => void;
  /** Shown instead of the list when `rows` is empty. */
  empty?: React.ReactNode;
  /**
   * R-024: render this many rows, then "Load more". Sort and filters still run over every
   * row (counts and totals stay exact); only the painting is paged. Omit to show all.
   */
  pageSize?: number;
  /** A row that must be on screen (a deep link like ?open=INV-…) — the page grows to it. */
  revealId?: string | null;
  /**
   * R-297: URL param that holds the sort (e.g. "sort" → ?sort=amount.desc), so Back keeps it.
   * Omit and the sort stays in memory only, as before. Two tables on one page need two keys.
   */
  urlKey?: string;
}

/** { id: "amount", dir: "desc" } → "amount.desc"; no sort → "". */
export function encodeSort(sort: SortState | null): string {
  return sort ? `${sort.id}.${sort.dir}` : "";
}

/** Anything that is not "<sortable column>.<asc|desc>" is null — a hand-edited URL cannot break the list. */
export function decodeSort(raw: string, sortableIds: readonly string[]): SortState | null {
  const dot = raw.lastIndexOf(".");
  if (dot <= 0) return null;
  const id = raw.slice(0, dot);
  const dir = raw.slice(dot + 1);
  if ((dir !== "asc" && dir !== "desc") || !sortableIds.includes(id)) return null;
  return { id, dir };
}

const SHOW_TABLE = { md: "hidden md:block", lg: "hidden lg:block", xl: "hidden xl:block" } as const;
const SHOW_CARDS = { md: "md:hidden", lg: "lg:hidden", xl: "xl:hidden" } as const;

function browserStorage(): ViewStorage | null {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
}

export function DataTable<T>({
  rows, columns, getRowId, totalCount, noun, selected, onSelectedChange, toolbar, views,
  defaultSort = null, cardsBelow = "md", mobileCard, renderRow, onRowClick, empty, pageSize, revealId, urlKey,
}: DataTableProps<T>) {
  const [sort, setSort] = useTableSort(urlKey, defaultSort, columns);
  const selectable = !!selected && !!onSelectedChange;

  const sorted = React.useMemo(() => {
    if (!sort) return rows;
    const col = columns.find((c) => c.id === sort.id);
    return sortRows(rows, col?.sortValue, sort.dir);
  }, [rows, columns, sort]);

  /* Paging (R-024). A new filter or sort starts again at one page. */
  const [limit, setLimit] = React.useState(pageSize ?? Infinity);
  React.useEffect(() => { setLimit(pageSize ?? Infinity); }, [rows, sort, pageSize]);
  const revealIndex = React.useMemo(
    () => (revealId ? sorted.findIndex((r) => getRowId(r) === revealId) : -1),
    [sorted, revealId, getRowId],
  );
  const shown = React.useMemo(
    () => (pageSize ? sorted.slice(0, pagedCount(sorted.length, limit, revealIndex)) : sorted),
    [sorted, pageSize, limit, revealIndex],
  );
  const hidden = sorted.length - shown.length;

  /* Select-all covers the rows ON SCREEN — a tick that silently selected rows nobody can
     see is how a bulk action goes wrong (same rule as the Customers list). */
  const ids = React.useMemo(() => shown.map(getRowId), [shown, getRowId]);
  const allChecked = selectable && ids.length > 0 && ids.every((id) => selected!.has(id));

  const ctxFor = (row: T) => {
    const id = getRowId(row);
    const checked = selectable ? selected!.has(id) : false;
    const toggle = () => { if (selectable) onSelectedChange!(toggleId(selected!, id)); };
    return { id, checked, toggle };
  };

  const label = noun ? `${noun}${(totalCount ?? rows.length) === 1 ? "" : "s"}` : "rows";

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <div className="text-xs text-ink-3">
          Showing {shown.length}{hidden > 0 ? ` of ${rows.length}` : totalCount !== undefined ? ` of ${totalCount}` : ""} {label}
          {sort && (
            <button type="button" className="ml-2 text-amber-ink hover:underline" onClick={() => setSort(defaultSort)}>
              Clear sort
            </button>
          )}
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {toolbar}
          {views && <ViewsMenu views={views} sort={sort} setSort={setSort} />}
        </div>
      </div>

      {rows.length === 0 ? empty ?? null : (
        <>
          {/* Phones / tablets: cards. Sort comes from the same state, so both match. */}
          <ul className={cn(SHOW_CARDS[cardsBelow], "space-y-2 mb-3")}>
            {selectable && (
              <li className="flex items-center gap-2 px-1 text-xs text-ink-3">
                <Checkbox
                  checked={allChecked}
                  onCheckedChange={() => onSelectedChange!(toggleAllIds(selected!, ids))}
                  aria-label="Select all"
                />
                Select all
              </li>
            )}
            {shown.map((row) => {
              const { id, checked, toggle } = ctxFor(row);
              return (
                <li key={id} className={cn(selectable && "flex items-start gap-2")}>
                  {selectable && (
                    <div className="pt-3 pl-1">
                      <Checkbox checked={checked} onCheckedChange={toggle} aria-label={`Select ${id}`} />
                    </div>
                  )}
                  <div className="min-w-0 flex-1">{mobileCard(row, { checked, toggle })}</div>
                </li>
              );
            })}
          </ul>

          <Card flush className={SHOW_TABLE[cardsBelow]}>
            <table className="w-full table-fixed">
              <colgroup>
                {selectable && <col style={{ width: "3%" }} />}
                {columns.map((c) => <col key={c.id} style={c.width ? { width: c.width } : undefined} />)}
              </colgroup>
              <thead className="bg-paper-2 border-b border-hairline-strong">
                <tr>
                  {selectable && (
                    <th className="px-3 py-2.5">
                      <Checkbox
                        checked={allChecked}
                        onCheckedChange={() => onSelectedChange!(toggleAllIds(selected!, ids))}
                        aria-label="Select all"
                      />
                    </th>
                  )}
                  {columns.map((c) => (
                    <th
                      key={c.id}
                      className={cn("px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider", c.align === "right" ? "text-right" : "text-left")}
                      aria-sort={sort?.id === c.id ? (sort.dir === "asc" ? "ascending" : "descending") : undefined}
                    >
                      {c.sortValue ? (
                        <button
                          type="button"
                          onClick={() => setSort(nextSort(sort, c.id))}
                          className={cn("inline-flex items-center gap-1 uppercase tracking-wider hover:text-ink", sort?.id === c.id && "text-ink")}
                          title="Sort"
                        >
                          {c.header}
                          <Icon
                            name={sort?.id === c.id ? (sort.dir === "asc" ? "chevron_up" : "chevron_down") : "sort"}
                            size={12}
                            className={sort?.id === c.id ? "text-amber-ink" : "opacity-40"}
                          />
                        </button>
                      ) : c.header}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {shown.map((row) => {
                  const { id, checked, toggle } = ctxFor(row);
                  const checkboxCell = selectable ? (
                    <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                      <Checkbox checked={checked} onCheckedChange={toggle} aria-label={`Select ${id}`} />
                    </td>
                  ) : null;
                  if (renderRow) return <React.Fragment key={id}>{renderRow(row, { checked, toggle, checkboxCell })}</React.Fragment>;
                  return (
                    <tr
                      key={id}
                      className={cn("border-b border-hairline last:border-0", onRowClick && "cursor-pointer hover:bg-paper-2/50")}
                      onClick={onRowClick ? () => onRowClick(row) : undefined}
                    >
                      {checkboxCell}
                      {columns.map((c) => (
                        <td key={c.id} className={cn("px-3 py-2.5 text-sm align-top", c.align === "right" && "text-right")}>
                          {c.cell?.(row)}
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {hidden > 0 && (
            <div className="mt-3 flex flex-col items-center gap-1">
              <Button onClick={() => setLimit((l) => (Number.isFinite(l) ? l : 0) + (pageSize ?? 50))}>
                Load {Math.min(hidden, pageSize ?? 50)} more
              </Button>
              <span className="text-2xs text-ink-3">{hidden} more {label} below</span>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/**
 * Sort state: in memory, or in the URL when `urlKey` is given. Hooks always run in the same
 * order; the URL setter is simply never called without a key. The decoded sort is memoised on
 * strings (not on `columns`/`defaultSort`, which pages often pass as fresh objects) so the
 * paging effect does not reset "Load more" on every render.
 */
function useTableSort<T>(
  urlKey: string | undefined,
  defaultSort: SortState | null,
  columns: DataTableColumn<T>[],
): [SortState | null, (next: SortState | null) => void] {
  const [localSort, setLocalSort] = React.useState<SortState | null>(defaultSort);
  const fallback = encodeSort(defaultSort);
  const [raw, setRaw] = useUrlState(urlKey ?? "", fallback);
  const sortableKey = columns.filter((c) => c.sortValue).map((c) => c.id).join("\n");

  const urlSort = React.useMemo(() => {
    const ids = sortableKey ? sortableKey.split("\n") : [];
    return decodeSort(raw, ids) ?? decodeSort(fallback, ids);
  }, [raw, fallback, sortableKey]);

  const setUrlSort = React.useCallback((next: SortState | null) => setRaw(encodeSort(next)), [setRaw]);
  return urlKey ? [urlSort, setUrlSort] : [localSort, setLocalSort];
}

function ViewsMenu({ views, sort, setSort }: {
  views: DataTableViews;
  sort: SortState | null;
  setSort: (s: SortState | null) => void;
}) {
  const askText = useAskText();
  const [list, setList] = React.useState<SavedView[]>([]);
  // After mount — localStorage does not exist on the server.
  React.useEffect(() => { setList(loadViews(browserStorage(), views.storageKey)); }, [views.storageKey]);
  const active = list.find((v) => isViewActive(v, views.current, sort));

  async function saveCurrent() {
    const name = await askText({
      title: "Save this view",
      body: "Saves the current filters and sort in this browser, so you can come back to them in one click.",
      label: "Name",
      placeholder: "e.g. Overdue this month",
      confirmLabel: "Save",
      icon: "bookmark",
    });
    if (!name) return;
    setList(saveView(browserStorage(), views.storageKey, { name, state: views.current, sort }));
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="sm" variant="ghost" icon="bookmark" aria-label="Saved views">
          {active ? active.name : "Views"}
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[14rem]">
        <DropdownMenuLabel>Saved views</DropdownMenuLabel>
        {list.length === 0 && (
          <div className="px-2 py-1.5 text-xs text-ink-3">None yet. Set filters, then save them here.</div>
        )}
        {list.map((v) => (
          <DropdownMenuItem
            key={v.name}
            className="group gap-2 py-2 cursor-pointer"
            onClick={() => { views.apply(v.state); setSort(v.sort); }}
          >
            <Icon name="check" size={14} className={active?.name === v.name ? "text-amber-ink" : "opacity-0"} />
            <span className="flex-1 truncate">{v.name}</span>
            <button
              type="button"
              aria-label={`Delete view ${v.name}`}
              className="rounded p-0.5 text-ink-3 hover:bg-paper-2 hover:text-rose"
              onClick={(e) => { e.stopPropagation(); e.preventDefault(); setList(deleteView(browserStorage(), views.storageKey, v.name)); }}
            >
              <Icon name="x" size={13} />
            </button>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem className="gap-2 py-2 cursor-pointer" onClick={() => void saveCurrent()}>
          <Icon name="plus" size={14} /> Save current view…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
