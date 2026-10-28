"use client";
/**
 * R-2027 (27 Oct 2026): the price list on the client. The server sends it (fetch-catalog.ts);
 * when its read failed on a cold start it sends null, and the page asks
 * GET /api/public/catalog/buy-workspace once after it loads. Until that answer `loading` is true
 * — the page shows "Loading prices…" and every buy button is locked. If the answer fails or is
 * malformed, `items` stays null and `loading` false: the page says prices are not available,
 * with Try again (`retry`) and ways to talk to us — never a typed price.
 */
import * as React from "react";
import type { CatalogItem } from "./tiers";
import { fromWire } from "./catalog-wire";

const FETCH_TIMEOUT_MS = 10_000;

export function useBuyCatalog(initial: CatalogItem[] | null): { items: CatalogItem[] | null; loading: boolean; retry: () => void } {
  const [items, setItems] = React.useState<CatalogItem[] | null>(initial);
  const [loading, setLoading] = React.useState(initial === null);
  const [attempt, setAttempt] = React.useState(0);

  React.useEffect(() => {
    if (initial) return;
    let live = true;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), FETCH_TIMEOUT_MS);
    (async () => {
      try {
        const res = await fetch("/api/public/catalog/buy-workspace", { signal: ctl.signal, cache: "no-store" });
        const body = res.ok ? ((await res.json()) as { items?: unknown }) : null;
        const got = fromWire(body?.items);
        if (live && got) setItems(got);
      } catch {
        /* offline / aborted — "not available" with Try again */
      } finally {
        clearTimeout(timer);
        if (live) setLoading(false);
      }
    })();
    return () => { live = false; clearTimeout(timer); ctl.abort(); };
  }, [initial, attempt]);

  const retry = React.useCallback(() => { setLoading(true); setAttempt((n) => n + 1); }, []);
  /* a list from the server always wins; the fetched one only fills a gap */
  return initial ? { items: initial, loading: false, retry } : { items, loading, retry };
}
