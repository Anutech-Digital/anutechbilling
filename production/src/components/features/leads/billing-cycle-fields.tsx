"use client";
/**
 * The drawer's billing cycle + current provider — editable in place (R-071, migration
 * 20260930200000: leads.billing_cycle / leads.current_provider). Same pattern as
 * ExpectedCloseField: a quiet save on change / blur, nothing saved when nothing changed.
 *
 * The cycle is descriptive — `value` stays the ANNUAL deal value (lib/leads/billing-cycle.ts),
 * so a monthly deal shows one month's bill beside it rather than changing the value.
 */
import * as React from "react";
import type { Lead } from "@/lib/supabase/database.types";
import { useUpdateLead } from "@/lib/queries/leads";
import { BILLING_CYCLE_OPTIONS, monthlyBill, toBillingCycle } from "@/lib/leads/billing-cycle";
import { rupee } from "@/lib/utils";

const BOX = "w-full rounded-md border border-hairline bg-paper px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber/40";

export function BillingCycleField({ lead }: { lead: Pick<Lead, "id" | "billing_cycle" | "value"> }) {
  const updateLead = useUpdateLead({ quiet: true });
  const saved = lead.billing_cycle ?? "";
  const perMonth = lead.billing_cycle === "monthly" ? monthlyBill(lead.value) : null;
  return (
    <div>
      <label htmlFor={`cycle-${lead.id}`} className="block text-2xs uppercase tracking-wider text-ink-3 mb-0.5">
        Payment frequency
      </label>
      <select
        id={`cycle-${lead.id}`}
        value={saved}
        onChange={(e) => {
          const next = toBillingCycle(e.target.value);
          if (next === (lead.billing_cycle ?? null)) return;
          updateLead.mutate({ id: lead.id, patch: { billing_cycle: next } });
        }}
        className={BOX}
      >
        <option value="">Not set</option>
        {BILLING_CYCLE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {perMonth !== null && (
        <p className="mt-0.5 text-xs text-ink-3">≈ {rupee(perMonth)}/month (deal value is per year)</p>
      )}
    </div>
  );
}

export function CurrentProviderField({ lead }: { lead: Pick<Lead, "id" | "current_provider"> }) {
  const updateLead = useUpdateLead({ quiet: true });
  const saved = lead.current_provider ?? "";
  const save = (raw: string) => {
    const next = raw.trim().slice(0, 120) || null;
    if (next === (lead.current_provider ?? null)) return;
    updateLead.mutate({ id: lead.id, patch: { current_provider: next } });
  };
  return (
    <div>
      <label htmlFor={`provider-${lead.id}`} className="block text-2xs uppercase tracking-wider text-ink-3 mb-0.5">
        Current provider
      </label>
      <input
        id={`provider-${lead.id}`}
        type="text"
        maxLength={120}
        placeholder="e.g. Direct Google"
        defaultValue={saved}
        key={saved}
        onBlur={(e) => save(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); (e.target as HTMLInputElement).blur(); } }}
        className={BOX}
      />
    </div>
  );
}
