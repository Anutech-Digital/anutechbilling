/**
 * R-2699 — "Revise salary": a new CTC / monthly gross from a MONTH, kept as history.
 *
 * Months before "Effective from" keep the old salary (lib/payroll/salary-revision.ts
 * salaryInForce); booked months are never changed — a month already paid gives arrears that the
 * next Pay salary offers. The breakdown is the profile's own CTC (ctcFromEmployee) with the
 * employee's PF / ESI switches and that month's PF ceiling. One RPC: revise_employee_salary.
 */
"use client";

import * as React from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee } from "@/lib/utils";
import { ctcFromEmployee } from "@/lib/payroll/ctc";
import { periodLabel } from "@/lib/payroll/period-label";
import {
  arrearsForMonth, defaultEffectiveMonth, grossForAnnualCtc, nextPeriod, revisionBookedNote, revisionMonth, salaryInForce, scaledStructure,
} from "@/lib/payroll/salary-revision";
import { useEmployeeSalaryHistory, useReviseSalary, useSalaryRevisions, type Employee } from "@/lib/queries/payroll";
import { istToday } from "@/lib/dates/ist";

export function ReviseSalaryDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const revisionsQ = useSalaryRevisions();
  const historyQ = useEmployeeSalaryHistory(employee.id);
  const revise = useReviseSalary();

  const revisions = React.useMemo(
    () => (revisionsQ.data ?? []).filter((r) => r.employee_id === employee.id),
    [revisionsQ.data, employee.id],
  );
  const booked = React.useMemo(() => historyQ.data ?? [], [historyQ.data]);
  const lastBooked = booked.length > 0 ? booked[booked.length - 1].period : null;
  const latestRev = revisions.length > 0 ? revisionMonth(revisions[revisions.length - 1]) : null;
  const minMonth = [latestRev ? nextPeriod(latestRev) : null, employee.joining_date?.slice(0, 7) ?? null]
    .filter((x): x is string => Boolean(x)).sort().pop() ?? "";

  // The salary going forward (employees row) is what a new revision replaces.
  const current = { monthly_gross: employee.monthly_gross, basic_monthly: employee.basic_monthly, da_monthly: employee.da_monthly ?? 0 };
  const switches = { pf_applicable: employee.pf_applicable, esi_applicable: employee.esi_applicable, pf_full_wage: employee.pf_full_wage };

  const [month, setMonth] = React.useState("");
  React.useEffect(() => {
    if (month || !historyQ.isSuccess || !revisionsQ.isSuccess) return;
    const d = defaultEffectiveMonth(istToday(), lastBooked);
    setMonth(minMonth && d < minMonth ? minMonth : d);
  }, [month, historyQ.isSuccess, revisionsQ.isSuccess, lastBooked, minMonth]);
  const asOf = month || istToday().slice(0, 7);

  const currentCtc = ctcFromEmployee({ ...current, ...switches }, { asOf }).annualCtc;
  const [gross, setGross] = React.useState(String(employee.monthly_gross || ""));
  const [ctc, setCtc] = React.useState(String(currentCtc || ""));
  const [basic, setBasic] = React.useState(employee.basic_monthly != null ? String(employee.basic_monthly) : "");
  const [da, setDa] = React.useState(String(employee.da_monthly ?? 0));
  const [splitTyped, setSplitTyped] = React.useState(false);
  const [note, setNote] = React.useState("");

  const applyGross = (g: number) => {
    if (splitTyped) return;
    const s = scaledStructure(current, g);
    setBasic(s.basic_monthly != null ? String(s.basic_monthly) : "");
    setDa(String(s.da_monthly ?? 0));
  };
  const onGross = (v: string) => {
    setGross(v);
    const g = Math.max(0, Math.round(Number(v) || 0));
    applyGross(g);
    const s = splitTyped ? { monthly_gross: g, basic_monthly: basic === "" ? null : Number(basic), da_monthly: Number(da) || 0 } : scaledStructure(current, g);
    setCtc(g > 0 ? String(ctcFromEmployee({ ...s, ...switches }, { asOf }).annualCtc) : "");
  };
  const onCtc = (v: string) => {
    setCtc(v);
    const g = grossForAnnualCtc(Number(v) || 0, { ...current, ...switches }, asOf);
    setGross(g > 0 ? String(g) : "");
    applyGross(g);
  };

  const grossN = Math.max(0, Math.round(Number(gross) || 0));
  const basicN = basic.trim() === "" ? null : Math.max(0, Math.round(Number(basic) || 0));
  const daN = Math.max(0, Math.round(Number(da) || 0));
  const next = { monthly_gross: grossN, basic_monthly: basicN, da_monthly: daN };
  const breakdown = ctcFromEmployee({ ...next, ...switches }, { asOf });

  const same = grossN === employee.monthly_gross && basicN === employee.basic_monthly && daN === (employee.da_monthly ?? 0);
  const splitTooBig = (basicN ?? 0) + daN > grossN;
  const tooEarly = Boolean(month && minMonth && month < minMonth);
  const pct = employee.monthly_gross > 0 ? ((grossN - employee.monthly_gross) / employee.monthly_gross) * 100 : 0;

  // Months already booked from the chosen month on stay as booked; a raise gives arrears.
  const bookedFrom = month ? booked.filter((p) => p.period >= month) : [];
  const cutIntoPaid = grossN < employee.monthly_gross && bookedFrom.length > 0;
  const arrearsEstimate = bookedFrom.reduce((s, p) => {
    /* The salary stored at booking (salary_payments.salary_in_force) — as employee_salary_arrears does. */
    const old = p.salary_in_force ?? salaryInForce(current, revisions, p.period).monthly_gross;
    return s + arrearsForMonth(Math.max(0, p.gross - (p.lop_amount ?? 0)), old, grossN);
  }, 0);
  /* R-2722: "booked", not "paid" (a booked month is paid only when a bank line is linked); months
     booked before salary revisions are named — their old salary is inferred, check it. */
  const bookedNote = revisionBookedNote(bookedFrom, periodLabel);

  const valid = Boolean(month) && grossN > 0 && !same && !splitTooBig && !tooEarly && !cutIntoPaid;

  async function submit() {
    if (!valid) return;
    try {
      await revise.mutateAsync({
        employeeId: employee.id, effectiveMonth: month, monthlyGross: grossN,
        basicMonthly: basicN, daMonthly: daN, annualCtc: breakdown.annualCtc, note: note.trim() || null,
      });
      onClose();
    } catch { /* the hook shows the error */ }
  }

  const label = "block text-xs font-medium text-ink-2 mb-1";
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-xl">
        <DialogHeader>
          <DialogTitle>Revise salary — {employee.name}</DialogTitle>
          <DialogDescription>
            Payroll before the month you pick keeps the old salary; from that month on it uses the new one. The change is kept in the salary history.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="revise-effective" className={label}>Effective from (month)</label>
              <Input id="revise-effective" type="month" value={month} min={minMonth || undefined} onChange={(e) => setMonth(e.target.value)} />
              {tooEarly && <p className="mt-1 text-xs text-rose">Pick {periodLabel(minMonth)} or later{latestRev ? ` — a revision from ${periodLabel(latestRev)} already exists` : ""}.</p>}
            </div>
            <div className="text-xs text-ink-3 self-end pb-1">
              Now: <b className="text-ink-2">{rupee(employee.monthly_gross)}</b>/month · CTC {rupee(currentCtc)}/yr
            </div>
            <div>
              <label htmlFor="revise-ctc" className={label}>New annual CTC (₹)</label>
              <Input id="revise-ctc" type="number" min={0} value={ctc} onChange={(e) => onCtc(e.target.value)} />
            </div>
            <div>
              <label htmlFor="revise-gross" className={label}>New monthly gross (₹)</label>
              <Input id="revise-gross" type="number" min={0} value={gross} onChange={(e) => onGross(e.target.value)} />
            </div>
            <div>
              <label htmlFor="revise-basic" className={label}>Basic (₹/month)</label>
              <Input id="revise-basic" type="number" min={0} value={basic} placeholder="Not set" onChange={(e) => { setSplitTyped(true); setBasic(e.target.value); }} />
            </div>
            <div>
              <label htmlFor="revise-da" className={label}>DA (₹/month)</label>
              <Input id="revise-da" type="number" min={0} value={da} onChange={(e) => { setSplitTyped(true); setDa(e.target.value); }} />
            </div>
          </div>
          {splitTooBig && <p className="text-xs text-rose">Basic + DA can&apos;t be more than the monthly gross.</p>}

          {grossN > 0 && (
            <div className="rounded-md bg-paper-2/50 p-3 text-xs text-ink-2 space-y-1" data-testid="revise-breakdown">
              <div className="flex items-center justify-between text-sm text-ink">
                <span>{rupee(employee.monthly_gross)} → <b>{rupee(grossN)}</b> a month</span>
                {!same && employee.monthly_gross > 0 && <span className={pct >= 0 ? "text-emerald" : "text-rose"}>{pct >= 0 ? "+" : ""}{pct.toFixed(1)}%</span>}
              </div>
              <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                <span>Basic {rupee(breakdown.basicMonthly)}{breakdown.daMonthly > 0 ? ` · DA ${rupee(breakdown.daMonthly)}` : ""}</span>
                <span>Other allowances {rupee(breakdown.specialAllowanceMonthly)}</span>
                <span>Employer PF {rupee(breakdown.employerPfMonthly)}{employee.pf_applicable ? "" : " (PF off)"}</span>
                <span>Employer ESI {rupee(breakdown.employerEsiMonthly)}{employee.esi_applicable ? "" : " (ESI off)"}</span>
                <span>Gratuity {rupee(breakdown.gratuityMonthly)}</span>
                <span>Take-home about {rupee(breakdown.netTakeHomeMonthly)}</span>
              </div>
              <div className="border-t border-hairline pt-1 font-semibold text-ink">CTC {rupee(breakdown.annualCtc)}/yr ({rupee(breakdown.monthlyCtc)}/month)</div>
            </div>
          )}

          {cutIntoPaid ? (
            <p className="text-xs text-rose">
              A lower salary can&apos;t start in a month that is already booked ({periodLabel(bookedFrom[bookedFrom.length - 1].period)}). Pick a month after the last booked one.
            </p>
          ) : bookedFrom.length > 0 && arrearsEstimate > 0 ? (
            <div className="rounded-md border border-amber/40 bg-amber-soft/40 px-3 py-2 text-xs text-amber-ink">
              {bookedNote.booked}
              {" "}The difference, about <b>{rupee(arrearsEstimate)}</b>, is offered as <b>arrears</b> in the next Pay salary.
            </div>
          ) : null}
          {/* Shown whatever the arrears are — a guessed old salary matters most when it gives none. */}
          {bookedNote.legacy && <p data-testid="revise-legacy-months" className="text-xs font-medium text-amber-ink">{bookedNote.legacy}</p>}

          <div>
            <label htmlFor="revise-note" className={label}>Note (optional)</label>
            <Input id="revise-note" value={note} placeholder="e.g. Annual increment" onChange={(e) => setNote(e.target.value)} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={revise.isPending}>Cancel</Button>
          <Button variant="primary" loading={revise.isPending} disabled={!valid} onClick={submit}>
            Save revision{month ? ` from ${periodLabel(month)}` : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
