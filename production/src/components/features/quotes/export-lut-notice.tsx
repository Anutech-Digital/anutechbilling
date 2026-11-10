/**
 * R-2648 (money-rules G16) — the one notice every quote maker shows for a buyer abroad / SEZ without
 * payment: "0% under LUT <ARN> (FY …)" when an LUT covers it, else the plain warning with the next
 * step. "Add LUT" opens Settings in a NEW tab, so a half-filled form is never lost.
 */
"use client";

import { exportQuoteLutWarning, EXPORT_QUOTE_LUT_HREF, type ExportQuoteDefault } from "@/lib/gst/export-quote-rate";

export function ExportLutNotice({ def, rate, ready = true, className }: {
  def: ExportQuoteDefault;
  /** The rate the form will save (%). */
  rate: number;
  /** False while the LUTs are still loading — say nothing yet. */
  ready?: boolean;
  className?: string;
}) {
  if (!ready) return null;
  if (def.kind === "zero_rated") {
    if (rate !== 0) return null;
    return (
      <p className={`text-2xs text-ink-3 ${className ?? ""}`} data-testid="export-lut-note">
        {def.supply === "export" ? "Export" : "SEZ supply"} → 0% GST under LUT {def.lut.arn} (FY {def.fy}) — no GST added.
      </p>
    );
  }
  const warning = exportQuoteLutWarning(def, rate);
  if (!warning) return null;
  return (
    <div role="status" data-testid="export-lut-warning" className={`rounded-md border border-amber/40 bg-amber-soft/40 p-2.5 text-xs text-amber-ink ${className ?? ""}`}>
      {warning}{" "}
      <a href={EXPORT_QUOTE_LUT_HREF} target="_blank" rel="noopener noreferrer" className="font-semibold underline underline-offset-2">
        {def.kind === "no_lut" && def.lutsUnknown ? "Open LUT settings" : "Add LUT"}
      </a>
    </div>
  );
}
