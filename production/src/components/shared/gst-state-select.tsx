"use client";
/**
 * GstStateSelect — the one "which state is this customer in?" picker (R-174, 6 Oct 2026).
 *
 * Every path that creates a customer needs the place of supply: generate_invoice refuses a GST
 * invoice for an Indian customer with no state_code ("no state on record") — 17 such customers
 * on live on 6 Oct, made by quick-create paths that never asked. Value is the 2-digit GST code;
 * "" = not chosen. `allowExport` adds "Outside India" (value EXPORT_STATE) for foreign buyers,
 * who have no Indian place of supply.
 */
import * as React from "react";
import { GST_STATE_OPTIONS } from "@/lib/gst/gstin-state";
import { cn } from "@/lib/utils";

export const EXPORT_STATE = "export";

export function GstStateSelect({
  id, value, onChange, allowExport = false, error, className, required = true,
}: {
  id: string;
  value: string;
  onChange: (code: string) => void;
  allowExport?: boolean;
  error?: string | null;
  className?: string;
  required?: boolean;
}) {
  return (
    <div>
      <select
        id={id}
        value={value}
        required={required}
        aria-invalid={!!error}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "w-full rounded-md border bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40",
          error ? "border-rose" : "border-hairline",
          className,
        )}
      >
        <option value="">Select state…</option>
        {GST_STATE_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.name}</option>)}
        {allowExport && <option value={EXPORT_STATE}>Outside India (export)</option>}
      </select>
      {error && <p className="mt-1 text-xs text-rose">{error}</p>}
    </div>
  );
}
