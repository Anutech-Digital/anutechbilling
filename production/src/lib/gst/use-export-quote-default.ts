/**
 * R-2648 — the client side of money-rules G16 for a quote/project form being MADE: which case the
 * buyer is (domestic / zero-rated under an LUT / zero-rated with no LUT), from the company's LUTs.
 *
 * `ready` is false while the LUTs load for the first time — a form must not flip its rate (or show the
 * no-LUT warning) on a guess. Rows once read are kept: a failed background refetch keeps them (React
 * Query keeps `data`), so an open form never jumps from 0% to 18%. A first read that fails is
 * "LUTs unknown" — the old rate stays, never a 0% guess, and the words say the read failed.
 */
"use client";

import * as React from "react";
import { useTenantLuts } from "@/lib/queries/tenant-luts";
import { exportQuoteDefault, type ExportQuoteDefault } from "@/lib/gst/export-quote-rate";

export function useExportQuoteDefault(a: {
  enabled:   boolean;
  country:   string | null | undefined;
  treatment: string | null | undefined;
  date:      string;
  billOfSupply?: boolean;
}): { def: ExportQuoteDefault; ready: boolean } {
  const luts = useTenantLuts(a.enabled);
  const rows = luts.data;
  const ready = !a.enabled || rows !== undefined || luts.isError;
  const def = React.useMemo<ExportQuoteDefault>(
    () => (a.enabled
      ? exportQuoteDefault({ country: a.country, treatment: a.treatment, date: a.date, luts: rows ?? null, billOfSupply: a.billOfSupply })
      : { kind: "domestic" }),
    [a.enabled, a.country, a.treatment, a.date, a.billOfSupply, rows],
  );
  return { def, ready };
}
