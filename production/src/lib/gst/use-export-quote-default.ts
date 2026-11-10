/**
 * R-2648 — the client side of money-rules G16 for a quote/project form being MADE: which case the
 * buyer is (domestic / zero-rated under an LUT / zero-rated with no LUT), from the company's LUTs.
 *
 * `ready` is false while the LUTs load — a form must not flip its rate (or show the no-LUT warning)
 * on a guess. A failed LUT read is "no LUT" (keeps the old rate), never a 0% guess.
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
  const ready = !a.enabled || luts.isSuccess || luts.isError;
  const def = React.useMemo<ExportQuoteDefault>(
    () => (a.enabled
      ? exportQuoteDefault({
        country: a.country, treatment: a.treatment, date: a.date,
        luts: luts.isSuccess ? luts.data : null, billOfSupply: a.billOfSupply,
      })
      : { kind: "domestic" }),
    [a.enabled, a.country, a.treatment, a.date, a.billOfSupply, luts.isSuccess, luts.data],
  );
  return { def, ready };
}
