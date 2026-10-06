"use client";
/**
 * useUrlState — a list page's free-form filter (search text, a vendor id, an on/off toggle)
 * held in the URL, so opening a row and pressing Back returns to the same filtered list (R-272).
 *
 * useUrlChoice (R-118) already does this for tabs, where the value must be one of a known
 * list. Search boxes and pickers have no such list, so before this hook they lived only in
 * useState — and an operator who searched "acme", opened a quote and pressed Back came home
 * to every quote again. 27 list pages had that shape.
 *
 * Same mechanics as useUrlChoice, on purpose (one way to do it):
 *   - read from `window` after mount, not `useSearchParams()` (that opts the page out of
 *     prerendering and fails `npm run build` without a Suspense boundary), and not in the
 *     initialiser (the server has no URL → hydration mismatch);
 *   - write with history.replaceState — no navigation, no refetch, and no history entry per
 *     keystroke, so Back still leaves the page instead of undoing one letter;
 *   - the fallback value is removed from the URL, so an unfiltered list has a clean address.
 */
import * as React from "react";
import { withChoice } from "@/lib/hooks/use-url-choice";

export function useUrlState(key: string, fallback = ""): [string, (next: string) => void] {
  const [value, setValue] = React.useState<string>(fallback);

  React.useEffect(() => {
    const read = () => setValue(new URLSearchParams(window.location.search).get(key) ?? fallback);
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [key, fallback]);

  const set = React.useCallback(
    (next: string) => {
      setValue(next);
      if (typeof window === "undefined") return;
      const qs = withChoice(window.location.search, key, next, fallback);
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs}${window.location.hash}`);
    },
    [key, fallback],
  );

  return [value, set];
}
