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

import { HrPageShell } from "../payroll/screens";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { rupee, formatDate, toTitleCase } from "@/lib/utils";
import { useEmployees, useSalaryPayments, useEmployeeSalaryHistory, type SalaryPayment } from "@/lib/queries/payroll";
import { calculateCtcBreakdown } from "@/lib/payroll/ctc";

/** Previous month (YYYY-MM) — the register shows the month that was just paid. */
function prevPeriod(): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
function monthLabel(period: string): string {
  const [y, m] = period.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString("en-IN", { month: "short", year: "numeric" });
}
/** TDS quarter (FY-aligned) for a YYYY-MM period → its 3 month strings + label.
 *  Q1 Apr-Jun · Q2 Jul-Sep · Q3 Oct-Dec · Q4 Jan-Mar. */
function quarterOf(period: string): { periods: string[]; label: string } {
  const [y, m] = period.split("-").map(Number);
  const startMonth = m >= 4 && m <= 6 ? 4 : m >= 7 && m <= 9 ? 7 : m >= 10 ? 10 : 1;
  const periods = [0, 1, 2].map((i) => `${y}-${String(startMonth + i).padStart(2, "0")}`);
  const qNum = startMonth === 4 ? 1 : startMonth === 7 ? 2 : startMonth === 10 ? 3 : 4;
  const fy = m >= 4 ? y : y - 1;
  return { periods, label: `Q${qNum} FY${fy}-${String((fy + 1) % 100).padStart(2, "0")}` };
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
  const esc = (v: string | number) => {
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = [headers, ...rows].map((r) => r.map(esc).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([body], { type: "text/csv;charset=utf-8;" }));
  const a = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
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

  const exportCtcRegisterCsv = () => {
    const ctcRows = (empQ.data ?? []).map((e) => {
      const ctc = calculateCtcBreakdown(e.monthly_gross * 12);
      return [
        toTitleCase(e.name),
        e.designation ?? "",
        ctc.annualCtc,
        ctc.monthlyCtc,
        ctc.grossMonthly,
        ctc.basicMonthly,
        ctc.hraMonthly,
        ctc.specialAllowanceMonthly,
        ctc.employerPfMonthly,
        ctc.employerEsiMonthly,
        ctc.gratuityMonthly,
        ctc.employeePfMonthly,
        ctc.professionalTaxMonthly,
        ctc.netTakeHomeMonthly,
      ];
    });

    downloadCsv(
      `CTC-Master-Structure-Register.csv`,
      [
        "Employee", "Designation", "Annual CTC (₹)", "Monthly CTC (₹)", "Gross Salary (₹/mo)",
        "Basic Salary (50%)", "HRA (40%)", "Special Allowance", "Employer PF (12%)", "Employer ESI",
        "Gratuity Provision", "Employee PF", "Prof. Tax (PT)", "Net Take Home (₹/mo)"
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
    const { data: pays } = await supabase
      .from("salary_payments")
      .select("employee_id, period, pay_date, gross, tds")
      .in("period", periods);
    if (!pays || pays.length === 0) { toast.error(`No salary runs in ${label}.`); return; }
    const empIds = Array.from(new Set(pays.map((p) => p.employee_id)));
    const { data: emps } = await supabase.from("employees").select("id, name, pan").in("id", empIds);
    const emap = new Map((emps ?? []).map((e) => [e.id, e]));
    let missingPan = 0;
    const outRows = pays
      .slice()
      .sort((a, b) =>
        (toTitleCase(emap.get(a.employee_id)?.name ?? "")).localeCompare(toTitleCase(emap.get(b.employee_id)?.name ?? "")) ||
        a.period.localeCompare(b.period))
      .map((p) => {
        const e = emap.get(p.employee_id);
        if (!e?.pan) missingPan++;
        return [toTitleCase(e?.name ?? "Employee"), e?.pan ?? "", "192", monthLabel(p.period), p.pay_date ?? "", p.gross ?? 0, p.tds ?? 0];
      });
    downloadCsv(
      `24Q-working-${label.replace(/\s+/g, "-")}.csv`,
      ["Employee", "PAN", "Section", "Month", "Pay date", "Amount paid (Gross)", "TDS deducted"],
      outRows,
    );
    const totalTds = pays.reduce((s, p) => s + (p.tds ?? 0), 0);
    let msg = `24Q working for ${label} — ${outRows.length} rows, TDS ${rupee(totalTds)}. Import into your TDS software / RPU (the app can't make the FVU).`;
    if (missingPan) msg += ` ⚠ ${missingPan} row(s) missing PAN — add it on the employee.`;
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
              <p className="text-xs text-ink-3">Comprehensive breakdown of Gross Salary, Employer Retirals (EPF/ESI/Gratuity), Deductions &amp; Net In-Hand Take Home.</p>
            </div>
            <Button variant="outline" size="sm" icon="download" onClick={exportCtcRegisterCsv}>
              Export CTC Register CSV
            </Button>
          </div>

          <Card flush>
            <table className="w-full text-xs">
              <thead className="bg-paper-2/60 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-3 py-3">Employee</th>
                  <th className="text-right px-3 py-3">Annual CTC</th>
                  <th className="text-right px-3 py-3">Monthly CTC</th>
                  <th className="text-right px-3 py-3">Gross Base</th>
                  <th className="text-right px-3 py-3">Basic (50%)</th>
                  <th className="text-right px-3 py-3">HRA (40%)</th>
                  <th className="text-right px-3 py-3">Conveyance</th>
                  <th className="text-right px-3 py-3">Medical</th>
                  <th className="text-right px-3 py-3">Special Allow.</th>
                  <th className="text-right px-3 py-3">Employer Retirals</th>
                  <th className="text-right px-3 py-3 font-bold text-emerald-700">Net Take Home</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {(empQ.data ?? []).map((e) => {
                  const ctc = calculateCtcBreakdown(e.monthly_gross * 12);
                  return (
                    <tr key={e.id} className="hover:bg-paper-2/40 transition-colors">
                      <td className="px-3 py-2.5">
                        <div className="font-bold text-ink">{toTitleCase(e.name)}</div>
                        <div className="text-[10px] text-ink-3">{e.designation || "Staff"}</div>
                      </td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold text-ink">{rupee(ctc.annualCtc)}</td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold text-ink-2">{rupee(ctc.monthlyCtc)}</td>
                      <td className="px-3 py-2.5 text-right font-mono font-semibold text-ink">{rupee(ctc.grossMonthly)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ink-3">{rupee(ctc.basicMonthly)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ink-3">{rupee(ctc.hraMonthly)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ink-3">{rupee(ctc.conveyanceMonthly)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ink-3">{rupee(ctc.medicalMonthly)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-ink-3">{rupee(ctc.specialAllowanceMonthly)}</td>
                      <td className="px-3 py-2.5 text-right font-mono text-amber-700 font-semibold">{rupee(ctc.totalEmployerContributionMonthly)}</td>
                      <td className="px-3 py-2.5 text-right font-mono font-bold text-emerald-700 text-sm">{rupee(ctc.netTakeHomeMonthly)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div className="flex items-center gap-2">
              <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">Month</label>
              <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
                className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
            </div>
            {rows.length > 0 && (
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" icon="download" onClick={exportCsv}>Export CSV (for CA)</Button>
                <Button variant="outline" size="sm" icon="download" onClick={export24Q} title="Salary-TDS deductee working for this month's quarter (section 192)">24Q working (TDS)</Button>
                <Button variant="ghost" size="sm" icon="file" onClick={() => window.print()}>Print</Button>
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
            <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
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
                      {e?.designation && <div className="text-[11px] text-ink-3 mt-0.5">{e.designation}</div>}
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
      <p className="mt-3 text-[11px] text-ink-3">
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
            <Button variant="ghost" size="sm" icon="file" onClick={() => window.print()}>Print</Button>
          </div>
        )}
      </div>

      <Card className="mb-4 p-4">
        <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">Salary register</div>
        <div className="font-serif text-2xl text-ink leading-tight mt-1">{toTitleCase(emp?.name ?? "Employee")}</div>
        <div className="text-[11px] text-ink-3 mt-0.5">
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
            <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
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
