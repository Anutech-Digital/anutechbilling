/**
 * Salary Register — the ONE true payroll register: exactly what was actually
 * paid, with the Gross → statutory deductions → Net (in-hand) split spelled
 * out. Print or export (CSV) to share with your CA / for income-tax filing.
 *
 *  • Default: pick a month → every employee paid that month + totals.
 *  • ?employee=<id>: that employee's month-by-month register for the FY.
 *
 * There is deliberately only one set of numbers here — the real ones.
 */
"use client";

import * as React from "react";
import { Suspense } from "react";
import { useSearchParams, useRouter } from "next/navigation";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { errorMessage } from "@/lib/ops/fetch-all";
import { read24Q } from "./tds-24q";

import { HrPageShell } from "../payroll/screens";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, formatDate, toTitleCase } from "@/lib/utils";
import { formatMonthLabel, fyStartYear, fyLabelOfYear, istToday } from "@/lib/dates/ist";
import { useEmployees, useSalaryPayments, useEmployeeSalaryHistory, type SalaryPayment } from "@/lib/queries/payroll";
import { ctcFromEmployee } from "@/lib/payroll/ctc";
import { fyPayslipActuals } from "@/lib/payroll/ctc-register";
import { form16Working, fyStartOfPeriod, fyLabelOf, taxYearFor, type Form16Working } from "@/lib/payroll/income-tax";
import { logExport } from "@/lib/export-log";
import { csvEscape } from "@/lib/csv";
import { printReport } from "@/lib/reports/print";

/** Previous month (YYYY-MM) — the register shows the month that was just paid. */
function prevPeriod(): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
function monthLabel(period: string): string {
  return formatMonthLabel(period);
}
/** TDS quarter (FY-aligned) for a YYYY-MM period → its 3 month strings + label.
 *  Q1 Apr-Jun · Q2 Jul-Sep · Q3 Oct-Dec · Q4 Jan-Mar. */
function quarterOf(period: string): { periods: string[]; label: string } {
  const [y, m] = period.split("-").map(Number);
  const startMonth = m >= 4 && m <= 6 ? 4 : m >= 7 && m <= 9 ? 7 : m >= 10 ? 10 : 1;
  const periods = [0, 1, 2].map((i) => `${y}-${String(startMonth + i).padStart(2, "0")}`);
  const qNum = startMonth === 4 ? 1 : startMonth === 7 ? 2 : startMonth === 10 ? 3 : 4;
  return { periods, label: `Q${qNum} FY${fyLabelOfYear(fyStartYear(period))}` };
}
function statusBadge(s: SalaryPayment["paid_status"]) {
  return (
    <Badge kind={s === "paid" ? "success" : "warning"} size="sm" dot>
      {s === "paid" ? "Paid" : s === "partial" ? "Partial" : "Awaiting reconcile"}
    </Badge>
  );
}
const num = (n: number) => (n > 0 ? rupee(n) : <span className="text-ink-3">—</span>);

/** Money columns shared by header, rows, totals and CSV — one source of truth. */
const COLS: { key: keyof SalaryPayment; label: string }[] = [
  { key: "gross", label: "Gross" },
  { key: "incentive", label: "Bonus" },
  { key: "lop_amount", label: "LOP" },
  { key: "tds", label: "TDS" },
  { key: "pf", label: "PF" },
  { key: "esi", label: "ESI" },
  { key: "other_deduction", label: "Other" },
];

