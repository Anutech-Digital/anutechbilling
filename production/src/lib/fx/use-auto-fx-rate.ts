"use client";
/**
 * R-2056 (28 Oct 2026, Pardeep: "exchange ka latest rate khud aana chahiye, par editable ho") —
 * the ONE client helper for an Exchange rate box that fills itself and stays editable.
 *
 *   const fx = useAutoFxRate(currency, billDate);
 *   <Input value={fx.value} onChange={(e) => fx.setTyped(e.target.value)} />
 *   {fx.hint && <p>{fx.hint}</p>}
 *
 * - Foreign currency + a YYYY-MM-DD date → GET /api/fx/latest?from=…&date=… (server fetches
 *   FBIL/RBI first, then ECB; cached per day — lib/fx/rate-source.ts fetchInrRateOn).
 * - The fetched rate fills the box only while the user has not typed one. Date or currency
 *   changes fetch again; a typed rate is never overwritten. `reset()` (a new bill read, a new
 *   currency) makes the next fetched rate fill again.
 * - No rate available → the box stays empty and `failed` is true; the caller keeps its own
 *   "enter the rate" message, and Save stays blocked on an empty rate.
 * Vendor bills use it now; the quote / invoice builders can move onto it later.
 */
import * as React from "react";
import { fxRateHint, type FxRate } from "./rate-source";

export interface FxAutoState {
  /** What the box shows — a string, so a half-typed "94." stays as typed. */
  value: string;
  /** The rate the box got from the server; null once the user typed. */
  auto: FxRate | null;
  /** The user typed in the box — fetched rates no longer overwrite it. */
  typed: boolean;
  /** The last fetch found no rate while the box was empty. */
  failed: boolean;
}

export type FxAutoAction =
  | { type: "fetched"; rate: FxRate }
  | { type: "failed" }
  | { type: "typed"; value: string }
  | { type: "reset" };

export const FX_AUTO_START: FxAutoState = { value: "", auto: null, typed: false, failed: false };

export function fxAutoReducer(s: FxAutoState, a: FxAutoAction): FxAutoState {
  switch (a.type) {
    case "fetched":
      if (s.typed) return s;
      return { value: String(a.rate.rate), auto: a.rate, typed: false, failed: false };
    case "failed":
      if (s.typed || s.value) return { ...s, failed: false };
      return { ...s, failed: true };
    case "typed":
      return { value: a.value, auto: null, typed: true, failed: false };
    case "reset":
      return FX_AUTO_START;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function useAutoFxRate(currency: string | null | undefined, date: string | null | undefined) {
  const [state, dispatch] = React.useReducer(fxAutoReducer, FX_AUTO_START);
  const [loading, setLoading] = React.useState(false);
  const cur = (currency ?? "INR").trim().toUpperCase();
  const foreign = cur !== "" && cur !== "INR";
  const day = date && DATE_RE.test(date) ? date : null;

  React.useEffect(() => {
    if (!foreign || !day) return;
    let live = true;
    setLoading(true);
    fetch(`/api/fx/latest?from=${encodeURIComponent(cur)}&date=${day}`)
      .then(async (res) => {
        const body = res.ok ? ((await res.json()) as FxRate) : null;
        if (!live) return;
        if (body && typeof body.rate === "number" && body.rate > 0) dispatch({ type: "fetched", rate: body });
        else dispatch({ type: "failed" });
      })
      .catch(() => { if (live) dispatch({ type: "failed" }); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [foreign, cur, day]);

  const setTyped = React.useCallback((value: string) => dispatch({ type: "typed", value }), []);
  const reset = React.useCallback(() => dispatch({ type: "reset" }), []);

  return {
    value: foreign ? state.value : "",
    /** Where the number came from — saved in the bill's note so the ₹ figure is auditable. */
    auto: foreign ? state.auto : null,
    typed: state.typed,
    failed: foreign && state.failed,
    loading: foreign && loading,
    /** "₹94.7145 · FBIL/RBI reference rate, 21 Oct 2026 — change it if …"; null when typed / none. */
    hint: foreign && state.auto ? fxRateHint(state.auto) : null,
    setTyped,
    reset,
  };
}
