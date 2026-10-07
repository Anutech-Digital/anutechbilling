"use client";
/**
 * useUrlList — a list page's MULTI-select filter (stages, priorities, owners) held in the URL
 * as one comma-joined param, so a refresh, a shared link, or opening a deal and pressing Back
 * returns to the same filtered list (R-349).
 *
 * useUrlState (R-272) does this for one free-form value; /leads and /deals kept their
 * multi-select Filter (Stage / Priority / Owner) in plain useState, so "Stage: Trial, Active"
 * vanished on Back. Same mechanics as useUrlState on purpose — read from `window` after mount
 * (no useSearchParams, no hydration mismatch), write with history.replaceState (no navigation,
 * no history entry per click), and an empty list removes the key so an unfiltered list has a
 * clean address.
 *
 * The setter accepts an updater function too, because the toolbar toggles one item with
 * `set(prev => …)` — it is a drop-in for React.useState<T[]>.
 */
import * as React from "react";
import { withChoice } from "@/lib/hooks/use-url-choice";

/** `raw` ("trial,demo") as a clean list: trimmed, de-duplicated, and — when `allowed` is
 *  given — only known values, so a hand-edited or stale link cannot inject a bad filter. Pure. */
export function parseUrlList<T extends string>(raw: string | null | undefined, allowed?: readonly T[]): T[] {
  if (!raw) return [];
  const out: T[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v || out.includes(v as T)) continue;
    if (allowed && !(allowed as readonly string[]).includes(v)) continue;
    out.push(v as T);
  }
  return out;
}

export function useUrlList<T extends string = string>(
  key: string,
  allowed?: readonly T[],
): [T[], React.Dispatch<React.SetStateAction<T[]>>] {
  const [value, setValue] = React.useState<T[]>([]);
  const valueRef = React.useRef<T[]>(value);
  // Kept in a ref so callers may pass a fresh array each render without re-running the effect.
  const allowedRef = React.useRef(allowed);
  allowedRef.current = allowed;

  React.useEffect(() => {
    const read = () => {
      const next = parseUrlList(new URLSearchParams(window.location.search).get(key), allowedRef.current);
      valueRef.current = next;
      setValue(next);
    };
    read();
    window.addEventListener("popstate", read);
    return () => window.removeEventListener("popstate", read);
  }, [key]);

  const set = React.useCallback<React.Dispatch<React.SetStateAction<T[]>>>(
    (action) => {
      const next = typeof action === "function" ? action(valueRef.current) : action;
      valueRef.current = next;
      setValue(next);
      if (typeof window === "undefined") return;
      const qs = withChoice(window.location.search, key, next.join(","), "");
      window.history.replaceState(window.history.state, "", `${window.location.pathname}${qs}${window.location.hash}`);
    },
    [key],
  );

  return [value, set];
}
