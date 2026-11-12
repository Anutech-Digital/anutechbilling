"use client";

/**
 * R-2700 (Hitesh item 8): the company's payroll policy — ESI / PF / gratuity and how a CTC is
 * split — in ONE place, on the Employees page where people are added. Everyone with payroll
 * access sees the summary; only the owner edits (the route refuses anyone else).
 *
 * Used as the defaults for a NEW employee and by the CTC calculator. Existing employees keep
 * their own switches, and booked salaries never change — the card says so.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Icon } from "@/components/ui/icon";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { usePayrollPolicy, useSavePayrollPolicy } from "@/lib/queries/payroll-policy";
import {
  BASIC_PCT_MAX, BASIC_PCT_MIN, DEFAULT_PAYROLL_POLICY, payrollPolicySummary, validatePayrollPolicyInput, type PayrollPolicy,
} from "@/lib/payroll/policy";
import { pfWageCeiling } from "@/lib/payroll/pf";
import { ESI_WAGE_CEILING } from "@/lib/payroll/esi";
import { rupee } from "@/lib/utils";

function Check({ id, checked, onChange, disabled, children }: { id: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label htmlFor={id} className="flex items-start gap-2 rounded-md border border-hairline p-2.5 cursor-pointer hover:border-hairline-strong">
      <input id={id} type="checkbox" className="mt-0.5 rounded border-hairline" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="text-xs text-ink-2">{children}</span>
    </label>
  );
}

export function PayrollPolicyCard() {
  const q = usePayrollPolicy();
  const save = useSavePayrollPolicy();
  const isOwner = useCurrentUser().data?.role === "owner";
  const saved = q.data ?? DEFAULT_PAYROLL_POLICY;
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState<PayrollPolicy>(saved);
  const [pctText, setPctText] = React.useState(String(saved.basicPct));
  const pfCeiling = pfWageCeiling();

  const startEdit = () => { setDraft(saved); setPctText(String(saved.basicPct)); setEditing(true); };
  const check = validatePayrollPolicyInput({ ...draft, basicPct: pctText });
  const set = (patch: Partial<PayrollPolicy>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <Card className="mb-4 p-4" data-testid="payroll-policy-card">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-ink flex items-center gap-2">
            <Icon name="shield" size={14} className="text-ink-3" /> Payroll policy
          </h2>
          <p className="text-xs text-ink-3 mt-0.5">Company rules used for new employees and by the CTC calculator. Existing employees keep their own PF / ESI settings; booked salaries never change.</p>
          {!editing && (
            <ul className="mt-2 space-y-0.5 text-xs text-ink-2" data-testid="payroll-policy-summary">
              {payrollPolicySummary(saved, pfCeiling, ESI_WAGE_CEILING).map((line) => <li key={line}>{line}</li>)}
            </ul>
          )}
        </div>
        {isOwner && !editing && (
          <Button variant="outline" size="sm" icon="edit" onClick={startEdit} disabled={q.isLoading}>Edit policy</Button>
        )}
      </div>

      {editing && (
        <form
          className="mt-3 space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!check.ok) return;
            save.mutate(check.policy, { onSuccess: () => setEditing(false) });
          }}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <Check id="policy-pf" checked={draft.pfDefault} onChange={(v) => set({ pfDefault: v, pfFullWageDefault: v && draft.pfFullWageDefault })}>
              <b className="text-ink">PF for new employees</b> — 12% employee + 12% employer on Basic + DA.
            </Check>
            <Check id="policy-pf-full" checked={draft.pfFullWageDefault} disabled={!draft.pfDefault} onChange={(v) => set({ pfFullWageDefault: v })}>
              <b className="text-ink">PF on the full Basic + DA</b> — off = capped at {rupee(pfCeiling)} a month (statutory ceiling).
            </Check>
            <Check id="policy-esi" checked={draft.esiDefault} onChange={(v) => set({ esiDefault: v })}>
              <b className="text-ink">ESI registered</b> — a new employee with monthly gross {rupee(ESI_WAGE_CEILING)} or less is ESI-covered (0.75% + 3.25%).
            </Check>
            <Check id="policy-gratuity" checked={draft.gratuity} onChange={(v) => set({ gratuity: v })}>
              <b className="text-ink">Accrue gratuity</b> — 4.81% of Basic (15 days a year) counted in the CTC.
            </Check>
          </div>
          <fieldset className="rounded-md border border-hairline p-2.5">
            <legend className="px-1 text-xs font-medium text-ink-2">The CTC you write in an offer</legend>
            <label className="flex items-start gap-2 text-xs text-ink-2 py-1 cursor-pointer">
              <input type="radio" name="policy-ctc" className="mt-0.5" checked={draft.ctcIncludesEmployer} onChange={() => set({ ctcIncludesEmployer: true })} />
              <span><b className="text-ink">Includes</b> employer PF / ESI / gratuity — monthly gross = CTC ÷ 12 minus them.</span>
            </label>
            <label className="flex items-start gap-2 text-xs text-ink-2 py-1 cursor-pointer">
              <input type="radio" name="policy-ctc" className="mt-0.5" checked={!draft.ctcIncludesEmployer} onChange={() => set({ ctcIncludesEmployer: false })} />
              <span><b className="text-ink">Is the gross pay</b> — monthly gross = CTC ÷ 12; employer PF / ESI / gratuity are paid on top.</span>
            </label>
          </fieldset>
          <label htmlFor="policy-basic-pct" className="block text-xs text-ink-2">
            Basic as % of the monthly salary
            <Input id="policy-basic-pct" type="number" min={BASIC_PCT_MIN} max={BASIC_PCT_MAX} step={1} value={pctText}
              className="mt-1 w-28" onChange={(e) => setPctText(e.target.value)} />
          </label>
          {!check.ok && <p role="alert" className="text-xs text-rose-700">{check.error}</p>}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" size="sm" disabled={!check.ok || save.isPending}>{save.isPending ? "Saving…" : "Save policy"}</Button>
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>Cancel</Button>
          </div>
        </form>
      )}
    </Card>
  );
}
