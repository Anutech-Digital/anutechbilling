/**
 * R-2623 — "Service period" on a COGS bill: the month(s) the licence on the bill was used. The
 * management P&L puts the bill's cost there (R-2156); GST keeps the bill date.
 *
 * ONE field, used by Add COGS Bill and the bill view, so both look and word it the same:
 *   - auto (nothing saved): "Sep 2026 · auto (Google / Microsoft bill: month before the bill date)"
 *     and a Change button;
 *   - set: two month pickers (first / last month) and "Use auto (Sep 2026)".
 * The auto period comes from the database (vendor_bill_service_period) — never guessed here. The
 * pickers can only hold whole months; a wrong order or > 36 months shows the rule before Save.
 */
"use client";

import * as React from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  monthsToPeriod,
  periodToMonths,
  servicePeriodBasisText,
  servicePeriodLabel,
  type ServicePeriodBasis,
} from "@/lib/accounting/bill-service-period";

/** The pickers' values; null = auto (nothing saved on the bill). */
export type ServicePeriodMonths = { from: string; to: string } | null;

export interface ServicePeriodFieldProps {
  /** id prefix for the inputs (two fields on one page must differ). */
  idPrefix: string;
  /** What the period is now: the database's answer (auto or the bill's own). undefined = loading. */
  current: { service_from: string; service_to: string; basis: ServicePeriodBasis } | null | undefined;
  /** What auto would give (for "Use auto (…)"); for a new bill the same as `current`. */
  auto?: { service_from: string; service_to: string } | null;
  value: ServicePeriodMonths;
  onChange: (v: ServicePeriodMonths) => void;
  disabled?: boolean;
  /** The auto period could not be read: say so, and Change still opens (pickers on this month). */
  autoError?: boolean;
  /** "YYYY-MM" the pickers start on when there is no period to start from (the bill month). */
  fallbackMonth?: string;
  /** The "Use auto" button inside the pickers (off where the screen has its own Cancel / Use auto). */
  showUseAuto?: boolean;
}

export function ServicePeriodField({
  idPrefix, current, auto, value, onChange, disabled, autoError, fallbackMonth, showUseAuto = true,
}: ServicePeriodFieldProps) {
  const check = value ? monthsToPeriod(value.from, value.to) : null;
  const autoLabel = auto ? servicePeriodLabel(auto.service_from, auto.service_to) : "";

  if (!value) {
    return (
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-ink" data-testid={`${idPrefix}-period`}>
          {autoError ? (
            <span className="text-amber-ink">The auto period did not load — use Change to set it, or save and it is worked out later.</span>
          ) : current === undefined ? (
            <span className="text-ink-3">Working out…</span>
          ) : current ? (
            <>
              <b className="font-medium">{servicePeriodLabel(current.service_from, current.service_to)}</b>
              <span className="text-ink-3"> · {servicePeriodBasisText(current.basis)}</span>
            </>
          ) : (
            <span className="text-ink-3">Set the bill date to see it.</span>
          )}
        </p>
        <Button
          type="button" variant="default" size="sm" disabled={disabled || (!current && !fallbackMonth)}
          onClick={() => onChange(current
            ? periodToMonths(current.service_from, current.service_to)
            : { from: fallbackMonth ?? "", to: fallbackMonth ?? "" })}
        >
          Change
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="block" htmlFor={`${idPrefix}-from`}>
          <span className="text-3xs uppercase tracking-wider text-ink-3">First month</span>
          <Input id={`${idPrefix}-from`} type="month" className="w-40" disabled={disabled} placeholder="2026-08"
            value={value.from} onChange={(e) => onChange({ ...value, from: e.target.value, to: value.to < e.target.value ? e.target.value : value.to })} />
        </label>
        <label className="block" htmlFor={`${idPrefix}-to`}>
          <span className="text-3xs uppercase tracking-wider text-ink-3">Last month</span>
          <Input id={`${idPrefix}-to`} type="month" className="w-40" disabled={disabled} placeholder="2026-08" min={value.from || undefined}
            value={value.to} onChange={(e) => onChange({ ...value, to: e.target.value })} />
        </label>
        {showUseAuto && (
          <Button type="button" variant="ghost" size="sm" disabled={disabled} onClick={() => onChange(null)}>
            {autoLabel ? `Use auto (${autoLabel})` : "Use auto"}
          </Button>
        )}
      </div>
      {check && !check.ok && (
        <p role="alert" className="text-xs text-rose">{check.error}</p>
      )}
    </div>
  );
}
