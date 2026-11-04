"use client";

/**
 * R-2239 (Zoho Billing audit B1): a dashboard card shows its EMPTY text only when its query
 * resolved with nothing in it. On a slow load the dashboard used to print "No subs yet",
 * "Customers 0", "Nothing to chase" and "Add your first customer" while 61 subscriptions
 * existed — the owner read it as "my data is gone".
 *
 * - `loadView(...queries)`: pure — "loading" until every query has data, "error" when one
 *   failed with nothing to show, else "ready". Only "ready" may say "none".
 * - `useStillLoading(loading)`: true once a load has taken > 10 s, so the card can say so.
 * - `<DashCardBody>`: skeleton (+ "Still loading…") → error with Try again → empty → content.
 */
import * as React from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { LoadErrorInline } from "@/components/shared/load-error";

/** The parts of a TanStack query result this file reads. */
export interface QueryLike {
  data?: unknown;
  isError?: boolean;
  error?: unknown;
  refetch?: () => unknown;
}

export type LoadView = "loading" | "error" | "ready";

/** After this long a loading card says "Still loading…" (Zoho shows a spinner; we say it). */
export const STILL_LOADING_MS = 10_000;
export const STILL_LOADING_TEXT = "Still loading…";

/**
 * "error" when any query failed and has no data to show; "loading" when any has no data yet;
 * else "ready". A query that failed on a REFETCH keeps its last data, so it stays "ready" —
 * the page's LoadErrorBanner already says some numbers did not refresh.
 */
export function loadView(...queries: QueryLike[]): LoadView {
  if (queries.some((q) => q.isError && q.data === undefined)) return "error";
  if (queries.some((q) => q.data === undefined)) return "loading";
  return "ready";
}

/** KPI tile while its data is not in: shimmer, then "Still loading…"; on error "Didn't load". */
export function kpiTileState(view: LoadView, trend: string, slow: boolean): { loading: boolean; trend: string } {
  if (view === "ready") return { loading: false, trend };
  if (view === "error") return { loading: false, trend: "Didn't load" };
  return slow ? { loading: false, trend: STILL_LOADING_TEXT } : { loading: true, trend };
}

/** A count in a stat strip: "…" while loading, "—" when it failed — never a false 0. */
export function countText(view: LoadView, n: number): number | string {
  return view === "ready" ? n : view === "error" ? "—" : "…";
}

/** Retry only the queries that failed. */
export function retryFailed(...queries: QueryLike[]): () => void {
  return () => {
    for (const q of queries) if (q.isError) void q.refetch?.();
  };
}

/** True once `loading` has stayed true for `ms`; resets when loading ends. */
export function useStillLoading(loading: boolean, ms: number = STILL_LOADING_MS): boolean {
  const [slow, setSlow] = React.useState(false);
  React.useEffect(() => {
    if (!loading) { setSlow(false); return; }
    const t = setTimeout(() => setSlow(true), ms);
    return () => clearTimeout(t);
  }, [loading, ms]);
  return loading && slow;
}

/** Skeleton rows for a card body; after 10 s a "Still loading…" line under them. */
export function CardSkeleton({ rows = 3, slow }: { rows?: number; slow?: boolean }) {
  return (
    <div className="space-y-2" data-card-loading="">
      {Array.from({ length: rows }).map((_, i) => <Skeleton key={i} className="h-6" />)}
      {slow && <p className="pt-1 text-2xs text-ink-3" aria-live="polite">{STILL_LOADING_TEXT}</p>}
    </div>
  );
}

/**
 * The body of one dashboard card.
 *  loading → skeleton (never the empty text) · error → "<what> didn't load" + Try again
 *  · ready + isEmpty → `empty` · ready → `children`.
 */
export function DashCardBody({
  queries, what, isEmpty, empty, rows = 3, children,
}: {
  queries: QueryLike[];
  /** Names the data in the error line, e.g. "Renewals". */
  what: string;
  isEmpty: boolean;
  empty: React.ReactNode;
  rows?: number;
  children: React.ReactNode;
}) {
  const view = loadView(...queries);
  const slow = useStillLoading(view === "loading");
  if (view === "loading") return <CardSkeleton rows={rows} slow={slow} />;
  if (view === "error") {
    const failed = queries.find((q) => q.isError);
    return <LoadErrorInline what={what} error={failed?.error} onRetry={retryFailed(...queries)} />;
  }
  return <>{isEmpty ? empty : children}</>;
}
