/**
 * R-104 — the Payments list paints 50 at a time, the R-024 way (shared DataTable).
 *
 * Payments is not on the shared DataTable yet (R-090), so its two lists (cards below xl,
 * table at xl) take the same rule from here: filters, search, tab counts, KPIs and the CSV
 * export still run over EVERY payment; only the painting is paged. A new filter starts
 * again at one page. Same `pagedCount` and the same "Load N more" control as DataTable,
 * so the two screens behave alike.
 */
"use client";

import * as React from "react";
import { pagedCount } from "@/lib/table/data-table";
import { Button } from "@/components/ui/button";

export const PAYMENTS_PAGE_SIZE = 50;

/** The first `limit` rows of `rows`; `resetKey` changing (a filter, search, tab) starts again at one page. */
export function usePagedRows<T>(rows: T[], pageSize: number, resetKey: string) {
  const [limit, setLimit] = React.useState(pageSize);
  React.useEffect(() => { setLimit(pageSize); }, [resetKey, pageSize]);
  const shown = React.useMemo(() => rows.slice(0, pagedCount(rows.length, limit)), [rows, limit]);
  const hidden = rows.length - shown.length;
  const loadMore = React.useCallback(() => setLimit((l) => l + pageSize), [pageSize]);
  return { shown, hidden, loadMore };
}

/** "Load 50 more" + how many are still below — the DataTable control, word for word. */
export function LoadMore({ hidden, pageSize, noun, onLoadMore }: {
  hidden: number; pageSize: number; noun: string; onLoadMore: () => void;
}) {
  if (hidden <= 0) return null;
  return (
    <div className="mt-3 mb-3 flex flex-col items-center gap-1">
      <Button onClick={onLoadMore}>Load {Math.min(hidden, pageSize)} more</Button>
      <span className="text-2xs text-ink-3">{hidden} more {noun} below</span>
    </div>
  );
}
