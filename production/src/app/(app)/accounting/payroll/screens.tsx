/**
 * Payroll + Leave.
 *
 * Three tabs — Employees, Run payroll, Leave. Salary is booked as a Salaries
 * expense (earned = gross − LOP); only net pay leaves the bank; advance
 * recovery reduces the employee's loan; withheld TDS/PF/ESI is a liability
 * settled via "Pay statutory dues". All money movement is atomic (RPCs 0087).
 */
"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { FAB } from "@/components/ui/fab";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import { rupee, formatDate, cn, toTitleCase } from "@/lib/utils";
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import { daysElapsedInPeriod, prorateSalary } from "@/lib/payroll/proration";
import { nationalHolidaysForYear, FIXED_NATIONAL_HOLIDAYS, indiaPublicHolidaysForYear } from "@/lib/payroll/holidays-india";
import { computeEsi, isEsiEligible, ESI_WAGE_CEILING } from "@/lib/payroll/esi";
import { computePf, PF_WAGE_CEILING } from "@/lib/payroll/pf";
import { useBankAccounts } from "@/lib/queries/bank";
import { useEmployeeLoans } from "@/lib/queries/employee-loans";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { downloadPayslipPDF } from "@/lib/pdf";
import { periodLabel } from "@/lib/pdf/PayslipPDF";
import { toast } from "sonner";
import {
  useEmployees, useUpsertEmployee, useDeleteEmployee, useSetEmployeePin,
  useLeaveEntries, useCreateLeaveEntry, useDeleteLeaveEntry,
  useHolidays, useCreateHoliday, useDeleteHoliday,
  useSalaryPayments, usePaySalary, useDeleteSalaryPayment, useEmployeeSalaryHistory,
  useStatutoryDues, usePayStatutoryDues,
  useAttendance, useAttendanceNetwork, useSetAttendanceNetwork, getSelfieUrl,
  LEAVE_TYPE_LABEL,
  type Employee, type LeaveKind, type Attendance, type SalaryPayment,
} from "@/lib/queries/payroll";
import { useOwnerSetConsent, useMarkAttendanceReviewed } from "@/lib/queries/my-attendance";
import type { CurrentUserInfo } from "@/lib/hooks/useCurrentUser";
import { EmployeeDetailDrawer } from "@/components/features/payroll/employee-detail-drawer";
import { OfferLetterDialog } from "@/components/features/payroll/offer-letter-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";

function todayISO(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
function currentPeriod(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 7); // YYYY-MM
}
/** Previous month (YYYY-MM) — payroll is usually run for the month just ended. */
function prevPeriod(): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}
function fmtTimeIST(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
}
function fyStartISO(): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const y = d.getUTCMonth() < 3 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
  return `${y}-04-01`;
}

/**
 * Paid-leave days an employee is ENTITLED to in a financial year (Apr 1 → Mar 31),
 * PRORATED for mid-year joiners. Joined on/before the FY start (or no join date)
 * → full stored allowance. Joined during the FY → base × (whole months from their
 * join month through March) / 12, rounded. Joined after the FY → 0. `leave_allowance`
 * stays the full annual entitlement; only the effective FY balance is prorated.
 */
function effectiveLeaveAllowance(
  emp: { leave_allowance: number; joining_date?: string | null },
  fyStart: string = fyStartISO(),
): number {
  const base = emp.leave_allowance ?? 0;
  const jd = emp.joining_date;
  if (!jd || jd <= fyStart) return base;
  const startYear = Number(fyStart.slice(0, 4));
  const [jy, jm] = jd.split("-").map(Number);       // join year, month (1–12)
  const monthsSinceStart = (jy - startYear) * 12 + (jm - 4); // April = 0
  const monthsRemaining = 12 - monthsSinceStart;    // inclusive of the join month
  if (monthsRemaining >= 12) return base;
  if (monthsRemaining <= 0) return 0;
  return Math.round((base * monthsRemaining) / 12);
}

/** How long an employee has been with the company, from their joining date to
 *  today (IST). Returns e.g. "2 yr 3 mo", "5 mo", "<1 mo", or null (no/future
 *  join date). */
function tenureLabel(joiningISO?: string | null): string | null {
  if (!joiningISO) return null;
  const now = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const [jy, jm, jd] = joiningISO.split("-").map(Number);
  if (!jy || !jm || !jd) return null;
  let months = (now.getUTCFullYear() - jy) * 12 + (now.getUTCMonth() + 1 - jm);
  if (now.getUTCDate() < jd) months -= 1;
  if (months < 0) return null;               // joins in the future → no tenure yet
  const y = Math.floor(months / 12), m = months % 12;
  if (y === 0 && m === 0) return "<1 mo";
  if (y === 0) return `${m} mo`;
  if (m === 0) return `${y} yr`;
  return `${y} yr ${m} mo`;
}

/** Muted subline shown under an employee's name: designation + tenure. */
function employeeSubline(e: { designation?: string | null; joining_date?: string | null }): string | null {
  const parts = [e.designation?.trim() || null, tenureLabel(e.joining_date)].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}
const selectCls = "w-full rounded-md border border-hairline bg-paper px-3 py-2 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-amber";

/** Shared page shell for the HR screens (consistent header + width). */
export function HrPageShell({ title, sub, children }: { title: string; sub: string; children: React.ReactNode }) {
  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      <div className="mb-5">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Payroll</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">{title}</h1>
        <p className="text-sm text-ink-3 mt-1">{sub}</p>
      </div>
      {children}
    </div>
  );
}

export function PayrollScreen() {
  const dues = useStatutoryDues();
  const [payDuesOpen, setPayDuesOpen] = React.useState(false);

  return (
    <HrPageShell title="Payroll" sub="Run monthly payroll — salary posts as an expense; only net pay leaves your bank.">
      {/* Statutory dues banner */}
      {(dues.data?.payable ?? 0) > 0 && (
        <Card className="mb-5 p-3 md:p-4 border-amber/40 bg-amber-soft/30">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="text-sm text-ink-2">
              <b className="text-ink">{rupee(dues.data!.payable)}</b> statutory dues withheld (TDS/PF/ESI) — pending payment to govt.
            </div>
            <Button variant="outline" size="sm" onClick={() => setPayDuesOpen(true)}>Record statutory payment</Button>
          </div>
        </Card>
      )}

      <PayrollTab />

      {payDuesOpen && <PayDuesDialog payable={dues.data?.payable ?? 0} onClose={() => setPayDuesOpen(false)} />}
    </HrPageShell>
  );
}

