/**
 * R-1736 — the customer's GST treatment select and PAN field, shared by the full-page form
 * and the side sheet so both read the same (one task, one way). Each form wraps these in
 * its own label row; the state lives in useCustomerForm.
 */
"use client";

import * as React from "react";
import type { UseFormRegisterReturn } from "react-hook-form";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { GST_TREATMENT_OPTIONS, type CustomerGstTreatment } from "@/lib/gst/customer-gst-treatment";

const selectBase =
  "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

export function GstTreatmentSelect({
  id = "gst_treatment", value, onChange, auto, meaning, foreign, error,
}: {
  id?: string;
  value: CustomerGstTreatment;
  onChange: (v: CustomerGstTreatment) => void;
  /** True while the value is the one the country / GSTIN / type suggest. */
  auto: boolean;
  meaning: string;
  /** Outside India only Overseas applies; in India everything but Overseas. */
  foreign: boolean;
  error?: string;
}) {
  const describedBy = `${id}-meaning${error ? ` ${id}-error` : ""}`;
  return (
    <div>
      <select
        id={id}
        className={cn(selectBase, error && "border-rose")}
        value={value}
        onChange={(e) => onChange(e.target.value as CustomerGstTreatment)}
        aria-describedby={describedBy}
        aria-invalid={error ? true : undefined}
      >
        {GST_TREATMENT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value} disabled={foreign ? o.value !== "overseas" : o.value === "overseas"}>
            {o.label}
          </option>
        ))}
      </select>
      <p id={`${id}-meaning`} className="mt-1 text-xs text-ink-3">
        {meaning}
        {auto && <span className="text-ink-3"> Picked from the country, GSTIN and customer type — change it if it is different.</span>}
      </p>
      {error && <p id={`${id}-error`} className="mt-1 text-xs text-rose">{error}</p>}
    </div>
  );
}

export function PanInput({
  id = "pan", registration, locked, error,
}: {
  id?: string;
  registration: UseFormRegisterReturn<"pan">;
  /** Read-only while a valid GSTIN supplies the PAN. */
  locked: boolean;
  error?: string;
}) {
  return (
    <Input
      id={id}
      placeholder="e.g. AAACR5055K"
      className={cn("font-mono uppercase", locked && "bg-paper-2 cursor-not-allowed")}
      maxLength={10}
      readOnly={locked}
      error={error}
      helper={locked ? "Taken from the GSTIN (characters 3–12)." : "Needed to match TDS deducted by this customer (Form 26AS)."}
      {...registration}
    />
  );
}