/** Trigger a client-side CSV download. */
function downloadCsv(filename: string, headers: string[], rows: (string | number)[][]) {
  const body = [headers, ...rows].map((r) => r.map(csvEscape).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
  void logExport({ what: filename, rowCount: rows.length, format: "csv" });
}

export default function SalaryRegisterPage() {
  return (
    <HrPageShell
      title="Salary Register"
      sub="The salary you actually paid — gross, statutory deductions and net in-hand. Print or export for your CA."
    >
      <Suspense fallback={null}>
        <SalaryRegisterInner />
      </Suspense>
    </HrPageShell>
  );
}

function SalaryRegisterInner() {
  const params = useSearchParams();
  const employeeId = params.get("employee");
  return employeeId ? <EmployeeRegister employeeId={employeeId} /> : <MonthRegister />;
}

function TotalsRow({ label, rows, leadSpan }: { label: string; rows: SalaryPayment[]; leadSpan: number }) {
  return (
    <tr className="border-t-2 border-hairline-strong bg-paper-2/40 font-semibold">
      <td className="px-3 py-2.5 text-ink" colSpan={leadSpan}>{label}</td>
      {COLS.map((c) => (
        <td key={c.key} className="px-3 py-2.5 text-right font-mono tabular-nums">
          {num(rows.reduce((s, r) => s + (r[c.key] as number), 0))}
        </td>
      ))}
      <td className="px-3 py-2.5 text-right font-mono tabular-nums text-ink">{rupee(rows.reduce((s, r) => s + r.net, 0))}</td>
      <td className="px-3 py-2.5" />
    </tr>
  );
}

// ── All employees for one month ──────────────────────────────────────────────
function MonthRegister() {
  const router = useRouter();
  const [registerTab, setRegisterTab] = React.useState<"paid" | "ctc">("paid");
  const [period, setPeriod] = React.useState(prevPeriod());
  const empQ = useEmployees();
  const payQ = useSalaryPayments(period);

  const empById = new Map((empQ.data ?? []).map((e) => [e.id, e]));
  const rows = (payQ.data ?? []).slice().sort((a, b) =>
    (empById.get(a.employee_id)?.name ?? "").localeCompare(empById.get(b.employee_id)?.name ?? ""));

  const exportCsv = () => {
    downloadCsv(
      `Salary-Register-${period}.csv`,
      ["Employee", "Designation", ...COLS.map((c) => c.label), "Net pay", "Status", "Pay date"],
      rows.map((p) => {
        const e = empById.get(p.employee_id);
        return [
          toTitleCase(e?.name ?? "Employee"), e?.designation ?? "",
          ...COLS.map((c) => p[c.key] as number), p.net, p.paid_status, p.pay_date ?? "",
        ];
      }),
    );
  };

  /* R-1585: the CTC register reads each employee's real structure (monthly gross, Basic, DA,
     PF/ESI flags) through ctcFromEmployee — it used to pass monthly gross × 12 to the CTC
     calculator as if it were the CTC. PF ceiling = this month's (pf.ts). The "actual" columns
     are the current FY's payslips, summed (lib/payroll/ctc-register.ts). */
  const ctcMonth = istToday().slice(0, 7);
  const ctcFy = fyStartYear(ctcMonth);
  const allPayQ = useSalaryPayments();
  const ctcEmployees = empQ.data ?? [];
  const ctcOf = (e: (typeof ctcEmployees)[number]) => ctcFromEmployee(e, { asOf: ctcMonth });
  const fyActuals = fyPayslipActuals(allPayQ.data ?? [], ctcFy);
  const ctcRowsData = ctcEmployees.map((e) => ({ e, ctc: ctcOf(e), actual: fyActuals.byEmployee.get(e.id) }));
  const ctcTotals = ctcRowsData.reduce((t, r) => ({
    annualCtc: t.annualCtc + r.ctc.annualCtc, monthlyCtc: t.monthlyCtc + r.ctc.monthlyCtc, gross: t.gross + r.ctc.grossMonthly,
    employer: t.employer + r.ctc.totalEmployerContributionMonthly, net: t.net + r.ctc.netTakeHomeMonthly,
  }), { annualCtc: 0, monthlyCtc: 0, gross: 0, employer: 0, net: 0 });

  const exportCtcRegisterCsv = () => {
    const ctcRows = ctcRowsData.map(({ e, ctc, actual }) => [
      toTitleCase(e.name),
      e.designation ?? "",
      ctc.annualCtc,
      ctc.monthlyCtc,
      ctc.grossMonthly,
      ctc.basicMonthly,
      ctc.daMonthly,
      ctc.specialAllowanceMonthly,
      ctc.employerPfMonthly,
      ctc.employerEsiMonthly,
      ctc.gratuityMonthly,
      ctc.employeePfMonthly,
      ctc.employeeEsiMonthly,
      ctc.professionalTaxMonthly,
      ctc.netTakeHomeMonthly,
      actual?.months ?? 0,
      actual?.earned ?? 0,
      actual?.employerPf ?? 0,
      actual?.employerEsi ?? 0,
      actual?.cost ?? 0,
    ]);
    const t = fyActuals.totals;
    ctcRows.push([
      "Total", "", ctcTotals.annualCtc, ctcTotals.monthlyCtc, ctcTotals.gross, "", "", "", "", "", "", "", "", "", ctcTotals.net,
      t.months, t.earned, t.employerPf, t.employerEsi, t.cost,
    ]);
    const fyTag = `FY ${fyLabelOfYear(ctcFy)}`;

    downloadCsv(
      `CTC-Master-Structure-Register.csv`,
      [
        "Employee", "Designation", "Annual CTC (₹)", "Monthly CTC (₹)", "Gross Salary (₹/mo)",
        "Basic", "DA", "Other allowances", "Employer PF", "Employer ESI",
        "Gratuity Provision", "Employee PF", "Employee ESI", "Prof. Tax (PT)", "Net Take Home (₹/mo)",
        `Months paid (${fyTag})`, `Salary earned (${fyTag})`, `Employer PF paid (${fyTag})`, `Employer ESI paid (${fyTag})`, `Actual cost (${fyTag})`,
      ],
      ctcRows
    );
    toast.success("Exported CTC Master Salary Structure Register!");
  };

  // 24Q working — salary TDS (section 192), deductee-wise for the whole quarter
  // that contains the selected month. Hand to the CA / import into TDS software
  // (ClearTDS / RPU). The app can't produce the FVU itself.
  const export24Q = async () => {
    const { periods, label } = quarterOf(period);
    const supabase = createClient();
    /* R-1586: every row of the quarter, paged past the gateway's 1000-row cap (./tds-24q.ts).
       24Q Annexure I wants the challan the deduction went in. */
    let read: Awaited<ReturnType<typeof read24Q>>;
    try { read = await read24Q(supabase, periods); }
    catch (e) { toast.error(`Could not load 24Q data: ${errorMessage(e)}`); return; }
    const { pays, emps, challans } = read;
    if (pays.length === 0) { toast.error(`No salary runs in ${label}.`); return; }
    const emap = new Map(emps.map((e) => [e.id, e]));
    const challanOf = new Map<string, { no: string | null; on: string }>();
    for (const c of challans) if (c.period && !challanOf.has(c.period)) challanOf.set(c.period, { no: c.challan_no ?? null, on: c.paid_on });
    let missingPan = 0;
    const outRows = pays
      .slice()
      .sort((a, b) =>
        (toTitleCase(emap.get(a.employee_id)?.name ?? "")).localeCompare(toTitleCase(emap.get(b.employee_id)?.name ?? "")) ||
        a.period.localeCompare(b.period))
      .map((p) => {
        const e = emap.get(p.employee_id);
        if (!e?.pan) missingPan++;
        const ch = challanOf.get(p.period);
        const earned = Math.max(0, (p.gross ?? 0) - (p.lop_amount ?? 0)) + (p.incentive ?? 0);
        return [toTitleCase(e?.name ?? "Employee"), e?.pan ?? "", "192", monthLabel(p.period), p.pay_date ?? "", earned, p.tds ?? 0, ch?.no ?? "", ch?.on ?? ""];
      });
    downloadCsv(
      `24Q-working-${label.replace(/\s+/g, "-")}.csv`,
      ["Employee", "PAN", "Section", "Month", "Pay date", "Amount paid (earned)", "TDS deducted", "Challan no.", "Deposited on"],
      outRows,
    );
    const monthsNoChallan = periods.filter((m) => pays.some((p) => p.period === m && (p.tds ?? 0) > 0) && !challanOf.has(m));
    const totalTds = pays.reduce((s, p) => s + (p.tds ?? 0), 0);
    let msg = `24Q working for ${label} — ${outRows.length} rows, TDS ${rupee(totalTds)}. Import into your TDS software / RPU (the app can't make the FVU).`;
    if (missingPan) msg += ` ⚠ ${missingPan} row(s) missing PAN — add it on the employee.`;
    if (monthsNoChallan.length) msg += ` ⚠ No challan found: ${monthsNoChallan.map(monthLabel).join(", ")} — enter the month + challan no. in Payroll → Record statutory payment.`;
    toast.success(msg);
  };

  return (
    <>
      {/* Register Tab Selector */}
      <div className="flex items-center gap-2 mb-4 bg-paper-2/70 p-1 rounded-xl border border-hairline w-fit">
        <button
          type="button"
          onClick={() => setRegisterTab("paid")}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            registerTab === "paid" ? "bg-paper text-primary shadow-2xs font-extrabold" : "text-ink-3 hover:text-ink"
          }`}
        >
          🧾 Paid Salary Register
        </button>
        <button
          type="button"
          onClick={() => setRegisterTab("ctc")}
          className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all cursor-pointer ${
            registerTab === "ctc" ? "bg-primary text-white shadow-2xs font-extrabold" : "text-ink-3 hover:text-ink"
          }`}
        >
          💼 CTC (Cost to Company) Master Register ({empQ.data?.length ?? 0})
        </button>
      </div>

      {registerTab === "ctc" ? (
        <div className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-lg font-serif font-bold text-ink">Cost to Company (CTC) Salary Matrix</h2>
              <p className="text-xs text-ink-3">Each employee&apos;s monthly gross from Payroll, plus the company&apos;s cost on top (employer PF, employer ESI, gratuity) = CTC. &quot;Actual FY {fyLabelOfYear(ctcFy)}&quot; = what this year&apos;s payslips really paid.</p>
            </div>
            <Button variant="outline" size="sm" icon="download" onClick={exportCtcRegisterCsv}>
              Export CTC Register CSV
            </Button>
          </div>

          <Card flush className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-paper-2/60 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-3 py-3">Employee</th>
                  <th className="text-right px-3 py-3">Annual CTC</th>
                  <th className="text-right px-3 py-3">Monthly CTC</th>
                  <th className="text-right px-3 py-3">Gross</th>
                  <th className="text-right px-3 py-3">Basic + DA</th>
                  <th className="text-right px-3 py-3">Other allow.</th>
                  <th className="text-right px-3 py-3">Employer PF</th>
                  <th className="text-right px-3 py-3">Employer ESI</th>
                  <th className="text-right px-3 py-3">Gratuity</th>
                  <th className="text-right px-3 py-3 font-bold text-emerald-700">Net Take Home</th>
                  <th className="text-right px-3 py-3 whitespace-nowrap">Actual FY {fyLabelOfYear(ctcFy)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {ctcRowsData.map(({ e, ctc, actual }) => (
                  <tr key={e.id} className="hover:bg-paper-2/40 transition-colors">
                    <td className="px-3 py-2.5">
                      <div className="font-bold text-ink">{toTitleCase(e.name)}</div>
                      <div className="text-xs text-ink-3">{e.designation || "Staff"}</div>
                      {ctc.basicAssumed && <div className="text-xs text-amber-ink">Basic not set — PF / gratuity on the full gross</div>}
                    </td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-ink">{rupee(ctc.annualCtc)}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-ink-2">{rupee(ctc.monthlyCtc)}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-semibold text-ink">{rupee(ctc.grossMonthly)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-ink-3">{rupee(ctc.basicMonthly + ctc.daMonthly)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-ink-3">{rupee(ctc.specialAllowanceMonthly)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">{num(ctc.employerPfMonthly)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">{num(ctc.employerEsiMonthly)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">{num(ctc.gratuityMonthly)}</td>
                    <td className="px-3 py-2.5 text-right font-mono font-bold text-emerald-700 text-sm">{rupee(ctc.netTakeHomeMonthly)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-ink-2">
                      {actual ? <>{rupee(actual.cost)}<div className="text-3xs text-ink-3">{actual.months} mo · salary {rupee(actual.earned)}</div></> : <span className="text-ink-3">—</span>}
                    </td>
                  </tr>
                ))}
                {ctcRowsData.length > 0 && (
                  <tr className="border-t-2 border-hairline-strong bg-paper-2/40 font-semibold">
                    <td className="px-3 py-2.5 text-ink">{ctcRowsData.length} employee{ctcRowsData.length > 1 ? "s" : ""}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{rupee(ctcTotals.annualCtc)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{rupee(ctcTotals.monthlyCtc)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{rupee(ctcTotals.gross)}</td>
                    <td className="px-3 py-2.5" colSpan={2} />
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700" colSpan={3}>{rupee(ctcTotals.employer)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{rupee(ctcTotals.net)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">
                      {rupee(fyActuals.totals.cost)}<div className="text-3xs text-ink-3 font-normal">{fyActuals.totals.months} payslips · salary {rupee(fyActuals.totals.earned)}</div>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </Card>
          <p className="text-xs text-ink-3">PF on Basic + DA at this month&apos;s ceiling, ESI only when the employee is ESI-covered and gross ≤ ₹21,000, PT from the app&apos;s PT slab. Actual = salary earned (gross − LOP + bonus) + employer PF + employer ESI on this FY&apos;s payslips.</p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <label htmlFor="salary-register-month" className="text-xs text-ink-3 font-semibold uppercase tracking-wide">Month</label>
              <input id="salary-register-month" type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
                className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
            </div>
            {rows.length > 0 && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" icon="download" onClick={exportCsv}>Export CSV (for CA)</Button>
                <Button variant="outline" size="sm" icon="download" onClick={export24Q} title="Salary-TDS deductee working for this month's quarter (section 192)">24Q working (TDS)</Button>
                <Button variant="ghost" size="sm" icon="file" onClick={() => printReport(`Salary-Register-${period}`, rows.length)}>Print</Button>
              </div>
            )}
          </div>

      {payQ.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2"><EmptyState icon="rupee" title={`No salaries run for ${monthLabel(period)}`} body="Run payroll for this month, then the register fills in." /></Card>
      ) : (
        <Card flush>
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-3 py-3 whitespace-nowrap">Employee</th>
                {COLS.map((c) => <th key={c.key} className="text-right px-3 py-3 whitespace-nowrap">{c.label}</th>)}
                <th className="text-right px-3 py-3 whitespace-nowrap">Net pay</th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((p) => {
                const e = empById.get(p.employee_id);
                return (
                  <tr
                    key={p.id}
                    className="cursor-pointer hover:bg-paper-2/40 transition-colors"
                    role="button" tabIndex={0}
                    onClick={() => router.push(`/accounting/salary-register?employee=${p.employee_id}` as never)}
                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); router.push(`/accounting/salary-register?employee=${p.employee_id}` as never); } }}
                  >
                    <td className="px-3 py-2.5">
                      <div className="font-medium text-ink">{toTitleCase(e?.name ?? "Employee")}</div>
                      {e?.designation && <div className="text-xs text-ink-3 mt-0.5">{e.designation}</div>}
                    </td>
                    {COLS.map((c) => <td key={c.key} className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-2">{num(p[c.key] as number)}</td>)}
                    <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold text-ink">{rupee(p.net)}</td>
                    <td className="px-3 py-2.5">{statusBadge(p.paid_status)}</td>
                  </tr>
                );
              })}
              <TotalsRow label={`${rows.length} employee${rows.length > 1 ? "s" : ""} · ${monthLabel(period)}`} rows={rows} leadSpan={1} />
            </tbody>
          </table>
        </Card>
      )}
      <p className="mt-3 text-xs text-ink-3">
        Net pay = Gross − LOP − TDS − PF − ESI − other. These are the real amounts paid — the same figures your CA files.
      </p>
        </>
      )}
    </>
  );
}

// ── One employee across the financial year ──────────────────────────────────
function EmployeeRegister({ employeeId }: { employeeId: string }) {
  const router = useRouter();
  const empQ = useEmployees();
  const histQ = useEmployeeSalaryHistory(employeeId);
  const emp = (empQ.data ?? []).find((e) => e.id === employeeId);
  const rows = (histQ.data ?? []).slice().sort((a, b) => a.period.localeCompare(b.period));

  /* Form 16 Part B working for one FY — the latest FY with a payslip by default. */
  const fyOptions = React.useMemo(() => Array.from(new Set(rows.map((p) => fyStartOfPeriod(p.period)))).sort((a, b) => b - a), [rows]);
  const [fyPick, setFyPick] = React.useState<number | null>(null);
  const fyStart = fyPick ?? fyOptions[0] ?? fyStartOfPeriod(prevPeriod());
  const f16: Form16Working | null = rows.length ? form16Working(rows, fyStart) : null;
  const exportForm16 = () => {
    if (!f16) return;
    const t = f16.tax;
    downloadCsv(
      `Form16-working-${toTitleCase(emp?.name ?? "employee").replace(/\s+/g, "-")}-FY${f16.fyLabel}.csv`,
      ["Line", "Amount (INR)"],
      [
        ["Employee", toTitleCase(emp?.name ?? "")], ["PAN", emp?.pan ?? ""], ["Financial year", f16.fyLabel], ["Regime", "New (s.115BAC)"], ["", ""],
        ...f16.rows.map((r): [string, number] => [`${monthLabel(r.period)} — salary paid (gross − LOP + incentive)`, r.earned]),
        ["1. Gross salary (as paid)", t.grossSalary],
        ["2. Standard deduction u/s 16(ia)", t.standardDeduction],
        ["3. Income chargeable under Salaries", t.taxableIncome],
        ["4. Tax on total income", t.taxOnSlabs],
        ["5. Rebate u/s 87A", t.rebate87A],
        ["6. Tax after rebate", t.taxAfterRebate],
        ["7. Health & education cess 4%", t.cess],
        ["8. Total tax payable", t.totalTax],
        ["9. TDS deducted (s.192)", f16.tdsDeducted],
        [f16.balance > 0 ? "10. Short deducted — deduct before March" : "10. Excess deducted (refund via ITR)", Math.abs(f16.balance)],
        ["", ""],
        ["Employee PF (info — no deduction in new regime)", f16.employeePf],
      ],
    );
    toast.success(`Form 16 working FY ${f16.fyLabel}: gross ${rupee(t.grossSalary)}, tax ${rupee(t.totalTax)}, TDS ${rupee(f16.tdsDeducted)}${f16.balance > 0 ? `, ${rupee(f16.balance)} kam kata` : f16.balance < 0 ? `, ${rupee(-f16.balance)} zyada kata` : ", barabar"}.`);
  };

  const exportCsv = () => {
    downloadCsv(
      `Salary-Register-${toTitleCase(emp?.name ?? "employee").replace(/\s+/g, "-")}.csv`,
      ["Month", "Pay date", ...COLS.map((c) => c.label), "Net pay", "Status"],
      rows.map((p) => [monthLabel(p.period), p.pay_date ?? "", ...COLS.map((c) => p[c.key] as number), p.net, p.paid_status]),
    );
  };

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <button type="button" onClick={() => router.push("/accounting/salary-register" as never)}
          className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink">
          <Icon name="arrow_left" size={15} /> All employees
        </button>
        {rows.length > 0 && (
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" icon="download" onClick={exportCsv}>Export CSV</Button>
            <Button variant="outline" size="sm" icon="download" onClick={exportForm16} title="Form 16 Part B / 24Q Annexure II working (new regime)">Form 16 working</Button>
            <Button variant="ghost" size="sm" icon="file" onClick={() => printReport(`Salary-Register-${toTitleCase(emp?.name ?? "employee").replace(/\s+/g, "-")}`, rows.length)}>Print</Button>
          </div>
        )}
      </div>

      {f16 && (
        <Card className="mb-4 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
            <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Income tax (s.192) — FY {f16.fyLabel} · new regime</div>
            {fyOptions.length > 1 && (
              <select aria-label="Financial year" value={fyStart} onChange={(e) => setFyPick(Number(e.target.value))} className="rounded-md border border-hairline bg-paper px-2 py-1 text-xs">
                {fyOptions.map((y) => <option key={y} value={y}>FY {fyLabelOf(y)}</option>)}
              </select>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
            <div><div className="text-xs text-ink-3">Salary paid ({f16.monthsPaid} mo)</div><div className="font-mono text-ink">{rupee(f16.tax.grossSalary)}</div></div>
            {/* New regime: ₹12L rebate (s.87A) + ₹75k standard deduction = nothing to pay up to
                ₹12.75L of salary. Showing "taxable ₹37,445" for a ₹1.1L salary reads like a tax
                bill — so the tile shows the tax-free limit and what, if anything, is above it. */}
            <div>
              <div className="text-xs text-ink-3">Tax-free up to (₹{taxYearFor(f16.fyStart).rebateLimit.toLocaleString("en-IN")} s.87A + ₹{taxYearFor(f16.fyStart).standardDeduction.toLocaleString("en-IN")} std. ded.)</div>
              <div className="font-mono text-ink">{rupee(taxYearFor(f16.fyStart).rebateLimit + taxYearFor(f16.fyStart).standardDeduction)}</div>
            </div>
            <div>
              <div className="text-xs text-ink-3">Above the limit</div>
              <div className={`font-mono ${f16.tax.taxableIncome > taxYearFor(f16.fyStart).rebateLimit ? "text-rose" : "text-emerald"}`}>{rupee(Math.max(0, f16.tax.taxableIncome - taxYearFor(f16.fyStart).rebateLimit))}</div>
            </div>
            <div><div className="text-xs text-ink-3">Tax for the year (incl. cess)</div><div className="font-mono text-ink">{rupee(f16.tax.totalTax)}</div></div>
            <div><div className="text-xs text-ink-3">TDS deducted</div><div className="font-mono text-ink">{rupee(f16.tdsDeducted)}</div></div>
            <div>
              <div className="text-xs text-ink-3">{f16.balance > 0 ? "Short — deduct by March" : f16.balance < 0 ? "Excess (refund via ITR)" : "Balance"}</div>
              <div className={`font-mono ${f16.balance > 0 ? "text-rose" : f16.balance < 0 ? "text-amber-ink" : "text-emerald"}`}>{rupee(Math.abs(f16.balance))}</div>
            </div>
          </div>
          {f16.tax.rebate87A > 0 && f16.tax.totalTax === 0 && <p className="text-xs text-ink-3 mt-2">Taxable income up to ₹12 lakh — tax is nil after the s.87A rebate; if incentives take it higher during the year, TDS applies.</p>}
        </Card>
      )}

      <Card className="mb-4 p-4">
        <div className="text-2xs uppercase tracking-wider text-ink-3 font-semibold">Salary register</div>
        <div className="font-serif text-2xl text-ink leading-tight mt-1">{toTitleCase(emp?.name ?? "Employee")}</div>
        <div className="text-xs text-ink-3 mt-0.5">
          {[emp?.designation?.trim() || null, emp?.joining_date ? `Joined ${formatDate(emp.joining_date)}` : null].filter(Boolean).join(" · ")}
        </div>
      </Card>

      {histQ.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2"><EmptyState icon="rupee" title="No salary runs yet" body="Once you run this employee's payroll, every month shows here." /></Card>
      ) : (
        <Card flush>
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-3 py-3 whitespace-nowrap">Month</th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Pay date</th>
                {COLS.map((c) => <th key={c.key} className="text-right px-3 py-3 whitespace-nowrap">{c.label}</th>)}
                <th className="text-right px-3 py-3 whitespace-nowrap">Net pay</th>
                <th className="text-left px-3 py-3 whitespace-nowrap">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {rows.map((p) => (
                <tr key={p.id} className="hover:bg-paper-2/40">
                  <td className="px-3 py-2.5 font-medium text-ink whitespace-nowrap">{monthLabel(p.period)}</td>
                  <td className="px-3 py-2.5 text-ink-2 whitespace-nowrap">{p.pay_date ? formatDate(p.pay_date) : "—"}</td>
                  {COLS.map((c) => <td key={c.key} className="px-3 py-2.5 text-right font-mono tabular-nums text-ink-2">{num(p[c.key] as number)}</td>)}
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums font-semibold text-ink">{rupee(p.net)}</td>
                  <td className="px-3 py-2.5">{statusBadge(p.paid_status)}</td>
                </tr>
              ))}
              <TotalsRow label={`${rows.length} month${rows.length > 1 ? "s" : ""}`} rows={rows} leadSpan={2} />
            </tbody>
          </table>
        </Card>
      )}
    </>
  );
}
