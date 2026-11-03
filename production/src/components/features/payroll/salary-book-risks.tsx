/**
 * R-2428 — the checks before ONE bank line becomes a NEW salary record (Reconcile → employee →
 * "Book ₹… as salary"): left already (refused), before joining, after a full & final, inactive
 * (warned — the operator must tick "Book anyway"). Same rules as Banking → Salary lines
 * (lib/banking/salary-lines.ts → salaryLineRisks). Booking into a record that already exists
 * for that month is not a new record — no check.
 */
"use client";

import * as React from "react";

import { salaryLineRisks, type SalaryLineRisk } from "@/lib/banking/salary-lines";
import { useEmployeeSalaryHistory, type Employee } from "@/lib/queries/payroll";

const NONE: SalaryLineRisk = { block: null, warnings: [] };

export function SalaryBookRisks({ employee, period, onChange }: {
  employee: Employee;
  period: string;
  /** The current risk — the parent disables its save on `block`, or on warnings until confirmed. */
  onChange: (risk: SalaryLineRisk) => void;
}) {
  const history = useEmployeeSalaryHistory(employee.id);
  const [confirmed, setConfirmed] = React.useState(false);
  const risk = React.useMemo<SalaryLineRisk>(() => {
    const rows = history.data ?? [];
    if (!period || rows.some((r) => r.period === period)) return NONE;
    return salaryLineRisks({ employee, period, lineKey: null, knownKeys: [], salaries: rows });
  }, [history.data, employee, period]);

  React.useEffect(() => { setConfirmed(false); }, [employee.id, period]);
  React.useEffect(() => {
    onChange(risk.block || confirmed ? { block: risk.block, warnings: [] } : risk);
  }, [risk, confirmed, onChange]);

  if (risk.block) return <p className="text-xs text-rose-ink">{risk.block}</p>;
  if (risk.warnings.length === 0) return null;
  return (
    <div className="rounded bg-amber-soft/40 px-2 py-1.5 space-y-1">
      {risk.warnings.map((w) => <p key={w} className="text-xs text-amber-ink leading-snug">{w}</p>)}
      <label className="inline-flex items-center gap-1.5 text-xs text-ink-2">
        <input type="checkbox" className="accent-amber" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
        This salary is right — book it anyway
      </label>
    </div>
  );
}