// ── Employees tab ─────────────────────────────────────────────────────────
export function EmployeesTab() {
  const q = useEmployees();
  const leaveQ = useLeaveEntries();
  const del = useDeleteEmployee();
  const confirm = useConfirm();
  const [edit, setEdit] = React.useState<Employee | null | "new">(null);
  const [viewEmp, setViewEmp] = React.useState<Employee | null>(null);
  const [offerEmp, setOfferEmp] = React.useState<Employee | null>(null);
  const rows = q.data ?? [];

  const confirmDelete = async (e: Employee) => {
    if (await confirm({
      title: `Remove ${e.name}?`,
      body: "This deletes the employee and their attendance/leave records. (Blocked if they have salary payments — deactivate those instead.)",
      confirmLabel: "Remove",
      danger: true,
    })) {
      del.mutate(e.id);
    }
  };

  const paidLeaveTaken = (empId: string) => {
    const fy = fyStartISO();
    return (leaveQ.data ?? [])
      .filter((l) => l.employee_id === empId && l.type !== "unpaid" && l.from_date >= fy)
      .reduce((s, l) => s + l.days, 0);
  };

  return (
    <>
      <div className="flex justify-end mb-3">
        <Button variant="primary" icon="plus" onClick={() => setEdit("new")}>Add employee</Button>
      </div>
      {q.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No employees yet" body="Add the people you pay a salary to." action={<Button variant="primary" icon="plus" onClick={() => setEdit("new")}>Add employee</Button>} /></Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-4 py-3 whitespace-nowrap">Employee</th>
                  <th className="text-right px-4 py-3 whitespace-nowrap">Monthly salary</th>
                  <th className="text-left px-4 py-3 whitespace-nowrap">Joined</th>
                  <th className="text-right px-4 py-3 whitespace-nowrap">Paid leave left (FY)</th>
                  <th className="text-left px-4 py-3 whitespace-nowrap">Status</th>
                  <th className="text-right px-4 py-3 whitespace-nowrap">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((e) => {
                  const taken = paidLeaveTaken(e.id);
                  const allowance = effectiveLeaveAllowance(e);
                  const left = Math.max(0, allowance - taken);
                  const prorated = !!e.joining_date && allowance !== e.leave_allowance;
                  const leaveTitle = prorated
                    ? `${left} of ${allowance} paid-leave day(s) left this FY (${taken} used). Prorated from ${e.leave_allowance}/yr — joined mid-year on ${formatDate(e.joining_date!)}.`
                    : `${left} of ${allowance} annual paid-leave day(s) left this financial year (${taken} used). Set the annual allowance in the employee's profile.`;
                  return (
                    <tr
                      key={e.id}
                      className="group cursor-pointer hover:bg-paper-2/40 transition-colors"
                      role="button"
                      tabIndex={0}
                      aria-label={`Open ${toTitleCase(e.name)}'s profile`}
                      onClick={() => setViewEmp(e)}
                      onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setViewEmp(e); } }}
                    >
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink group-hover:text-amber-ink transition-colors">{toTitleCase(e.name)}</div>
                        {employeeSubline(e) && <div className="text-[11px] text-ink-3 mt-0.5">{employeeSubline(e)}</div>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {e.monthly_gross > 0 ? (
                          <span className="font-mono font-semibold tabular-nums text-ink">{rupee(e.monthly_gross)}</span>
                        ) : (
                          <span title="No salary set yet — add it before running payroll.">
                            <Badge kind="warning" size="sm">Salary pending</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-ink-2 whitespace-nowrap">{e.joining_date ? formatDate(e.joining_date) : "—"}</td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums" title={leaveTitle}>
                        <span className={cn(left === 0 && allowance > 0 && "text-amber-ink")}>{left}</span>
                        <span className="text-ink-3"> / {allowance}</span>
                        {prorated && <span className="ml-1 text-[9px] uppercase tracking-wide text-ink-3 font-sans not-italic" title={leaveTitle}>pro-rata</span>}
                      </td>
                      <td className="px-4 py-3"><Badge kind={e.is_active ? "success" : "muted"} dot>{e.is_active ? "Active" : "Inactive"}</Badge></td>
                      <td className="px-4 py-3 text-right" onClick={(ev) => ev.stopPropagation()}>
                        <EmployeeRowMenu e={e} onView={setViewEmp} onOffer={setOfferEmp} onEdit={setEdit} onDelete={confirmDelete} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2">
            {rows.map((e) => {
              const allowance = effectiveLeaveAllowance(e);
              const left = Math.max(0, allowance - paidLeaveTaken(e.id));
              const prorated = !!e.joining_date && allowance !== e.leave_allowance;
              return (
                <li key={e.id}>
                  <Card
                    className="p-4 cursor-pointer hover:bg-paper-2/40 transition-colors"
                    role="button"
                    tabIndex={0}
                    aria-label={`Open ${toTitleCase(e.name)}'s profile`}
                    onClick={() => setViewEmp(e)}
                    onKeyDown={(ev) => { if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); setViewEmp(e); } }}
                  >
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <div className="min-w-0">
                        <div className="font-medium text-ink leading-tight">{toTitleCase(e.name)}</div>
                        {employeeSubline(e) && <div className="text-[11px] text-ink-3 mt-0.5">{employeeSubline(e)}</div>}
                      </div>
                      {e.monthly_gross > 0 ? (
                        <div className="font-serif text-xl leading-none text-ink shrink-0">{rupee(e.monthly_gross)}</div>
                      ) : (
                        <Badge kind="warning" size="sm">Salary pending</Badge>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-3 mb-2">
                      {e.joining_date ? `Joined ${formatDate(e.joining_date)}` : "Not joined yet"} · Paid leave {left}/{allowance}{prorated ? " (pro-rata)" : ""}
                    </div>
                    <div className="flex items-center justify-between gap-2" onClick={(ev) => ev.stopPropagation()}>
                      <Badge kind={e.is_active ? "success" : "muted"} dot>{e.is_active ? "Active" : "Inactive"}</Badge>
                      <EmployeeRowMenu e={e} onView={setViewEmp} onOffer={setOfferEmp} onEdit={setEdit} onDelete={confirmDelete} />
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
      <FAB icon="plus" label="Add employee" onClick={() => setEdit("new")} ariaLabel="Add employee" />
      {edit !== null && <EmployeeDialog employee={edit === "new" ? null : edit} onClose={() => setEdit(null)} />}
      {offerEmp && <OfferLetterDialog employee={offerEmp} onClose={() => setOfferEmp(null)} />}
      <EmployeeDetailDrawer
        employee={viewEmp ? (rows.find((r) => r.id === viewEmp.id) ?? viewEmp) : null}
        open={viewEmp !== null}
        onOpenChange={(o) => { if (!o) setViewEmp(null); }}
        onEdit={() => { if (viewEmp) { setEdit(viewEmp); setViewEmp(null); } }}
      />
    </>
  );
}

/** Row overflow menu — one clean "…" control replacing crowded inline buttons. */
function EmployeeRowMenu({ e, onView, onOffer, onEdit, onDelete }: {
  e: Employee;
  onView: (e: Employee) => void;
  onOffer: (e: Employee) => void;
  onEdit: (e: Employee) => void;
  onDelete: (e: Employee) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={`Actions for ${toTitleCase(e.name)}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2"
        >
          <Icon name="more_h" size={18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => onView(e)}>
          <Icon name="eye" size={15} /> Open profile
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => onOffer(e)}>
          <Icon name="file" size={15} /> Generate offer letter
        </DropdownMenuItem>
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => onEdit(e)}>
          <Icon name="edit" size={15} /> Edit profile &amp; salary
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={() => onDelete(e)}>
          <Icon name="trash" size={15} /> Delete employee
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Compact labelled field wrapper for the employee form. */
function Field({ label, required, children }: { label: React.ReactNode; required?: boolean; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <label className="block text-xs font-medium text-ink-2 mb-1">
        {label}{required && <span className="text-rose"> *</span>}
      </label>
      {children}
    </div>
  );
}

function EmployeeDialog({ employee, onClose }: { employee: Employee | null; onClose: () => void }) {
  const save = useUpsertEmployee();
  const setPin = useSetEmployeePin();
  const [name, setName] = React.useState(employee?.name ?? "");
  const [gross, setGross] = React.useState(String(employee?.monthly_gross ?? ""));
  const [joined, setJoined] = React.useState(employee?.joining_date ?? "");
  const [allowance, setAllowance] = React.useState(String(employee?.leave_allowance ?? 18));
  const [active, setActive] = React.useState(employee?.is_active ?? true);
  const [pin, setPinValue] = React.useState("");
  const [email, setEmail] = React.useState(employee?.email ?? "");
  const [phone, setPhone] = React.useState(employee?.phone ?? "");
  const [designation, setDesignation] = React.useState(employee?.designation ?? "");
  const [dob, setDob] = React.useState(employee?.date_of_birth ?? "");
  const [address, setAddress] = React.useState(employee?.address ?? "");
  const [ecName, setEcName] = React.useState(employee?.emergency_contact_name ?? "");
  const [ecPhone, setEcPhone] = React.useState(employee?.emergency_contact_phone ?? "");
  const [pan, setPan] = React.useState(employee?.pan ?? "");
  const [pfNo, setPfNo] = React.useState(employee?.pf_no ?? "");
  const [esiNo, setEsiNo] = React.useState(employee?.esi_no ?? "");
  const [esiApplicable, setEsiApplicable] = React.useState<boolean>(employee?.esi_applicable ?? false);
  const [esiTouched, setEsiTouched] = React.useState(false);
  const [pfApplicable, setPfApplicable] = React.useState<boolean>(employee?.pf_applicable ?? false);
  // For a NEW employee, suggest ESI coverage from the wage ceiling until the
  // user decides for themselves. Existing employees keep their saved value.
  React.useEffect(() => {
    if (!esiTouched && !employee) setEsiApplicable(isEsiEligible(Math.round(Number(gross) || 0)));
  }, [gross, esiTouched, employee]);

  const pinValid = pin === "" || /^[0-9]{4,6}$/.test(pin);

  async function submit() {
    if (!name.trim() || !pinValid) return;
    const id = await save.mutateAsync({
      id: employee?.id, name: name.trim(), monthly_gross: Math.round(Number(gross) || 0),
      joining_date: joined || null, leave_allowance: Math.round(Number(allowance) || 0), is_active: active,
      email: email.trim() || null, phone: phone.trim() || null, designation: designation.trim() || null,
      date_of_birth: dob || null, address: address.trim() || null,
      emergency_contact_name: ecName.trim() || null, emergency_contact_phone: ecPhone.trim() || null,
      pan: pan.trim().toUpperCase() || null, pf_no: pfNo.trim() || null, esi_no: esiNo.trim() || null,
      esi_applicable: esiApplicable, pf_applicable: pfApplicable,
    });
    if (pin && id) await setPin.mutateAsync({ employeeId: id, pin });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-2xl">
        <DialogHeader>
          <DialogTitle>{employee ? "Edit employee" : "Add employee"}</DialogTitle>
          <DialogDescription>
            {employee ? `Update ${employee.name}'s profile, payroll & contact details.` : "Add a person you pay a salary to — you can fill only the basics now and the rest later."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Basics */}
          <section className="space-y-3">
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Basics</p>
            <Field label="Full name" required>
              <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus placeholder="e.g. Abhishek Sharma" />
            </Field>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Designation">
                <Input value={designation} onChange={(e) => setDesignation(e.target.value)} placeholder="e.g. Sales Executive" />
              </Field>
              <Field label="Date of birth">
                <Input type="date" value={dob} onChange={(e) => setDob(e.target.value)} />
              </Field>
              <Field label="Mobile">
                <Input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="e.g. +91 98765 43210" />
              </Field>
              <Field label="Email">
                <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="e.g. name@company.com" />
              </Field>
            </div>
            <Field label="Address">
              <Input value={address} onChange={(e) => setAddress(e.target.value)} placeholder="Residential address" />
            </Field>
          </section>

          {/* Payroll & statutory */}
          <section className="space-y-3 border-t border-hairline pt-4">
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Payroll &amp; statutory</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Monthly salary (₹, gross)">
                <Input type="number" min={0} value={gross} onChange={(e) => setGross(e.target.value)} />
              </Field>
              <Field label="Paid leave / year">
                <Input type="number" min={0} value={allowance} onChange={(e) => setAllowance(e.target.value)} />
              </Field>
              <Field label="Joining date">
                <Input type="date" value={joined} onChange={(e) => setJoined(e.target.value)} />
              </Field>
              <Field label="PAN">
                <Input value={pan} onChange={(e) => setPan(e.target.value)} placeholder="e.g. ABCDE1234F" className="uppercase" maxLength={10} />
              </Field>
              <Field label="PF number">
                <Input value={pfNo} onChange={(e) => setPfNo(e.target.value)} placeholder="Optional" />
              </Field>
              <Field label="ESI number">
                <Input value={esiNo} onChange={(e) => setEsiNo(e.target.value)} placeholder="Optional" />
              </Field>
            </div>
            <label className="flex items-start gap-2 rounded-md border border-hairline p-3 cursor-pointer hover:border-hairline-strong">
              <input
                type="checkbox"
                checked={esiApplicable}
                onChange={(e) => { setEsiTouched(true); setEsiApplicable(e.target.checked); }}
                className="mt-0.5 rounded border-hairline"
              />
              <span className="text-xs text-ink-2">
                <b className="text-ink">ESI applicable</b> — deduct 0.75% from salary + accrue 3.25% employer share each month.
                <span className="block text-ink-3 mt-0.5">Auto-suggested for gross ≤ ₹{ESI_WAGE_CEILING.toLocaleString("en-IN")}/month. Uncheck if this employee is exempt.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 rounded-md border border-hairline p-3 cursor-pointer hover:border-hairline-strong">
              <input
                type="checkbox"
                checked={pfApplicable}
                onChange={(e) => setPfApplicable(e.target.checked)}
                className="mt-0.5 rounded border-hairline"
              />
              <span className="text-xs text-ink-2">
                <b className="text-ink">PF applicable</b> — deduct 12% from salary + accrue 12% employer share each month.
                <span className="block text-ink-3 mt-0.5">Computed on wage capped at ₹{PF_WAGE_CEILING.toLocaleString("en-IN")}. Tick for employees with an EPFO account.</span>
              </span>
            </label>
          </section>

          {/* Emergency & access */}
          <section className="space-y-3 border-t border-hairline pt-4">
            <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Emergency &amp; access</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field label="Emergency contact">
                <Input value={ecName} onChange={(e) => setEcName(e.target.value)} placeholder="Name" />
              </Field>
              <Field label="Emergency phone">
                <Input inputMode="tel" value={ecPhone} onChange={(e) => setEcPhone(e.target.value)} placeholder="+91 …" />
              </Field>
            </div>
            <Field label={<>Attendance PIN {employee?.pin_hash ? <span className="text-emerald font-normal">· already set</span> : ""}</>}>
              <Input inputMode="numeric" value={pin} onChange={(e) => setPinValue(e.target.value.replace(/\D/g, ""))}
                placeholder={employee?.pin_hash ? "Enter new 4–6 digits to reset" : "Set a 4–6 digit PIN"} maxLength={6} />
              {!pinValid
                ? <p className="mt-1 text-[11px] text-rose">PIN must be 4–6 digits.</p>
                : <p className="mt-1 text-[11px] text-ink-3">Used at the attendance kiosk to check in / out.</p>}
            </Field>
            <label className="flex items-center gap-2 text-sm text-ink-2">
              <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} className="w-4 h-4 accent-amber" />
              Active employee
            </label>
          </section>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={save.isPending || setPin.isPending}>Cancel</Button>
          <Button variant="primary" loading={save.isPending || setPin.isPending} disabled={!name.trim() || !pinValid} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Payroll tab ─────────────────────────────────────────────────────────────
export function PayrollTab() {
  const router = useRouter();
  const [period, setPeriod] = React.useState(prevPeriod());
  const empQ = useEmployees();
  const payQ = useSalaryPayments(period);
  const meQ = useCurrentUser();
  const accountsQ = useBankAccounts();
  const [payFor, setPayFor] = React.useState<Employee | null>(null);
  const [editFor, setEditFor] = React.useState<Employee | null>(null);
  const [calendarFor, setCalendarFor] = React.useState<Employee | null>(null);
  const [attendanceEmp, setAttendanceEmp] = React.useState<Employee | null>(null);
  const undoSalary = useDeleteSalaryPayment();
  const confirm = useConfirm();

  // "Reconcile in Banking" — jump to the bank account with the matching bank
  // debit (= net salary) opened for reconcile. If there's a single bank (non-
  // cash) account we deep-link to it with ?match=<net>; else the Banking list.
  const reconcileSalary = (p: SalaryPayment) => {
    const banks = (accountsQ.data ?? []).filter((a) => a.is_active && a.account_type !== "cash");
    if (banks.length === 1) router.push(`/accounting/banking/${banks[0].id}?match=${p.net}` as never);
    else router.push("/accounting/banking" as never);
  };

  // Edit an UN-reconciled run: reverse it (tested delete_salary_payment RPC —
  // itself blocked server-side once reconciled) then reopen the pay form to
  // re-enter it. Only offered while paid_amount === 0 (not yet bank-matched).
  const editSalary = async (e: Employee, p: SalaryPayment) => {
    if (await confirm({
      title: `Edit ${e.name}'s salary for this month?`,
      body: "This reverses the current run (and its booked expense) and reopens the pay form so you can correct it. Only possible before it's reconciled to a bank line.",
      confirmLabel: "Edit",
    })) {
      try { await undoSalary.mutateAsync(p.id); setPayFor(e); }
      catch { /* the mutation surfaces its own error toast */ }
    }
  };
  const undoSalaryFor = async (e: Employee, p: SalaryPayment) => {
    if (await confirm({
      title: `Undo ${e.name}'s salary for this month?`,
      body: "This removes the salary + its booked expense so you can pay it again. (Blocked once it's reconciled to a bank line — un-reconcile that first.)",
      confirmLabel: "Undo",
      danger: true,
    })) {
      undoSalary.mutate(p.id);
    }
  };

  const attQ = useAttendance(period);
  const holQ = useHolidays();

  const employees = (empQ.data ?? []).filter((e) => e.is_active);
  const paidByEmp = new Map((payQ.data ?? []).map((p) => [p.employee_id, p]));
  const totalNet = (payQ.data ?? []).reduce((s, p) => s + p.net, 0);
  const acctName = new Map((accountsQ.data ?? []).map((a) => [a.id, a.name]));
  // Summary: full monthly cost (all active gross) vs what's actually been run.
  const estimatedMonthly = employees.reduce((s, e) => s + e.monthly_gross, 0);
  const runCount = employees.filter((e) => paidByEmp.has(e.id)).length;

  // Attendance this month: days present (distinct check-ins) vs working days so
  // far (Sundays + company holidays excluded; from the join date if mid-month).
  // Same basis payroll uses for loss-of-pay — so it reads consistently.
  const attendanceFor = React.useMemo(() => {
    const [yy, mm] = period.split("-").map(Number);
    const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
    const monthEnd = new Date(Date.UTC(yy, mm, 0));
    const todayUTC = new Date(todayISO() + "T00:00:00Z");
    const rangeEnd = todayUTC < monthEnd ? todayUTC : monthEnd;
    const holidaySet = new Set((holQ.data ?? []).map((h) => h.holiday_date));
    nationalHolidaysForYear(yy).forEach((d) => holidaySet.add(d));
    const presentByEmp = new Map<string, Set<string>>();
    for (const a of attQ.data ?? []) {
      if (!a.check_in) continue;
      (presentByEmp.get(a.employee_id) ?? presentByEmp.set(a.employee_id, new Set()).get(a.employee_id)!).add(a.work_date);
    }
    return (e: Employee): { present: number; expected: number } => {
      const rangeStart = e.joining_date && e.joining_date > `${period}-01`
        ? new Date(e.joining_date + "T00:00:00Z") : monthStart;
      let expected = 0;
      for (const d = new Date(rangeStart); d <= rangeEnd; d.setUTCDate(d.getUTCDate() + 1)) {
        const iso = d.toISOString().slice(0, 10);
        if (d.getUTCDay() !== 0 && !holidaySet.has(iso)) expected++;
      }
      return { present: presentByEmp.get(e.id)?.size ?? 0, expected };
    };
  }, [period, attQ.data, holQ.data]);

  return (
    <>
      {/* Summary — full monthly cost vs what's been run this month */}
      <Card className="mb-4 p-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Estimated monthly cost</div>
            <div className="font-serif text-2xl text-ink leading-tight mt-1">{rupee(estimatedMonthly)}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">All {employees.length} active employees&apos; gross</div>
          </div>
          <div>
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Run this month (net)</div>
            <div className="font-serif text-2xl text-ink leading-tight mt-1">{rupee(totalNet)}</div>
            <div className="text-[11px] text-ink-3 mt-0.5">{runCount} of {employees.length} paid</div>
          </div>
          <div className="col-span-2 sm:col-span-1">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Still to run</div>
            <div className={cn("font-serif text-2xl leading-tight mt-1", employees.length - runCount > 0 ? "text-amber-ink" : "text-emerald")}>
              {employees.length - runCount}
            </div>
            <div className="text-[11px] text-ink-3 mt-0.5">{employees.length - runCount > 0 ? "employees pending" : "everyone paid 🎉"}</div>
          </div>
        </div>
      </Card>

      <Card className="mb-4 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">Month</label>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
          <Button
            variant="outline" size="sm" icon="rupee" className="ml-auto"
            title="Give an advance against salary — tracked as owed back and auto-recovered from a future payslip"
            onClick={() => router.push("/accounting/loans?give=salary_advance" as never)}
          >
            Give salary advance
          </Button>
        </div>
      </Card>

      {empQ.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : employees.length === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No active employees" body="Add employees first, then run payroll." /></Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card flush className="hidden md:block">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-4 py-3">Employee</th>
                  <th className="text-right px-4 py-3">Monthly salary</th>
                  <th className="text-right px-4 py-3">Net</th>
                  <th className="text-right px-4 py-3 whitespace-nowrap">Present (mo)</th>
                  <th className="text-right px-4 py-3">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {employees.map((e) => {
                  const p = paidByEmp.get(e.id);
                  return (
                    <tr key={e.id} className="hover:bg-paper-2/40">
                      <td className="px-4 py-3">
                        <div className="font-medium text-ink">{toTitleCase(e.name)}</div>
                        {employeeSubline(e) && <div className="text-[11px] text-ink-3 mt-0.5">{employeeSubline(e)}</div>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-ink-2">
                        {p ? rupee(p.gross) : e.monthly_gross > 0 ? rupee(e.monthly_gross) : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right font-mono">
                        {p ? (() => {
                          const a = attendanceFor(e);
                          const noLopButLowPresent = p.lop_days === 0 && a.expected > 0 && a.present < a.expected;
                          return (
                            <>
                              <div>{rupee(p.net)}</div>
                              {p.lop_days > 0 ? (
                                <div className="text-[10px] font-sans text-ink-3 mt-0.5" title={`${p.lop_days} day(s) of loss-of-pay deducted from gross for absences.`}>
                                  {p.lop_days}d LOP deducted
                                </div>
                              ) : noLopButLowPresent ? (
                                <div className="text-[10px] font-sans text-amber-ink mt-0.5"
                                  title={`Paid for all working days — no loss-of-pay deducted, though attendance shows only ${a.present}/${a.expected} present. Likely attendance wasn't marked at the kiosk, they were on paid leave, or treated as present. To dock absent days: ⋯ → Edit salary → apply LOP.`}>
                                  Full pay · no LOP
                                </div>
                              ) : null}
                            </>
                          );
                        })() : <span className="text-ink-3">—</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        {(() => {
                          const a = attendanceFor(e);
                          return (
                            <button
                              type="button"
                              onClick={() => setAttendanceEmp(e)}
                              className="font-mono tabular-nums hover:text-amber-ink hover:underline"
                              title={`${a.present} present of ${a.expected} working day(s) this month (Sundays + holidays excluded). Click to open the attendance register.`}
                            >
                              <span className={cn(a.expected > 0 && a.present < a.expected && "text-amber-ink")}>{a.present}</span>
                              <span className="text-ink-3"> / {a.expected}</span>
                            </button>
                          );
                        })()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-end gap-2">
                          {p ? (
                            <>
                              {p.paid_status === "paid" ? (
                                <Badge kind="success" dot>Paid</Badge>
                              ) : p.paid_status === "partial" ? (
                                <Badge kind="warning" dot title={`Partly paid — ${rupee(p.net - p.paid_amount)} still owed. Reconcile another bank line to clear the balance.`}>
                                  Partial · {rupee(p.paid_amount)}/{rupee(p.net)}
                                </Badge>
                              ) : (
                                <Badge kind="warning" dot title="Payroll run — awaiting the bank debit to be reconciled">Awaiting reconcile</Badge>
                              )}
                              <PayrollRowMenu
                                e={e} p={p} me={meQ.data ?? null}
                                paidVia={p.bank_account_id ? acctName.get(p.bank_account_id) ?? null : null}
                                onYear={() => setCalendarFor(e)} onEdit={() => editSalary(e, p)} onUndo={() => undoSalaryFor(e, p)}
                                onReconcile={() => reconcileSalary(p)}
                              />
                            </>
                          ) : (
                            <>
                              {e.monthly_gross > 0 ? (
                                <Button variant="primary" size="sm" onClick={() => setPayFor(e)}>Pay salary</Button>
                              ) : (
                                <Button variant="primary" size="sm" onClick={() => setEditFor(e)} title="Set this employee's monthly salary, then run payroll.">Set salary</Button>
                              )}
                              <PayrollRowMenu
                                e={e} me={meQ.data ?? null} paidVia={null}
                                onYear={() => setCalendarFor(e)} onEdit={() => {}} onUndo={() => {}}
                              />
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2">
            {employees.map((e) => {
              const p = paidByEmp.get(e.id);
              return (
                <li key={e.id}>
                  <Card className="p-4">
                    <div className="flex items-start justify-between gap-2 mb-1">
                      <button
                        type="button"
                        onClick={() => setCalendarFor(e)}
                        className="min-w-0 text-left"
                        title={`See ${e.name}'s full-year payroll`}
                      >
                        <div className="font-medium text-ink leading-tight hover:text-amber-ink">{toTitleCase(e.name)}</div>
                        {employeeSubline(e) && <div className="text-[11px] text-ink-3 mt-0.5">{employeeSubline(e)}</div>}
                      </button>
                      <div className="font-serif text-xl leading-none shrink-0 text-ink">
                        {p ? rupee(p.net) : e.monthly_gross > 0 ? rupee(e.monthly_gross) : <span className="text-ink-3">—</span>}
                      </div>
                    </div>
                    <div className="text-[11px] text-ink-3 mb-2">
                      {p ? `Net pay · gross ${rupee(p.gross)}` : `Monthly salary · not run yet`}
                      {(() => {
                        const a = attendanceFor(e);
                        const reason = p ? (p.lop_days > 0 ? ` · ${p.lop_days}d LOP` : (a.expected > 0 && a.present < a.expected ? " · full pay, no LOP" : "")) : "";
                        return ` · Present ${a.present}/${a.expected}${reason}`;
                      })()}
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      {p ? (
                        <>
                          {p.paid_status === "paid" ? (
                            <Badge kind="success" dot>Paid</Badge>
                          ) : p.paid_status === "partial" ? (
                            <Badge kind="warning" dot title={`Partly paid — ${rupee(p.net - p.paid_amount)} still owed. Reconcile another bank line to clear the balance.`}>
                              Partial · {rupee(p.paid_amount)}/{rupee(p.net)}
                            </Badge>
                          ) : (
                            <Badge kind="warning" dot title="Payroll run — awaiting the bank debit to be reconciled">Awaiting reconcile</Badge>
                          )}
                          <PayrollRowMenu
                            e={e} p={p} me={meQ.data ?? null}
                            paidVia={p.bank_account_id ? acctName.get(p.bank_account_id) ?? null : null}
                            onYear={() => setCalendarFor(e)} onEdit={() => editSalary(e, p)} onUndo={() => undoSalaryFor(e, p)}
                            onReconcile={() => reconcileSalary(p)}
                          />
                        </>
                      ) : (
                        <div className="flex items-center gap-2">
                          {e.monthly_gross > 0 ? (
                            <Button variant="primary" size="sm" onClick={() => setPayFor(e)}>Pay salary</Button>
                          ) : (
                            <Button variant="primary" size="sm" onClick={() => setEditFor(e)} title="Set this employee's monthly salary, then run payroll.">Set salary</Button>
                          )}
                          <PayrollRowMenu
                            e={e} me={meQ.data ?? null} paidVia={null}
                            onYear={() => setCalendarFor(e)} onEdit={() => {}} onUndo={() => {}}
                          />
                        </div>
                      )}
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {payFor && <PaySalaryDialog employee={payFor} period={period} onClose={() => setPayFor(null)} />}
      {editFor && <EmployeeDialog employee={editFor} onClose={() => setEditFor(null)} />}
      {attendanceEmp && <AttendanceRegisterDialog employee={attendanceEmp} initialPeriod={period} onClose={() => setAttendanceEmp(null)} />}
      {calendarFor && (
        <EmployeePayrollYearDialog
          employee={calendarFor}
          anchorPeriod={period}
          onClose={() => setCalendarFor(null)}
          onPickMonth={(mp) => { setPeriod(mp); setCalendarFor(null); }}
        />
      )}
    </>
  );
}

/** Full-year (Indian FY, Apr→Mar) payroll for ONE employee — opened by clicking
 *  their name. Shows every month's salary + status + running total, and lets the
 *  operator jump to any month to pay / undo / view it. */
function EmployeePayrollYearDialog({
  employee, anchorPeriod, onClose, onPickMonth,
}: {
  employee: Employee;
  anchorPeriod: string;               // "YYYY-MM" currently selected on the page
  onClose: () => void;
  onPickMonth: (period: string) => void;
}) {
  const { data: history, isLoading } = useEmployeeSalaryHistory(employee.id);

  // Indian FY containing the anchor month (Apr→Mar).
  const [ay, am] = anchorPeriod.split("-").map(Number);
  const fyStart = am >= 4 ? ay : ay - 1;
  const months = Array.from({ length: 12 }, (_, i) => {
    const abs = 4 + i;                                   // 4..15
    const year = abs <= 12 ? fyStart : fyStart + 1;
    const month = ((abs - 1) % 12) + 1;                  // 4..12,1,2,3
    return { period: `${year}-${String(month).padStart(2, "0")}`, year, month };
  });
  const byPeriod = new Map((history ?? []).map((p) => [p.period, p]));

  const totalEarned = (history ?? [])
    .filter((p) => months.some((m) => m.period === p.period))
    .reduce((s, p) => s + p.net, 0);
  const totalCleared = (history ?? [])
    .filter((p) => months.some((m) => m.period === p.period))
    .reduce((s, p) => s + p.paid_amount, 0);
  const runCount = months.filter((m) => byPeriod.has(m.period)).length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-lg">
        <DialogHeader>
          <DialogTitle>{employee.name} — payroll FY {fyStart}–{String(fyStart + 1).slice(-2)}</DialogTitle>
          <DialogDescription>
            Salary month by month (Apr–Mar). Tap a month to open it and pay / undo / view.
          </DialogDescription>
        </DialogHeader>

        {isLoading ? (
          <div className="space-y-2">{[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
        ) : (
          <>
            <div className="rounded-md border border-hairline overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                  <tr>
                    <th className="text-left px-3 py-2">Month</th>
                    <th className="text-right px-3 py-2">Net pay</th>
                    <th className="text-right px-3 py-2">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-hairline">
                  {months.map((m) => {
                    const p = byPeriod.get(m.period);
                    const label = new Date(m.year, m.month - 1, 1)
                      .toLocaleDateString("en-IN", { month: "short", year: "numeric" });
                    return (
                      <tr key={m.period} className="hover:bg-paper-2/40">
                        <td className="px-3 py-2">
                          <button
                            type="button"
                            onClick={() => onPickMonth(m.period)}
                            className="text-ink hover:text-amber-ink hover:underline"
                          >
                            {label}
                          </button>
                        </td>
                        <td className="px-3 py-2 text-right font-mono">
                          {p ? rupee(p.net) : <span className="text-ink-3">—</span>}
                          {p && p.paid_status === "partial" && (
                            <span className="block text-[10px] text-ink-3">paid {rupee(p.paid_amount)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          {!p ? (
                            <span className="text-[11px] text-ink-3">Not run</span>
                          ) : p.paid_status === "paid" ? (
                            <Badge kind="success" size="sm" dot>Paid</Badge>
                          ) : p.paid_status === "partial" ? (
                            <Badge kind="warning" size="sm" dot>Partial</Badge>
                          ) : (
                            <Badge kind="warning" size="sm" dot>Unpaid</Badge>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="mt-3 grid grid-cols-3 gap-2 text-center">
              <div className="rounded-md border border-hairline bg-paper-2/30 py-2">
                <div className="text-[10px] uppercase tracking-wider text-ink-3">Months run</div>
                <div className="font-serif text-lg text-ink">{runCount}/12</div>
              </div>
              <div className="rounded-md border border-hairline bg-paper-2/30 py-2">
                <div className="text-[10px] uppercase tracking-wider text-ink-3">Year net</div>
                <div className="font-serif text-lg text-ink">{rupee(totalEarned)}</div>
              </div>
              <div className="rounded-md border border-hairline bg-paper-2/30 py-2">
                <div className="text-[10px] uppercase tracking-wider text-ink-3">Cleared</div>
                <div className="font-serif text-lg text-emerald">{rupee(totalCleared)}</div>
              </div>
            </div>
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="default" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Download this month's payslip as a PDF the owner can share on WhatsApp/email. */
/** Build + download a salary slip PDF (used from the payroll row menu). */
async function generatePayslip(employee: Employee, payment: SalaryPayment, me: CurrentUserInfo | null, paidVia: string | null) {
  try {
    const safeName = employee.name.replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "");
    await downloadPayslipPDF(
      {
        company: {
          name:    me?.tenantName ?? "Company",
          address: me?.tenantAddress ?? null,
          email:   me?.tenantEmail ?? null,
          phone:   me?.tenantPhone ?? null,
          gstin:   me?.tenantGstin ?? null,
        },
        employee: { name: employee.name, pan: employee.pan, pfNo: employee.pf_no, esiNo: employee.esi_no },
        period:           payment.period,
        payDate:          payment.pay_date,
        paidVia,
        gross:            payment.gross,
        lopDays:          payment.lop_days,
        lopAmount:        payment.lop_amount,
        incentive:        payment.incentive,
        advanceRecovered: payment.advance_recovered,
        tds:              payment.tds,
        pf:               payment.pf,
        esi:              payment.esi,
        other:            payment.other_deduction,
        net:              payment.net,
      },
      `Payslip-${safeName}-${periodLabel(payment.period).replace(" ", "-")}.pdf`,
    );
  } catch (err) {
    toast.error((err as Error).message || "Could not build the payslip");
  }
}

/** One "…" menu per payroll row — full-year payroll, payslip, edit/undo (or a
 *  reconciled lock). `p` undefined → row not yet run. */
function PayrollRowMenu({ e, p, me, paidVia, onYear, onEdit, onUndo, onReconcile }: {
  e: Employee; p?: SalaryPayment; me: CurrentUserInfo | null; paidVia: string | null;
  onYear: () => void; onEdit: () => void; onUndo: () => void; onReconcile?: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label={`More actions for ${toTitleCase(e.name)}`}
          className="inline-flex h-8 w-8 items-center justify-center rounded-lg text-ink-3 hover:bg-paper-2 hover:text-ink data-[state=open]:bg-paper-2">
          <Icon name="more_h" size={18} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[13rem]">
        <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onYear}>
          <Icon name="calendar" size={15} /> Full-year payroll
        </DropdownMenuItem>
        {p && (
          <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={() => { void generatePayslip(e, p, me, paidVia); }}>
            <Icon name="download" size={15} /> Download payslip
          </DropdownMenuItem>
        )}
        {p && p.paid_amount === 0 && (
          <>
            <DropdownMenuSeparator />
            {/* Salary is booked but the bank debit isn't matched yet — jump to
                Banking with the matching unmatched line opened for reconcile. */}
            {onReconcile && (
              <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onReconcile}>
                <Icon name="refresh" size={15} /> Reconcile in Banking →
              </DropdownMenuItem>
            )}
            <DropdownMenuItem className="gap-2.5 py-2 cursor-pointer" onClick={onEdit}>
              <Icon name="edit" size={15} /> Edit salary
            </DropdownMenuItem>
            <DropdownMenuItem destructive className="gap-2.5 py-2 cursor-pointer" onClick={onUndo}>
              <Icon name="trash" size={15} /> Undo salary
            </DropdownMenuItem>
          </>
        )}
        {p && p.paid_amount > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled className="gap-2.5 py-2 text-ink-3">
              <Icon name="lock" size={15} /> Reconciled — un-reconcile to edit
            </DropdownMenuItem>
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PaySalaryDialog({ employee, period, onClose }: { employee: Employee; period: string; onClose: () => void }) {
  const accountsQ = useBankAccounts();
  const loansQ = useEmployeeLoans();
  const attQ = useAttendance(period);
  const leaveQ = useLeaveEntries();
  const holQ = useHolidays();
  const pay = usePaySalary();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active);

  // Active advances for this employee (matched by name).
  const advances = (loansQ.data ?? []).filter(
    (l) => l.status === "active" && l.outstanding > 0 && l.employee_name.trim().toLowerCase() === employee.name.trim().toLowerCase(),
  );

  // Don't auto-pay days that haven't happened yet: for a not-yet-complete month
  // the salary defaults to only the days elapsed so far (owner can pay full).
  const payPeriod = daysElapsedInPeriod(period, todayISO());
  const proratedDefault = prorateSalary(employee.monthly_gross, payPeriod.elapsed, payPeriod.daysInMonth);
  const [gross, setGross]   = React.useState(String(payPeriod.complete ? employee.monthly_gross : proratedDefault));
  const [bonus, setBonus]   = React.useState("0");
  const [lopDays, setLopDays] = React.useState("0");
  const [lopAmt, setLopAmt]   = React.useState("0");
  const [advId, setAdvId]     = React.useState("");
  const [advAmt, setAdvAmt]   = React.useState("0");
  const [tds, setTds]         = React.useState("0");
  const [pf, setPf]           = React.useState("0");
  const [pfEdited, setPfEdited] = React.useState(false);
  const [esi, setEsi]         = React.useState("0");
  const [esiEdited, setEsiEdited] = React.useState(false);
  const [other, setOther]     = React.useState("0");
  const [accountId, setAccountId] = React.useState("");
  const [date, setDate]       = React.useState(todayISO());

  // Default to the main bank account (current/savings), not Petty Cash — salary
  // normally goes out of the company bank.
  React.useEffect(() => {
    if (!accountId && accounts.length > 0) {
      const bank = accounts.find((a) => a.account_type !== "cash" && a.account_type !== "credit_card");
      setAccountId((bank ?? accounts[0]).id);
    }
  }, [accounts, accountId]);
  React.useEffect(() => { if (!advId && advances.length > 0) setAdvId(advances[0].id); }, [advances, advId]);

  const n = (s: string) => Math.max(0, Math.round(Number(s) || 0));
  const grossN = n(gross), bonusN = n(bonus), lopN = n(lopAmt), advN = n(advAmt), tdsN = n(tds), pfN = n(pf), esiN = n(esi), otherN = n(other);
  const earned = Math.max(0, grossN - lopN) + bonusN;
  const net = earned - advN - tdsN - pfN - esiN - otherN;

  // ── ESI (auto) — employee 0.75% (deducted from net) + employer 3.25% (extra
  //    company cost, NOT deducted). Base = monthly wage (gross − LOP), bonus
  //    excluded. Coverage comes from the employee's esi_applicable flag.
  const esiWage = Math.max(0, grossN - lopN);
  const esiCalc = computeEsi(esiWage, employee.esi_applicable);
  React.useEffect(() => {
    if (!esiEdited) setEsi(String(esiCalc.employee));
  }, [esiCalc.employee, esiEdited]);
  const esiEmployerN = esiCalc.employer;

  // ── PF (auto) — employee 12% (deducted from net) + employer 12% (extra company
  //    cost, NOT deducted). Computed on the wage capped at ₹15,000.
  const pfCalc = computePf(esiWage, employee.pf_applicable);
  React.useEffect(() => {
    if (!pfEdited) setPf(String(pfCalc.employee));
  }, [pfCalc.employee, pfEdited]);
  const pfEmployerN = pfCalc.employer;

  const selectedAdv = advances.find((a) => a.id === advId);
  const advTooMuch = advN > 0 && selectedAdv ? advN > selectedAdv.outstanding : false;
  const valid = grossN > 0 && net >= 0 && Boolean(accountId) && !advTooMuch && (advN === 0 || Boolean(advId));

  // Auto-fill LOP amount from days. A day is valued at monthly ÷ actual days in
  // the month, so full attendance reconciles to exactly the full salary and
  // Sundays/holidays (never counted as LOP days) stay paid at the right value.
  function onLopDays(v: string) {
    setLopDays(v);
    const d = Number(v) || 0;
    setLopAmt(String(Math.round((employee.monthly_gross / payPeriod.daysInMonth) * d)));
  }

  // Suggested LOP from attendance + unpaid leave. Non-working days (Sunday
  // weekly-off AND company holidays) are excluded from "expected", so an absence
  // on a holiday is never docked as loss-of-pay.
  const lopSuggestion = React.useMemo(() => {
    const [yy, mm] = period.split("-").map(Number);
    const monthStart = new Date(Date.UTC(yy, mm - 1, 1));
    const monthEnd = new Date(Date.UTC(yy, mm, 0));
    const todayUTC = new Date(todayISO() + "T00:00:00Z");
    const rangeEnd = todayUTC < monthEnd ? todayUTC : monthEnd;
    const rangeStart = employee.joining_date && employee.joining_date > `${period}-01`
      ? new Date(employee.joining_date + "T00:00:00Z") : monthStart;
    // Company holidays + auto national gazetted holidays (26 Jan / 15 Aug / 2 Oct).
    const holidaySet = new Set((holQ.data ?? []).map((h) => h.holiday_date));
    nationalHolidaysForYear(yy).forEach((d) => holidaySet.add(d));
    let expected = 0, sundays = 0, holidays = 0;
    for (const d = new Date(rangeStart); d <= rangeEnd; d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (d.getUTCDay() === 0) sundays++;            // weekly off — paid, never LOP
      else if (holidaySet.has(iso)) holidays++;      // Sunday/holiday clash counts once as Sunday
      else expected++;                                // working day
    }
    const present = new Set((attQ.data ?? []).filter((a) => a.employee_id === employee.id && a.check_in).map((a) => a.work_date)).size;
    const monthLeaves = (leaveQ.data ?? []).filter((l) => l.employee_id === employee.id && l.from_date <= `${period}-31` && l.to_date >= `${period}-01`);
    const paidLeave = monthLeaves.filter((l) => l.type !== "unpaid").reduce((s, l) => s + l.days, 0);
    const unpaidLeave = monthLeaves.filter((l) => l.type === "unpaid").reduce((s, l) => s + l.days, 0);
    const absent = Math.max(0, expected - present - paidLeave - unpaidLeave);
    return { present, absent, unpaidLeave, lopDays: absent + unpaidLeave, workingDays: expected, sundays, holidays };
  }, [period, employee, attQ.data, leaveQ.data, holQ.data]);

  function applyLopSuggestion() {
    onLopDays(String(lopSuggestion.lopDays));
  }

  // Money guard — attendance shows possible loss-of-pay that hasn't been
  // deducted, or the month isn't over yet, but full salary is about to go out.
  const suggestedLopUnapplied = lopSuggestion.lopDays > 0 && lopN === 0;
  const [pyGuard, pmGuard] = period.split("-").map(Number);
  const lastDayOfPeriod = new Date(pyGuard, pmGuard, 0).getUTCDate();
  const todayIso = todayISO();
  const monthIncomplete = period >= todayIso.slice(0, 7) && Number(todayIso.slice(8, 10)) < lastDayOfPeriod;

  async function submit() {
    if (!valid) return;
    await pay.mutateAsync({
      employeeId: employee.id, period, payDate: date, gross: grossN,
      lopDays: Number(lopDays) || 0, lopAmount: lopN, incentive: bonusN,
      advanceRecovered: advN, advanceLoanId: advN > 0 ? advId : null,
      tds: tdsN, pf: pfN, esi: esiN, esiEmployer: esiEmployerN, pfEmployer: pfEmployerN, other: otherN, bankAccountId: accountId,
    });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-xl">
        <DialogHeader>
          <DialogTitle>Pay salary — {employee.name}</DialogTitle>
          <DialogDescription>Period {period}. This books the salary + deductions now; the net pay clears your bank once you reconcile the debit in Banking.</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Salary to pay (₹)</label>
              <Input type="number" min={0} value={gross} onChange={(e) => setGross(e.target.value)} />
              {!payPeriod.complete && (
                <p className="text-[11px] text-ink-3 mt-1">
                  {proratedDefault > 0
                    ? <>Prorated to <b>{payPeriod.elapsed} of {payPeriod.daysInMonth} days</b> (till today) — days not yet worked aren&apos;t paid.</>
                    : <>This month hasn&apos;t started yet — enter an amount to pay in advance.</>}
                  {grossN !== employee.monthly_gross && (
                    <>{" "}<button type="button" className="text-amber-ink font-medium hover:underline" onClick={() => setGross(String(employee.monthly_gross))}>Pay full month ({rupee(employee.monthly_gross)})</button></>
                  )}
                </p>
              )}
              {payPeriod.complete && (
                <p className="text-[11px] text-ink-3 mt-1">
                  Full month · {payPeriod.daysInMonth} days ({periodLabel(period)}). Absences are deducted below as LOP.
                </p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Pay from</label>
              <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
                {accounts.length === 0 && <option value="">Add an account in Banking</option>}
                {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </div>
          </div>

          <div className="rounded-md border border-hairline p-3 space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Earnings (on top of salary)</div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">Bonus / Incentive (₹)</label>
                <Input type="number" min={0} value={bonus} onChange={(e) => setBonus(e.target.value)} />
              </div>
            </div>
            <p className="text-[11px] text-ink-3">One-time bonus/incentive for this month — added to net pay + the Salaries expense, shown separately on the payslip.</p>
          </div>

          {(suggestedLopUnapplied || monthIncomplete) && (
            <div className="rounded-md border border-amber/40 bg-amber-soft/40 px-3 py-2.5 flex items-start gap-2">
              <Icon name="alert" size={14} className="mt-0.5 shrink-0 text-amber-ink" />
              <div className="space-y-1.5 text-[12px] text-amber-ink">
                {suggestedLopUnapplied && (
                  <p>
                    Attendance shows only <b>{lopSuggestion.present} present</b> day(s) this month
                    {lopSuggestion.absent > 0 ? <> and <b>{lopSuggestion.absent} absent</b></> : null} — about
                    {" "}<b>{lopSuggestion.lopDays} day(s) of loss-of-pay</b> for absent days aren&apos;t deducted yet.
                  </p>
                )}
                {monthIncomplete && (
                  <p>{periodLabel(period)} isn&apos;t over yet — the salary above is only for the days elapsed so far; days not yet worked aren&apos;t paid.</p>
                )}
                {suggestedLopUnapplied && (
                  <Button size="sm" variant="primary" onClick={applyLopSuggestion}>
                    Apply {lopSuggestion.lopDays}d LOP from attendance
                  </Button>
                )}
              </div>
            </div>
          )}

          <div className="rounded-md border border-hairline p-3 space-y-3">
            <div className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Deductions</div>
            <div className="rounded bg-paper-2/50 px-2.5 py-2 text-[11px] text-ink-3">
              <div className="flex items-center justify-between gap-2">
                <span><b className="text-ink-2">{lopSuggestion.workingDays}</b> working days · <b className="text-ink-2">{lopSuggestion.present}</b> present · <b className="text-ink-2">{lopSuggestion.absent}</b> absent · <b className="text-ink-2">{lopSuggestion.unpaidLeave}</b> unpaid leave → LOP <b className="text-ink">{lopSuggestion.lopDays}d</b></span>
                <button type="button" onClick={applyLopSuggestion} className="shrink-0 rounded border border-hairline px-2 py-0.5 font-medium text-ink hover:bg-paper">Apply</button>
              </div>
              <div className="mt-1 text-emerald">
                {lopSuggestion.sundays} Sunday{lopSuggestion.sundays === 1 ? "" : "s"}{lopSuggestion.holidays > 0 ? ` + ${lopSuggestion.holidays} holiday${lopSuggestion.holidays === 1 ? "" : "s"}` : ""} — paid, never counted as loss-of-pay.
              </div>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">Unpaid leave (LOP) days</label>
                <Input type="number" min={0} value={lopDays} onChange={(e) => onLopDays(e.target.value)} />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">LOP amount (₹)</label>
                <Input type="number" min={0} value={lopAmt} onChange={(e) => setLopAmt(e.target.value)} />
              </div>
            </div>
            {advances.length > 0 && (
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-ink-2 mb-1">Advance recovery (₹)</label>
                  <Input type="number" min={0} value={advAmt} onChange={(e) => setAdvAmt(e.target.value)} />
                  {advTooMuch && <p className="mt-1 text-[11px] text-rose">Max {rupee(selectedAdv?.outstanding ?? 0)}.</p>}
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-2 mb-1">From advance</label>
                  <select value={advId} onChange={(e) => setAdvId(e.target.value)} className={selectCls}>
                    {advances.map((a) => <option key={a.id} value={a.id}>{rupee(a.outstanding)} outstanding</option>)}
                  </select>
                </div>
              </div>
            )}
            <div className="grid grid-cols-2 gap-3">
              <div><label className="block text-xs font-medium text-ink-2 mb-1">TDS (₹)</label><Input type="number" min={0} value={tds} onChange={(e) => setTds(e.target.value)} /></div>
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">
                  PF — employee (₹){employee.pf_applicable && !pfEdited && <span className="text-emerald ml-1 font-normal">auto 12%</span>}
                </label>
                <Input type="number" min={0} value={pf} onChange={(e) => { setPfEdited(true); setPf(e.target.value); }} />
              </div>
              <div>
                <label className="block text-xs font-medium text-ink-2 mb-1">
                  ESI — employee (₹){employee.esi_applicable && !esiEdited && <span className="text-emerald ml-1 font-normal">auto 0.75%</span>}
                </label>
                <Input type="number" min={0} value={esi} onChange={(e) => { setEsiEdited(true); setEsi(e.target.value); }} />
              </div>
              <div><label className="block text-xs font-medium text-ink-2 mb-1">Other (₹)</label><Input type="number" min={0} value={other} onChange={(e) => setOther(e.target.value)} /></div>
            </div>
            {employee.esi_applicable ? (
              <div className="rounded bg-paper-2/50 px-2.5 py-2 text-[11px] text-ink-2 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span>Employer ESI (3.25%) — company's own cost, <b>not</b> cut from net</span>
                  <span className="font-mono text-ink">{rupee(esiEmployerN)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-hairline pt-0.5">
                  <span>Total ESIC due this month (employee + employer)</span>
                  <span className="font-mono text-ink font-semibold">{rupee(esiN + esiEmployerN)}</span>
                </div>
              </div>
            ) : (
              <p className="text-[11px] text-ink-3">ESI not applicable — gross above the ₹{ESI_WAGE_CEILING.toLocaleString("en-IN")} ceiling (or turned off for this employee).</p>
            )}
            {employee.pf_applicable && (
              <div className="rounded bg-paper-2/50 px-2.5 py-2 text-[11px] text-ink-2 space-y-0.5">
                <div className="flex items-center justify-between">
                  <span>Employer PF (12%) — company's own cost, <b>not</b> cut from net</span>
                  <span className="font-mono text-ink">{rupee(pfEmployerN)}</span>
                </div>
                <div className="flex items-center justify-between border-t border-hairline pt-0.5">
                  <span>Total PF challan this month (employee + employer)</span>
                  <span className="font-mono text-ink font-semibold">{rupee(n(pf) + pfEmployerN)}</span>
                </div>
                <div className="text-ink-3">On wage capped at ₹{PF_WAGE_CEILING.toLocaleString("en-IN")}. (Admin/EDLI ~1% not included.)</div>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Pay date</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>

          <div className="rounded-md bg-paper-2/50 p-3 text-sm space-y-1">
            <Row label="Salary earned (gross − LOP)" value={rupee(Math.max(0, grossN - lopN))} />
            {bonusN > 0 && <Row label="+ Bonus / Incentive" value={`+${rupee(bonusN)}`} />}
            {advN > 0 && <Row label="− Advance recovery" value={`−${rupee(advN)}`} />}
            {(tdsN + pfN + esiN + otherN) > 0 && <Row label="− TDS / PF / ESI / other" value={`−${rupee(tdsN + pfN + esiN + otherN)}`} />}
            <div className="flex items-center justify-between pt-1 border-t border-hairline font-semibold text-ink">
              <span>Net pay (cash out)</span><span className="font-mono">{rupee(net)}</span>
            </div>
            {(esiEmployerN > 0 || pfEmployerN > 0) && (
              <p className="text-[11px] text-ink-3 pt-1">
                {esiEmployerN > 0 && <>+ {rupee(esiEmployerN)} employer ESI</>}
                {esiEmployerN > 0 && pfEmployerN > 0 && " · "}
                {pfEmployerN > 0 && <>+ {rupee(pfEmployerN)} employer PF</>}
                {" "}accrues as a statutory due (paid later via the challan) — it does not leave the bank now.
              </p>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pay.isPending}>Cancel</Button>
          <Button variant="primary" loading={pay.isPending} disabled={!valid} onClick={submit}>Pay {rupee(net > 0 ? net : 0)}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between text-ink-2"><span>{label}</span><span className="font-mono">{value}</span></div>;
}

// ── Leave tab ─────────────────────────────────────────────────────────────
export function LeaveTab() {
  const empQ = useEmployees();
  const leaveQ = useLeaveEntries();
  const del = useDeleteLeaveEntry();
  const confirm = useConfirm();
  const [addOpen, setAddOpen] = React.useState(false);
  const empName = new Map((empQ.data ?? []).map((e) => [e.id, e.name]));
  const rows = leaveQ.data ?? [];

  return (
    <>
      <HolidaysCard />
      <div className="flex justify-end mb-3">
        <Button variant="primary" icon="plus" onClick={() => setAddOpen(true)} disabled={(empQ.data ?? []).length === 0}>Record leave</Button>
      </div>
      {leaveQ.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <Card className="py-2"><EmptyState icon="clock" title="No leave recorded" body="Record leave — unpaid leave becomes loss-of-pay in payroll." /></Card>
      ) : (
        <>
          {/* Desktop table */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left px-4 py-3">Employee</th>
                  <th className="text-left px-4 py-3">Dates</th>
                  <th className="text-right px-4 py-3">Days</th>
                  <th className="text-left px-4 py-3">Type</th>
                  <th className="text-right px-4 py-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((l) => (
                  <tr key={l.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3 font-medium text-ink">{empName.get(l.employee_id) ?? "—"}</td>
                    <td className="px-4 py-3 text-ink-2">{formatDate(l.from_date)}{l.to_date !== l.from_date ? ` – ${formatDate(l.to_date)}` : ""}</td>
                    <td className="px-4 py-3 text-right font-mono">{l.days}</td>
                    <td className="px-4 py-3">
                      <Badge kind={l.type === "unpaid" ? "warning" : "info"}>{LEAVE_TYPE_LABEL[l.type]}</Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={async () => { if (await confirm({ title: "Remove this leave entry?", confirmLabel: "Remove", danger: true })) del.mutate(l.id); }}>Remove</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Mobile cards */}
          <ul className="md:hidden space-y-2">
            {rows.map((l) => (
              <li key={l.id}>
                <Card className="p-4">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="font-medium text-ink leading-tight">{empName.get(l.employee_id) ?? "—"}</div>
                    <div className="font-serif text-xl text-ink leading-none">{l.days}<span className="ml-1 text-sm text-ink-3">day{l.days === 1 ? "" : "s"}</span></div>
                  </div>
                  <div className="text-[11px] text-ink-3 mb-2">
                    {formatDate(l.from_date)}{l.to_date !== l.from_date ? ` – ${formatDate(l.to_date)}` : ""}
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <Badge kind={l.type === "unpaid" ? "warning" : "info"}>{LEAVE_TYPE_LABEL[l.type]}</Badge>
                    <Button variant="ghost" size="sm" onClick={async () => { if (await confirm({ title: "Remove this leave entry?", confirmLabel: "Remove", danger: true })) del.mutate(l.id); }}>Remove</Button>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
      {(empQ.data ?? []).length > 0 && (
        <FAB icon="plus" label="Record leave" onClick={() => setAddOpen(true)} ariaLabel="Record leave" />
      )}
      {addOpen && <LeaveDialog employees={empQ.data ?? []} onClose={() => setAddOpen(false)} />}
    </>
  );
}

function HolidaysCard() {
  const holQ = useHolidays();
  const create = useCreateHoliday();
  const del = useDeleteHoliday();
  const confirm = useConfirm();
  const [date, setDate] = React.useState("");
  const [name, setName] = React.useState("");
  const [seeding, setSeeding] = React.useState(false);
  const rows = holQ.data ?? [];
  const add = async () => {
    if (!date || !name.trim()) return;
    await create.mutateAsync({ holiday_date: date, name: name.trim() });
    setDate(""); setName("");
  };
  // Pre-load the date-certain public holidays for this year + next; skips any
  // already present. Variable-date festivals are added by hand above.
  const loadPublic = async () => {
    const existing = new Set(rows.map((r) => r.holiday_date));
    const y = new Date(Date.now() + 5.5 * 60 * 60 * 1000).getUTCFullYear();
    const toAdd = [y, y + 1].flatMap(indiaPublicHolidaysForYear).filter((h) => !existing.has(h.date));
    if (toAdd.length === 0) { toast("India public holidays are already added."); return; }
    setSeeding(true);
    try {
      for (const h of toAdd) await create.mutateAsync({ holiday_date: h.date, name: h.name });
      toast.success(`Added ${toAdd.length} public holidays (${y}–${y + 1}).`);
    } finally { setSeeding(false); }
  };
  return (
    <Card className="mb-4 p-4">
      <div className="mb-3 flex items-start justify-between gap-2">
        <div>
          <div className="text-sm font-semibold text-ink">Holidays</div>
          <div className="text-[11px] text-ink-3">
            Treated as non-working days in payroll — an absence on these dates is <b>not</b> docked as loss-of-pay (Sundays are already off).
          </div>
        </div>
        <Button size="sm" variant="outline" icon="download" loading={seeding} onClick={loadPublic}
          title="Add India's fixed-date public holidays (Republic Day, Independence Day, Gandhi Jayanti, Ambedkar Jayanti, Christmas) for this year + next. Add festivals like Holi/Diwali/Eid by hand — their dates change yearly.">
          Load India public holidays
        </Button>
      </div>
      <div className="flex flex-wrap items-end gap-2 mb-3">
        <div>
          <label className="block text-[11px] text-ink-3 mb-1">Date</label>
          <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-44" />
        </div>
        <div className="flex-1 min-w-[160px]">
          <label className="block text-[11px] text-ink-3 mb-1">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Diwali, Independence Day" />
        </div>
        <Button size="sm" variant="primary" icon="plus" onClick={add} disabled={!date || !name.trim() || create.isPending} loading={create.isPending}>Add</Button>
      </div>
      {rows.length === 0 ? (
        <p className="text-[11px] text-ink-3">No holidays added yet — add your festival + national holidays so payroll doesn't dock pay for them.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {rows.map((h) => (
            <span key={h.id} className="inline-flex items-center gap-1.5 rounded-full border border-hairline bg-paper-2/50 px-2.5 py-1 text-xs">
              <span className="font-medium text-ink">{h.name}</span>
              <span className="text-ink-3">{formatDate(h.holiday_date)}</span>
              <button
                type="button"
                onClick={async () => { if (await confirm({ title: "Remove this holiday?", confirmLabel: "Remove", danger: true })) del.mutate(h.id); }}
                className="text-ink-3 hover:text-rose"
                aria-label="Remove holiday"
              >×</button>
            </span>
          ))}
        </div>
      )}
    </Card>
  );
}

function LeaveDialog({ employees, onClose }: { employees: Employee[]; onClose: () => void }) {
  const create = useCreateLeaveEntry();
  const leaveQ = useLeaveEntries();
  const holQ = useHolidays();
  const [empId, setEmpId] = React.useState(employees[0]?.id ?? "");
  const [from, setFrom]   = React.useState(todayISO());
  const [to, setTo]       = React.useState(todayISO());
  const [days, setDays]   = React.useState("1");
  const [type, setType]   = React.useState<LeaveKind>("casual");
  const [notes, setNotes] = React.useState("");

  const daysN = Number(days) || 0;
  const valid = Boolean(empId) && daysN > 0 && from <= to;
  const isPaidType = type !== "unpaid";
  const emp = employees.find((e) => e.id === empId);

  // Paid-leave used in the leave-year (Indian FY, Apr–Mar) of the 'from' date.
  const fy = React.useMemo(() => {
    const [y, m] = from.split("-").map(Number);
    const sy = m >= 4 ? y : y - 1;
    return { start: `${sy}-04-01`, end: `${sy + 1}-03-31` };
  }, [from]);
  // Prorated for mid-year joiners, against the leave entry's own FY.
  const allowance = emp ? effectiveLeaveAllowance(emp, fy.start) : 0;
  const usage = React.useMemo(() => {
    const mine = (leaveQ.data ?? []).filter(
      (l) => l.employee_id === empId && l.from_date >= fy.start && l.from_date <= fy.end,
    );
    const byType: Record<string, number> = { casual: 0, sick: 0, earned: 0, unpaid: 0 };
    for (const l of mine) byType[l.type] = (byType[l.type] ?? 0) + Number(l.days);
    const paidTaken = byType.casual + byType.sick + byType.earned;
    return { byType, paidTaken };
  }, [leaveQ.data, empId, fy]);
  const paidLeft = Math.max(0, allowance - usage.paidTaken);
  const wouldExceed = isPaidType && usage.paidTaken + daysN > allowance;

  // Auto working-day count for the chosen range (excludes Sundays + holidays).
  const autoWorkingDays = React.useMemo(() => {
    if (from > to) return 0;
    const holidaySet = new Set((holQ.data ?? []).map((h) => h.holiday_date));
    [Number(from.slice(0, 4)), Number(to.slice(0, 4))].forEach((y) => nationalHolidaysForYear(y).forEach((d) => holidaySet.add(d)));
    let n = 0;
    for (const d = new Date(from + "T00:00:00Z"); d <= new Date(to + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1)) {
      const iso = d.toISOString().slice(0, 10);
      if (d.getUTCDay() !== 0 && !holidaySet.has(iso)) n++;
    }
    return n;
  }, [from, to, holQ.data]);

  async function submit() {
    if (!valid) return;
    await create.mutateAsync({ employee_id: empId, from_date: from, to_date: to, days: daysN, type, notes: notes.trim() || null });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Record leave</DialogTitle>
          <DialogDescription>Unpaid leave becomes loss-of-pay (LOP) in that month&apos;s payroll.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Employee</label>
            <select value={empId} onChange={(e) => setEmpId(e.target.value)} className={selectCls}>
              {employees.map((e) => <option key={e.id} value={e.id}>{e.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div><label className="block text-xs font-medium text-ink-2 mb-1">From</label><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></div>
            <div><label className="block text-xs font-medium text-ink-2 mb-1">To</label><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Days</label>
              <Input type="number" min={0.5} step={0.5} value={days} onChange={(e) => setDays(e.target.value)} />
              {autoWorkingDays > 0 && autoWorkingDays !== daysN && (
                <button type="button" onClick={() => setDays(String(autoWorkingDays))} className="mt-1 text-[11px] text-amber-ink underline hover:no-underline">
                  Use {autoWorkingDays} working day{autoWorkingDays === 1 ? "" : "s"} (excl. Sun + holidays)
                </button>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium text-ink-2 mb-1">Type</label>
              <select value={type} onChange={(e) => setType(e.target.value as LeaveKind)} className={selectCls}>
                <option value="casual">Casual (paid)</option>
                <option value="sick">Sick (paid)</option>
                <option value="earned">Earned (paid)</option>
                <option value="unpaid">Unpaid (LOP)</option>
              </select>
            </div>
          </div>

          {/* Paid-leave balance for the selected employee (this leave-year) */}
          {emp && (
            <div className="rounded-md bg-paper-2/50 px-3 py-2 text-[11px] text-ink-2">
              <div className="flex items-center justify-between">
                <span>Paid leave used this year (FY {fy.start.slice(0, 4)}–{fy.end.slice(2, 4)})</span>
                <span className="font-mono"><b className="text-ink">{usage.paidTaken}</b> / {allowance} · {paidLeft} left</span>
              </div>
              <div className="text-ink-3 mt-0.5">
                Casual {usage.byType.casual} · Sick {usage.byType.sick} · Earned {usage.byType.earned} · Unpaid {usage.byType.unpaid}
              </div>
            </div>
          )}
          {wouldExceed && (
            <div className="rounded-md bg-rose-soft border border-rose/30 px-3 py-2 text-[11px] text-rose flex items-start gap-2">
              <Icon name="alert" size={13} className="flex-shrink-0 mt-0.5" />
              <span>
                This is <b>{usage.paidTaken + daysN - allowance} day(s) over</b> the {allowance}-day paid allowance.
                It'll still be saved — but consider recording the extra as <b>Unpaid (LOP)</b> so pay is docked correctly.
              </span>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Note (optional)</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={create.isPending}>Cancel</Button>
          <Button variant="primary" loading={create.isPending} disabled={!valid} onClick={submit}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Attendance tab ──────────────────────────────────────────────────────────
function NetworkCard() {
  const netQ = useAttendanceNetwork();
  const setNet = useSetAttendanceNetwork();
  const d = netQ.data;
  const locked = (d?.allowedIps.length ?? 0) > 0;
  return (
    <Card className={cn("mb-4 p-3 md:p-4", locked ? "border-emerald/30" : "")}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <Icon name="lock" size={14} className={locked ? "text-emerald" : "text-ink-3"} />
            Office network {locked ? "locked" : "not locked"}
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5 max-w-xl">
            {locked
              ? "Attendance can only be marked from the office network(s) below — off-site marking is blocked."
              : "Anyone with the kiosk link can mark from any network. Open this on the office WiFi and lock it to prevent off-site marking."}
          </p>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="primary" size="sm" loading={setNet.isPending} onClick={() => setNet.mutate({ action: "lock" })}>
            Lock to this network
          </Button>
          {locked && <Button variant="ghost" size="sm" onClick={() => setNet.mutate({ action: "clear" })}>Turn off</Button>}
        </div>
      </div>
      {d && (
        <div className="mt-2 text-[11px] text-ink-3">
          This network&apos;s IP: <span className="font-mono text-ink-2">{d.currentIp || "—"}</span>
          {locked && (
            <span className="ml-2">· Allowed:{d.allowedIps.map((ip) => (
              <span key={ip} className="ml-1 font-mono text-ink-2">
                {ip}
                <button onClick={() => setNet.mutate({ action: "remove", ip })} className="ml-0.5 text-rose" aria-label={`Remove ${ip}`}>×</button>
              </span>
            ))}</span>
          )}
        </div>
      )}

      {/* Selfie requirement — the real anti buddy-punching control */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <div>
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <Icon name="eye" size={14} className={d?.requireSelfie ? "text-emerald" : "text-ink-3"} />
            Selfie required to mark {d?.requireSelfie ? "· ON" : "· OFF"}
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5 max-w-xl">
            {d?.requireSelfie
              ? "Every check-in captures a photo — knowing someone's PIN alone can't mark them present (no buddy-punching)."
              : "PIN-only marking is allowed. Anyone who knows a PIN could mark that person present. Turn on to require a photo."}
          </p>
        </div>
        <Button
          variant={d?.requireSelfie ? "ghost" : "primary"}
          size="sm"
          loading={setNet.isPending}
          onClick={() => setNet.mutate({ action: "require_selfie", value: !(d?.requireSelfie ?? true) })}
        >
          {d?.requireSelfie ? "Turn off" : "Require selfie"}
        </Button>
      </div>

      {/* Office presence code — gates SELF check-in (personal phones) to the office */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <div>
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <Icon name="mobile" size={14} className={d?.requirePresence ? "text-emerald" : "text-ink-3"} />
            Office code for self check-in {d?.requirePresence ? "· ON" : "· OFF"}
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5 max-w-xl">
            {d?.requirePresence
              ? "Employees marking from their OWN phone must type the rotating code shown on the kiosk — so \"My Attendance\" can only be done inside the office."
              : "Self check-in (\"My Attendance\") works from anywhere. Turn on to require the office code — the fix for marking present from home."}
          </p>
        </div>
        <Button
          variant={d?.requirePresence ? "ghost" : "primary"}
          size="sm"
          loading={setNet.isPending}
          onClick={() => setNet.mutate({ action: "require_presence", value: !(d?.requirePresence ?? false) })}
        >
          {d?.requirePresence ? "Turn off" : "Require office code"}
        </Button>
      </div>

      {/* Selfie retention — DPDP storage limitation */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <div>
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <Icon name="clock" size={14} className="text-ink-3" />
            Selfies kept for
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5 max-w-xl">
            Puraani selfies is period ke baad apne-aap delete ho jaati hain (privacy / DPDP). Employee exit pe bhi delete.
          </p>
        </div>
        <select
          value={d?.retentionDays ?? 180}
          onChange={(e) => setNet.mutate({ action: "set_retention", value: Number(e.target.value) })}
          className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper"
        >
          <option value={90}>3 months</option>
          <option value={180}>6 months</option>
          <option value={365}>1 year</option>
          <option value={730}>2 years</option>
        </select>
      </div>

      {/* Face verification (Phase 4 seam) — premium, opt-in */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-hairline pt-3">
        <div>
          <div className="text-sm font-medium text-ink flex items-center gap-2">
            <Icon name="user" size={14} className={d?.requireFaceMatch ? "text-emerald" : "text-ink-3"} />
            Face verification {d?.requireFaceMatch ? "· ON" : "· OFF"}
          </div>
          <p className="text-[11px] text-ink-3 mt-0.5 max-w-xl">
            {d?.requireFaceMatch
              ? "Self check-in selfie ko employee ke enrolled face se match kiya jaata hai. Bina certified face-provider ke, mismatch/undecided owner review me aata hai (koi auto-reject nahi)."
              : "OFF. Turn on to match each self check-in selfie against an enrolled face. Employees ko pehle 'My Attendance' pe apna face enroll karna hoga. (Certified provider env se connect hota hai — warna review-only.)"}
          </p>
        </div>
        <Button
          variant={d?.requireFaceMatch ? "ghost" : "primary"}
          size="sm"
          loading={setNet.isPending}
          onClick={() => setNet.mutate({ action: "require_face_match", value: !(d?.requireFaceMatch ?? false) })}
        >
          {d?.requireFaceMatch ? "Turn off" : "Require face match"}
        </Button>
      </div>
    </Card>
  );
}

export function AttendanceTab() {
  const router = useRouter();
  const params = useSearchParams();
  const monthParam = params.get("month");
  const focusId = params.get("employee");
  const [period, setPeriod] = React.useState(
    monthParam && /^\d{4}-\d{2}$/.test(monthParam) ? monthParam : currentPeriod(),
  );
  const empQ = useEmployees();
  const attQ = useAttendance(period);
  const setConsent = useOwnerSetConsent();
  const reviewMut = useMarkAttendanceReviewed();
  const employees = (empQ.data ?? []).filter((e) => e.is_active);
  const focusEmp = focusId ? (empQ.data ?? []).find((e) => e.id === focusId) ?? null : null;

  // Focused view: ONE employee's attendance register (opened from the payroll
  // "Present (mo)" cell).
  if (focusId && focusEmp) {
    return (
      <>
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <button
            type="button"
            onClick={() => router.push("/accounting/attendance" as never)}
            className="inline-flex items-center gap-1 text-sm text-ink-2 hover:text-ink"
          >
            <Icon name="arrow_left" size={15} /> All employees
          </button>
          <div className="flex items-center gap-2">
            <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">Month</label>
            <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
          </div>
        </div>
        <Card className="mb-4 p-4">
          <div className="text-[11px] uppercase tracking-wider text-ink-3 font-semibold">Attendance register</div>
          <div className="font-serif text-2xl text-ink leading-tight mt-1">{toTitleCase(focusEmp.name)}</div>
          {focusEmp.designation && <div className="text-[11px] text-ink-3 mt-0.5">{focusEmp.designation}</div>}
        </Card>
        {attQ.isLoading
          ? <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
          : <AttendanceRegister period={period} employees={[focusEmp]} attendance={attQ.data ?? []} />}
      </>
    );
  }

  const byEmp = new Map<string, { present: number; last: string | null }>();
  for (const a of attQ.data ?? []) {
    const cur = byEmp.get(a.employee_id) ?? { present: 0, last: null };
    if (a.check_in) cur.present += 1;
    if (!cur.last || a.work_date > cur.last) cur.last = a.work_date;
    byEmp.set(a.employee_id, cur);
  }

  return (
    <>
      <NetworkCard />

      <ReviewQueue attendance={attQ.data ?? []} employees={employees} onReview={(id) => reviewMut.mutate(id)} reviewing={reviewMut.isPending} />

      <Card className="mb-4 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">Month</label>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
          <Button variant="primary" icon="external" className="ml-auto"
            onClick={() => window.open("/attendance/kiosk", "_blank", "noopener")}>
            Open kiosk
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-ink-3">
          Open the kiosk on your office tablet/phone (kept logged in) — employees tap their name + PIN to check in/out.
          Set each employee&apos;s PIN in the Employees tab.
        </p>
      </Card>

      {empQ.isLoading ? (
        <div className="space-y-3">{[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : employees.length === 0 ? (
        <Card className="py-2"><EmptyState icon="users" title="No active employees" body="Add employees and set their PINs first." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-paper-2/50 text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
              <tr>
                <th className="text-left px-4 py-3">Employee</th>
                <th className="text-left px-4 py-3">PIN</th>
                <th className="text-left px-4 py-3">Selfie consent</th>
                <th className="text-right px-4 py-3">Days present</th>
                <th className="text-left px-4 py-3">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline">
              {employees.map((e) => {
                const s = byEmp.get(e.id);
                const consented = Boolean(e.attendance_consent_at);
                return (
                  <tr key={e.id} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3 font-medium text-ink">{e.name}</td>
                    <td className="px-4 py-3">
                      {e.pin_hash ? <Badge kind="success">Set</Badge> : <Badge kind="warning">Not set</Badge>}
                    </td>
                    <td className="px-4 py-3">
                      {consented ? (
                        <button
                          className="inline-flex items-center gap-1.5 group"
                          title={`Consented (${e.attendance_consent_source ?? "?"}) — click to withdraw + delete selfies`}
                          onClick={() => setConsent.mutate({ employeeId: e.id, value: false })}
                        >
                          <Badge kind="success">Given</Badge>
                          <span className="text-[10px] text-ink-3 group-hover:text-rose">withdraw</span>
                        </button>
                      ) : (
                        <button
                          className="inline-flex items-center gap-1.5"
                          title="Record consent on this employee's behalf (enrollment)"
                          onClick={() => setConsent.mutate({ employeeId: e.id, value: true })}
                        >
                          <Badge kind="warning">Pending</Badge>
                          <span className="text-[10px] text-ink-3 hover:text-amber-ink">mark given</span>
                        </button>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">{s?.present ?? 0}</td>
                    <td className="px-4 py-3 text-ink-2">{s?.last ? formatDate(s.last) : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}

      {employees.length > 0 && (
        <AttendanceRegister period={period} employees={employees} attendance={attQ.data ?? []} />
      )}

      <TodayCheckins attendance={attQ.data ?? []} employees={employees} />
    </>
  );
}

/** Monthly attendance register (muster): employees × days, P = present. */
function AttendanceRegister({ period, employees, attendance }: { period: string; employees: Employee[]; attendance: Attendance[] }) {
  const holQ = useHolidays();
  const [yy, mm] = period.split("-").map(Number);
  if (!yy || !mm) return null;
  const days = new Date(yy, mm, 0).getDate();          // last day of this month
  const today = todayISO();
  const monthLabel = new Date(yy, mm - 1, 1).toLocaleDateString("en-IN", { month: "long", year: "numeric" });
  const dayList = Array.from({ length: days }, (_, i) => i + 1);
  const dateFor = (d: number) => `${period}-${String(d).padStart(2, "0")}`;

  // Holidays for this month: company (owner-added) + national gazetted (26 Jan / 15 Aug / 2 Oct).
  const holidayMap = new Map<string, string>();
  (holQ.data ?? []).forEach((h) => { if (h.holiday_date.slice(0, 7) === period) holidayMap.set(h.holiday_date, h.name); });
  FIXED_NATIONAL_HOLIDAYS.forEach((h) => { const iso = `${yy}-${h.md}`; if (iso.slice(0, 7) === period) holidayMap.set(iso, h.name); });

  const isSunday = (d: number) => new Date(Date.UTC(yy, mm - 1, d)).getUTCDay() === 0;
  const dayKind = (d: number): "sunday" | "holiday" | "work" =>
    isSunday(d) ? "sunday" : holidayMap.has(dateFor(d)) ? "holiday" : "work";

  const sundayCount  = dayList.filter((d) => isSunday(d)).length;
  const holidayDays  = dayList.filter((d) => !isSunday(d) && holidayMap.has(dateFor(d)));
  const workingCount = days - sundayCount - holidayDays.length;

  // "employeeId|YYYY-MM-DD" → attendance record
  const byKey = new Map<string, Attendance>();
  for (const a of attendance) byKey.set(`${a.employee_id}|${a.work_date}`, a);

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-hairline px-4 py-3">
        <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-3">
          Attendance register · {monthLabel} · <span className="text-ink-2">{workingCount} working</span> · {sundayCount} Sundays{holidayDays.length > 0 ? ` · ${holidayDays.length} holiday${holidayDays.length === 1 ? "" : "s"}` : ""}
        </div>
        <div className="text-[11px] text-ink-3"><span className="font-semibold text-emerald">P</span> present · – absent · <span className="text-indigo">S</span> Sunday · <span className="text-amber-ink">H</span> holiday</div>
      </div>
      <div className="overflow-x-auto">
        <table className="text-sm">
          <thead className="bg-paper-2/50 text-[10px] text-ink-3">
            <tr>
              <th className="sticky left-0 z-10 bg-paper-2 px-3 py-2 text-left min-w-[130px]">Employee</th>
              {dayList.map((d) => {
                const kind = dayKind(d);
                return (
                  <th
                    key={d}
                    title={kind === "holiday" ? holidayMap.get(dateFor(d)) : kind === "sunday" ? "Sunday — weekly off" : undefined}
                    className={cn(
                      "px-1.5 py-2 text-center font-medium tabular-nums",
                      kind === "sunday" && "bg-indigo/10 text-indigo",
                      kind === "holiday" && "bg-amber-soft text-amber-ink",
                      dateFor(d) === today && "font-bold underline",
                    )}
                  >
                    {d}
                    {kind !== "work" && <div className="text-[7px] leading-none font-semibold">{kind === "sunday" ? "S" : "H"}</div>}
                  </th>
                );
              })}
              <th className="px-3 py-2 text-right">Present</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-hairline">
            {employees.map((e) => {
              const present = dayList.filter((d) => byKey.get(`${e.id}|${dateFor(d)}`)?.check_in).length;
              return (
                <tr key={e.id} className="hover:bg-paper-2/30">
                  <td className="sticky left-0 z-10 bg-paper px-3 py-2 font-medium text-ink whitespace-nowrap">{e.name}</td>
                  {dayList.map((d) => {
                    const rec = byKey.get(`${e.id}|${dateFor(d)}`);
                    const isPresent = Boolean(rec?.check_in);
                    const kind = dayKind(d);
                    const future = dateFor(d) > today;
                    return (
                      <td
                        key={d}
                        className={cn("px-1.5 py-2 text-center", kind === "sunday" && "bg-indigo/5", kind === "holiday" && "bg-amber-soft/40")}
                        title={isPresent ? `In ${fmtTimeIST(rec!.check_in)}${rec!.check_out ? ` · Out ${fmtTimeIST(rec!.check_out)}` : ""}` : kind === "holiday" ? holidayMap.get(dateFor(d)) : undefined}
                      >
                        {isPresent
                          ? <span className="font-semibold text-emerald">P</span>
                          : kind === "sunday" ? <span className="text-indigo/50 text-[9px]">S</span>
                          : kind === "holiday" ? <span className="text-amber-ink/60 text-[9px]">H</span>
                          : future ? <span className="text-ink-3/25">·</span>
                          : <span className="text-ink-3/40">–</span>}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2 text-right font-mono font-semibold text-ink">{present}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {holidayDays.length > 0 && (
        <div className="border-t border-hairline px-4 py-2 text-[11px] text-ink-3">
          <span className="font-semibold text-ink-2">Holidays:</span>{" "}
          {holidayDays.map((d) => `${d} ${monthLabel.split(" ")[0]} — ${holidayMap.get(dateFor(d))}`).join(" · ")}
        </div>
      )}
    </Card>
  );
}

/** One employee's monthly attendance register in a pop-up — opened from the
 *  Run-payroll "Present (mo)" cell. Reuses the same muster grid. */
function AttendanceRegisterDialog({ employee, initialPeriod, onClose }: {
  employee: Employee; initialPeriod: string; onClose: () => void;
}) {
  const [period, setPeriod] = React.useState(initialPeriod);
  const attQ = useAttendance(period);
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-3xl">
        <DialogHeader>
          <DialogTitle>Attendance register — {toTitleCase(employee.name)}</DialogTitle>
          <DialogDescription>
            {[employee.designation?.trim() || null, "present days by date · P = present, – = absent"].filter(Boolean).join(" · ")}
          </DialogDescription>
        </DialogHeader>
        <div className="mb-1 flex items-center gap-2">
          <label className="text-xs text-ink-3 font-semibold uppercase tracking-wide">Month</label>
          <input type="month" value={period} onChange={(e) => setPeriod(e.target.value)}
            className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
        </div>
        {attQ.isLoading
          ? <Skeleton className="h-16 w-full" />
          : <AttendanceRegister period={period} employees={[employee]} attendance={attQ.data ?? []} />}
      </DialogContent>
    </Dialog>
  );
}

const FLAG_LABEL: Record<string, string> = {
  odd_hours:         "Odd hours",
  no_location:       "No location",
  new_device:        "New device",
  face_review:       "Face — review",
  face_mismatch:     "Face mismatch",
  face_not_enrolled: "Face not enrolled",
};

/** Owner review queue — anomaly-flagged, not-yet-reviewed punches for the month. */
function ReviewQueue({
  attendance, employees, onReview, reviewing,
}: {
  attendance: Attendance[]; employees: Employee[];
  onReview: (id: string) => void; reviewing: boolean;
}) {
  const empName = new Map(employees.map((e) => [e.id, e.name]));
  const rows = attendance
    .filter((a) => (a.flags?.length ?? 0) > 0 && !a.reviewed_at)
    .sort((a, b) => b.work_date.localeCompare(a.work_date));
  if (rows.length === 0) return null;
  return (
    <Card className="mb-4 overflow-hidden border-amber/40">
      <div className="px-4 py-3 border-b border-hairline bg-amber-soft/30 flex items-center gap-2">
        <Icon name="alert" size={14} className="text-amber-ink" />
        <span className="text-sm font-semibold text-ink">Needs review · {rows.length}</span>
        <span className="text-[11px] text-ink-3">Self check-ins jinme kuch anokha laga — dekh ke clear karo.</span>
      </div>
      <ul className="divide-y divide-hairline">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2.5 text-sm">
            <span className="font-medium text-ink">{empName.get(a.employee_id) ?? "—"}</span>
            <span className="text-xs text-ink-3">{formatDate(a.work_date)} · In {fmtTimeIST(a.check_in)}{a.check_out ? ` · Out ${fmtTimeIST(a.check_out)}` : ""}</span>
            <span className="flex flex-wrap gap-1">
              {(a.flags ?? []).map((f) => (
                <Badge key={f} kind="warning">{FLAG_LABEL[f] ?? f}</Badge>
              ))}
            </span>
            <span className="ml-auto flex items-center gap-2">
              {a.selfie_in && <SelfieButton path={a.selfie_in} label="in" />}
              {a.selfie_out && <SelfieButton path={a.selfie_out} label="out" />}
              <Button size="sm" variant="ghost" disabled={reviewing} onClick={() => onReview(a.id)}>
                Mark reviewed
              </Button>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function TodayCheckins({ attendance, employees }: { attendance: Attendance[]; employees: Employee[] }) {
  const today = todayISO();
  const empName = new Map(employees.map((e) => [e.id, e.name]));
  const rows = attendance.filter((a) => a.work_date === today);
  if (rows.length === 0) return null;
  return (
    <Card className="mt-4 overflow-hidden">
      <div className="px-4 py-3 border-b border-hairline text-[10px] uppercase tracking-wider text-ink-3 font-semibold">Today&apos;s check-ins</div>
      <ul className="divide-y divide-hairline">
        {rows.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-sm">
            <span className="font-medium text-ink">{empName.get(a.employee_id) ?? "—"}</span>
            <span className="ml-auto text-xs text-ink-3">In {fmtTimeIST(a.check_in)}{a.check_out ? ` · Out ${fmtTimeIST(a.check_out)}` : ""}</span>
            {a.selfie_in && <SelfieButton path={a.selfie_in} label="in" />}
            {a.selfie_out && <SelfieButton path={a.selfie_out} label="out" />}
          </li>
        ))}
      </ul>
    </Card>
  );
}

function SelfieButton({ path, label }: { path: string; label: string }) {
  const [loading, setLoading] = React.useState(false);
  async function view() {
    setLoading(true);
    const url = await getSelfieUrl(path);
    setLoading(false);
    if (url) window.open(url, "_blank", "noopener");
  }
  return (
    <button onClick={view} disabled={loading} className="inline-flex items-center gap-1 text-[11px] text-indigo hover:underline disabled:opacity-50">
      <Icon name="eye" size={12} /> {label}
    </button>
  );
}

// ── Pay statutory dues ──────────────────────────────────────────────────────
function PayDuesDialog({ payable, onClose }: { payable: number; onClose: () => void }) {
  const accountsQ = useBankAccounts();
  const pay = usePayStatutoryDues();
  const accounts = (accountsQ.data ?? []).filter((a) => a.is_active);
  const [amount, setAmount] = React.useState(String(payable));
  const [kind, setKind]     = React.useState("mixed");
  const [date, setDate]     = React.useState(todayISO());
  const [accountId, setAccountId] = React.useState("");
  React.useEffect(() => { if (!accountId && accounts.length > 0) setAccountId(accounts[0].id); }, [accounts, accountId]);

  const amt = Math.max(0, Math.round(Number(amount) || 0));
  const tooMuch = amt > payable;
  const valid = amt > 0 && !tooMuch && Boolean(accountId);

  async function submit() {
    if (!valid) return;
    await pay.mutateAsync({ amount: amt, kind, paidOn: date, bankAccountId: accountId });
    onClose();
  }

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Record statutory payment</DialogTitle>
          <DialogDescription>Pay withheld TDS/PF/ESI to govt. Payable: <b className="text-ink">{rupee(payable)}</b>.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Amount (₹)</label>
            <Input type="number" min={1} value={amount} onChange={(e) => setAmount(e.target.value)} />
            {tooMuch && <p className="mt-1 text-[11px] text-rose">Can&apos;t exceed payable {rupee(payable)}.</p>}
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Type</label>
            <select value={kind} onChange={(e) => setKind(e.target.value)} className={selectCls}>
              <option value="mixed">Mixed</option>
              <option value="tds">TDS</option>
              <option value="pf">PF</option>
              <option value="esi">ESI</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Paid from</label>
            <select value={accountId} onChange={(e) => setAccountId(e.target.value)} className={selectCls}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-ink-2 mb-1">Date</label>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pay.isPending}>Cancel</Button>
          <Button variant="primary" loading={pay.isPending} disabled={!valid} onClick={submit}>Pay {amt > 0 && !tooMuch ? rupee(amt) : ""}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
