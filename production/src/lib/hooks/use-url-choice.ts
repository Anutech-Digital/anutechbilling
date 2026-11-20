"use client";
/**
 * useUrlChoice — a page's tab / view held in the URL, so a link can open it (R-118).
 *
 * Every KPI tile in the app shows a number about a set of records. Until 2 Oct 2026 no list
 * page took its tab or view from the URL, so a tile could only open the page — never the set
 * it counted — and the owner had to find the same filter by hand. This hook is the one place
 * a list page says "my tab may come from ?tab=", and the tiles link to that.
 *
 * Read from `window` after mount, not `useSearchParams()`: that hook opts a page out of
 * prerendering unless it sits under a Suspense boundary, and `npm run build` fails on it
 * (the same trap customers/page.tsx documents). After mount, not in the initialiser: the
 * server render has no URL, so an initialiser would render one tab on the server and another
 * on the client — a hydration mismatch. The cost is one frame on the default tab.
 *
 * Writing back uses history.replaceState — no navigation, no refetch, no scroll jump — so the
 * address bar always says what the screen shows and a refresh or a shared link reopens it.
 */
import * as React from "react";
import { onAddressChange } from "@/lib/navigation/same-page-nav";

/** The value to use: `raw` when it is one of `allowed`, else `fallback`. Pure, for tests. */
export function pickChoice<T extends string>(raw: string | null | undefined, allowed: readonly T[], fallback: T): T {
  return raw != null && (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

/** `search` with `key` set to `value`, or removed when `value` is the default. Pure. */
export function withChoice(search: string, key: string, value: string, fallback: string): string {
  const p = new URLSearchParams(search);
  if (value === fallback) p.delete(key);
  else p.set(key, value);
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

export function useUrlChoice<T extends string>(
  key: string,
  allowed: readonly T[],
  fallback: T,
): [T, (next: T) => void] {
  const [value, setValue] = React.useState<T>(fallback);
  // Kept in a ref so the effect and setter do not re-run when a caller passes a fresh array.
  const allowedRef = React.useRef(allowed);
  allowedRef.current = allowed;

  React.useEffect(() => {
    const read = () =>
      setValue(pickChoice(new URLSearchParams(window.location.search).get(key), allowedRef.current, fallback));
    read();
    // Back / Forward, and (R-2942) a link to this same page's bare address: /tasks?priority=high → "List".
    return onAddressChange(read);
  }, [key, fallback]);

  const set = React.useCallback(
    (next: T) => {
      setValue(next);
      if (typeof window === "undefined") return;
      const qs = withChoice(window.location.search, key, next, fallback);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs}${window.location.hash}`);
    },
    [key, fallback],
  );

  return [value, set];
}
