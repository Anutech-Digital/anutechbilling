/**
 * Payroll + leave — TanStack Query hooks (migration 0087).
 *
 * Salary is booked as a Salaries EXPENSE (earned = gross − LOP); only the NET
 * pay leaves the bank. Advance recovery reduces the employee's loan (no cash);
 * withheld TDS/PF/ESI stay a liability until paid to govt. All money movement
 * is via the pay_salary / pay_statutory_dues RPCs so it stays atomic.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { guardErrorToast } from "@/lib/ui/guard-toast";
import type { Database } from "@/lib/supabase/database.types";
import { statutoryDues, type DuesSummary } from "@/lib/accounting/tds-deductor";
import { monthBounds } from "@/lib/dates/ist";

/** R-607: no pin_hash — members cannot read it (20261010010000). Use `pin_set`. */
export type Employee = Omit<Database["public"]["Tables"]["employees"]["Row"], "pin_hash">;

/** Every employees column a member may read: all but pin_hash. Kept explicit because
 *  `select("*")` now fails with "permission denied" (column grants). */
const EMPLOYEE_COLUMNS = "id, tenant_id, name, monthly_gross, joining_date, leave_allowance, pan, pf_no, esi_no, is_active, notes, created_at, updated_at, email, phone, designation, date_of_birth, address, emergency_contact_name, emergency_contact_phone, esi_applicable, pf_applicable, biometric_id, attendance_consent_at, attendance_consent_source, face_enrolled_at, face_ref_path, basic_monthly, da_monthly, pin_set, attendance_anywhere";
export type LeaveEntry = Database["public"]["Tables"]["leave_entries"]["Row"];
export type SalaryPayment = Database["public"]["Tables"]["salary_payments"]["Row"];
export type Attendance = Database["public"]["Tables"]["attendance"]["Row"];
export type LeaveKind = LeaveEntry["type"];

export const LEAVE_TYPE_LABEL: Record<LeaveKind, string> = {
  casual: "Casual", sick: "Sick", earned: "Earned", unpaid: "Unpaid (LOP)",
};

async function tenantId(): Promise<string> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not authenticated");
  const { data: me, error } = await supabase
    .from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (error || !me) throw new Error("User not linked to a tenant");
  return me.tenant_id;
}

// ── Employees ───────────────────────────────────────────────────────────────
export function useEmployees() {
  return useQuery({
    queryKey: ["employees"],
    queryFn: async (): Promise<Employee[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("employees")
        .select(EMPLOYEE_COLUMNS)
        .order("is_active", { ascending: false })
        .order("name", { ascending: true });
      if (error) throw error;
      return (data ?? []) as Employee[];
    },
  });
}

export function useUpsertEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id?: string; name: string; monthly_gross: number; joining_date?: string | null;
      leave_allowance?: number; pan?: string | null; pf_no?: string | null; esi_no?: string | null;
      esi_applicable?: boolean; pf_applicable?: boolean; is_active?: boolean; notes?: string | null;
      basic_monthly?: number | null; da_monthly?: number;
      email?: string | null; phone?: string | null; designation?: string | null;
      date_of_birth?: string | null; address?: string | null;
      emergency_contact_name?: string | null; emergency_contact_phone?: string | null;
    }) => {
      const supabase = createClient();
      if (input.id) {
        const { id, ...patch } = input;
        const { error } = await supabase.from("employees").update(patch).eq("id", id);
        if (error) throw error;
        return id;
      }
      const tid = await tenantId();
      const { data, error } = await supabase.from("employees").insert({ ...input, tenant_id: tid }).select("id").single();
      if (error) throw error;
      return (data as { id: string }).id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      toast.success("Employee saved");
    },
    onError: (err) => toastError(err),
  });
}

/** Delete an employee. Blocked if they have salary history (deactivate instead
 *  so payroll records stay intact). Fresh employees delete cleanly (their
 *  attendance/leave cascade away). */
export function useDeleteEmployee() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { count, error: cErr } = await supabase
        .from("salary_payments").select("id", { count: "exact", head: true }).eq("employee_id", id);
      if (cErr) throw cErr;
      if ((count ?? 0) > 0) {
        throw new Error("This employee has salary payments on record. Set them Inactive (Edit) instead of deleting, so your payroll history stays intact.");
      }
      const { error } = await supabase.from("employees").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      qc.invalidateQueries({ queryKey: ["attendance"] });
      qc.invalidateQueries({ queryKey: ["leave-entries"] });
      toast.success("Employee removed");
    },
    onError: (err) => toastError(err),
  });
}

// ── Employee documents (ID / resume vault) ──────────────────────────────────
export type EmployeeDocument = Database["public"]["Tables"]["employee_documents"]["Row"];

export const EMPLOYEE_DOC_TYPES: { value: string; label: string }[] = [
  { value: "aadhaar",      label: "Aadhaar card" },
  { value: "pan",          label: "PAN card" },
  { value: "voter_id",     label: "Voter ID" },
  { value: "resume",       label: "Resume / CV" },
  { value: "offer_letter", label: "Offer letter" },
  /* The exit set (27 Sep 2026) — the offboarding checklist looks for "relieving_letter". */
  { value: "appointment_letter", label: "Appointment letter" },
  { value: "nda",                label: "NDA / agreement" },
  { value: "resignation",        label: "Resignation letter" },
  { value: "relieving_letter",   label: "Relieving / experience letter" },
  { value: "form16",             label: "Form 16" },
  { value: "other",        label: "Other" },
];
export const EMPLOYEE_DOC_BUCKET = "employee-docs";

export function useEmployeeDocuments(employeeId: string | null | undefined) {
  return useQuery({
    queryKey: ["employee-documents", employeeId ?? "none"],
    enabled: Boolean(employeeId),
    queryFn: async (): Promise<EmployeeDocument[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("employee_documents").select("*")
        .eq("employee_id", employeeId!)
        .order("uploaded_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as EmployeeDocument[];
    },
  });
}

export function useUploadEmployeeDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { employeeId: string; docType: string; file: File }) => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      const tid = await tenantId();
      const safeName = input.file.name.replace(/[^\w.\-]+/g, "_").slice(-80);
      const path = `${tid}/${input.employeeId}/${crypto.randomUUID()}-${safeName}`;
      const { error: upErr } = await supabase.storage
        .from(EMPLOYEE_DOC_BUCKET)
        .upload(path, input.file, { contentType: input.file.type || undefined, upsert: false });
      if (upErr) throw new Error(upErr.message);
      const { error: insErr } = await supabase.from("employee_documents").insert({
        tenant_id:   tid,
        employee_id: input.employeeId,
        doc_type:    input.docType,
        file_name:   input.file.name,
        file_path:   path,
        mime_type:   input.file.type || null,
        size_bytes:  input.file.size,
        uploaded_by: authData?.user?.id ?? null,
      });
      if (insErr) {
        // Roll back the orphaned object if the row insert fails.
        await supabase.storage.from(EMPLOYEE_DOC_BUCKET).remove([path]);
        throw new Error(insErr.message);
      }
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["employee-documents", v.employeeId] });
      toast.success("Document uploaded");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteEmployeeDocument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (doc: EmployeeDocument) => {
      const supabase = createClient();
      await supabase.storage.from(EMPLOYEE_DOC_BUCKET).remove([doc.file_path]);
      const { error } = await supabase.from("employee_documents").delete().eq("id", doc.id);
      if (error) throw error;
    },
    onSuccess: (_d, doc) => {
      qc.invalidateQueries({ queryKey: ["employee-documents", doc.employee_id] });
      toast.success("Document removed");
    },
    onError: (err) => toastError(err),
  });
}

/** Short-lived signed URL to view/download an employee document (bucket is private). */
export async function getEmployeeDocUrl(path: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.storage.from(EMPLOYEE_DOC_BUCKET).createSignedUrl(path, 60 * 5);
  return data?.signedUrl ?? null;
}

// ── Leave ─────────────────────────────────────────────────────────────────
export function useLeaveEntries() {
  return useQuery({
    queryKey: ["leave-entries"],
    queryFn: async (): Promise<LeaveEntry[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("leave_entries")
        .select("*")
        .order("from_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as LeaveEntry[];
    },
  });
}

export function useCreateLeaveEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employee_id: string; from_date: string; to_date: string; days: number; type: LeaveKind; notes?: string | null;
    }) => {
      const supabase = createClient();
      const tid = await tenantId();
      const { error } = await supabase.from("leave_entries").insert({ ...input, tenant_id: tid });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["leave-entries"] });
      toast.success("Leave recorded");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteLeaveEntry() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("leave_entries").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["leave-entries"] }); toast.success("Leave removed"); },
    onError: (err) => toastError(err),
  });
}

// ── Company holidays ─────────────────────────────────────────────────────────
export type Holiday = Database["public"]["Tables"]["holidays"]["Row"];

/** Company holidays, newest first. Excluded from payroll "working days" so an
 *  absence on a holiday is never counted as loss-of-pay. */
export function useHolidays() {
  return useQuery({
    queryKey: ["holidays"],
    queryFn: async (): Promise<Holiday[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.from("holidays").select("*").order("holiday_date", { ascending: false });
      if (error) throw error;
      return (data ?? []) as Holiday[];
    },
    staleTime: 60_000,
  });
}

export function useCreateHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { holiday_date: string; name: string }) => {
      const supabase = createClient();
      const tid = await tenantId();
      const { error } = await supabase.from("holidays").insert({ ...input, tenant_id: tid });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["holidays"] }); toast.success("Holiday added"); },
    onError: (err) => toastError(err),
  });
}

export function useDeleteHoliday() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("holidays").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["holidays"] }); toast.success("Holiday removed"); },
    onError: (err) => toastError(err),
  });
}

// ── Salary payments ─────────────────────────────────────────────────────────
export function useSalaryPayments(period?: string) {
  return useQuery({
    queryKey: ["salary-payments", period ?? "all"],
    queryFn: async (): Promise<SalaryPayment[]> => {
      const supabase = createClient();
      let q = supabase.from("salary_payments").select("*").order("period", { ascending: false });
      if (period) q = q.eq("period", period);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as SalaryPayment[];
    },
  });
}


/** Salaries not yet fully cleared (unpaid or partially paid), with the still-
 *  owed remaining amount — fed to the reconcile dialog so a money-out bank line
 *  can be applied (fully or partially) to a chosen salary. */
export type UnreconciledSalary = {
  id: string; period: string; pay_date: string;
  net: number; paid_amount: number; remaining: number;
  paid_status: "unpaid" | "partial" | "paid"; employee_name: string;
};
export function useUnreconciledSalaries() {
  return useQuery({
    queryKey: ["salary-payments", "unreconciled"],
    queryFn: async (): Promise<UnreconciledSalary[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("salary_payments")
        .select("id, period, pay_date, net, paid_amount, paid_status, employee_id")
        .in("paid_status", ["unpaid", "partial"])
        .order("pay_date", { ascending: false });
      if (error) throw error;
      const rows = data ?? [];
      const empIds = [...new Set(rows.map((r) => r.employee_id))];
      let names = new Map<string, string>();
      if (empIds.length) {
        const { data: emps } = await supabase.from("employees").select("id, name").in("id", empIds);
        names = new Map((emps ?? []).map((e) => [e.id, e.name]));
      }
      return rows.map((r) => ({
        id: r.id, period: r.period, pay_date: r.pay_date,
        net: r.net, paid_amount: r.paid_amount, remaining: Math.max(0, r.net - r.paid_amount),
        paid_status: r.paid_status, employee_name: names.get(r.employee_id) ?? "Employee",
      }));
    },
    staleTime: 30_000,
  });
}

/** Every salary payment for ONE employee, oldest→newest. Feeds the per-employee
 *  full-year payroll calendar (click an employee's name on the payroll page). */
export function useEmployeeSalaryHistory(employeeId: string | null) {
  return useQuery({
    queryKey: ["salary-payments", "employee", employeeId ?? "none"],
    enabled: Boolean(employeeId),
    queryFn: async (): Promise<SalaryPayment[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("salary_payments").select("*")
        .eq("employee_id", employeeId!)
        .order("period", { ascending: true });
      if (error) throw error;
      return (data ?? []) as SalaryPayment[];
    },
  });
}

export function usePaySalary() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      employeeId: string; period: string; payDate: string; gross: number;
      lopDays: number; lopAmount: number; incentive?: number; advanceRecovered: number; advanceLoanId?: string | null;
      tds: number; pf: number; esi: number; esiEmployer?: number; pfEmployer?: number; other: number; bankAccountId: string; notes?: string | null;
      /** The PF wage the form computed (Basic + DA prorated) — kept on the payslip for the ECR. */
      pfWage?: number | null;
    }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("pay_salary", {
        p_employee_id:       input.employeeId,
        p_period:            input.period,
        p_pay_date:          input.payDate,
        p_gross:             input.gross,
        p_lop_days:          input.lopDays,
        p_lop_amount:        input.lopAmount,
        p_incentive:         input.incentive ?? 0,
        p_advance_recovered: input.advanceRecovered,
        p_advance_loan_id:   input.advanceRecovered > 0 ? (input.advanceLoanId ?? null) : null,
        p_tds:               input.tds,
        p_pf:                input.pf,
        p_esi:               input.esi,
        p_esi_employer:      input.esiEmployer ?? 0,
        p_pf_employer:       input.pfEmployer ?? 0,
        p_pf_wage:           input.pfWage ?? null,
        p_other:             input.other,
        p_bank_account_id:   input.bankAccountId,
        p_notes:             input.notes ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-payments"] });
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["statutory-dues"] });
      toast.success("Salary paid");
    },
    onError: (err) => toastError(err),
  });
}

/** Undo a salary payment (only while unpaid + not bank-reconciled). Atomic
 *  reversal via the RPC: restores any advance recovery, deletes the booked
 *  Salaries expense, removes the salary_payment — so the row reverts to
 *  "Pay salary". (migration 0120) */
export function useDeleteSalaryPayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (salaryId: string) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("delete_salary_payment", { p_salary_id: salaryId });
      if (error) throw new Error(error.message);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["salary-payments"] });
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["statutory-dues"] });
      toast.success("Salary undone — you can pay it again");
    },
    // Blocked (bank-reconciled)? Point to Banking to un-reconcile first.
    onError: (err) => guardErrorToast(err, { label: "Open Banking", href: "/accounting/banking" }),
  });
}

// ── Statutory dues (withheld TDS/PF/ESI vs paid) ─────────────────────────────
export function useStatutoryDues() {
  return useQuery({
    queryKey: ["statutory-dues"],
    queryFn: async (): Promise<DuesSummary> => {
      const supabase = createClient();
      /* Salary TDS/PF/ESI (both shares) + TDS withheld on vendor payments (26Q), less
         every challan — lib/accounting/tds-deductor.ts. The Balance Sheet uses the same sum. */
      const [{ data: sal, error: sErr }, { data: paid, error: pErr }, { data: vt, error: vErr }] = await Promise.all([
        supabase.from("salary_payments").select("tds, pf, esi, esi_employer, pf_employer"),
        supabase.from("statutory_dues_payments").select("kind, amount"),
        supabase.from("expenses").select("tds_amount").gt("tds_amount", 0),
      ]);
      if (sErr) throw sErr;
      if (pErr) throw pErr;
      if (vErr) throw vErr;
      return statutoryDues({
        salaries: sal ?? [],
        vendorTds: (vt ?? []).reduce((s, r) => s + (r.tds_amount ?? 0), 0),
        paid: paid ?? [],
      });
    },
    staleTime: 30_000,
  });
}

export interface EsiRegisterRow {
  period: string;
  employee: string;
  esiNo: string | null;
  employeeShare: number;
  employerShare: number;
  total: number;
  wage: number;   // ESI wage base for the month (gross − LOP) — the ESIC upload figure
  days: number;   // paid days in the month (days in month − LOP days)
}
export interface EsiRegister {
  rows: EsiRegisterRow[];
  accrued: number; // employee + employer ESI booked across all payslips
  paid: number; // ESIC challans recorded (kind = esi)
  outstanding: number;
}

/** ESI register — every payslip that carried an ESI contribution, newest first,
 *  plus accrued-vs-paid totals. Feeds the ESI Register report (owner + CA). */
export function useEsiRegister() {
  return useQuery({
    queryKey: ["esi-register"],
    queryFn: async (): Promise<EsiRegister> => {
      const supabase = createClient();
      const { data: sal, error } = await supabase
        .from("salary_payments")
        .select("period, esi, esi_employer, employee_id, gross, lop_days, lop_amount")
        .or("esi.gt.0,esi_employer.gt.0")
        .order("period", { ascending: false });
      if (error) throw error;

      const { data: emps } = await supabase.from("employees").select("id, name, esi_no");
      const empMap = new Map((emps ?? []).map((e) => [e.id, e]));

      const rows: EsiRegisterRow[] = (sal ?? []).map((r) => {
        const e = empMap.get(r.employee_id);
        const employeeShare = r.esi ?? 0;
        const employerShare = r.esi_employer ?? 0;
        const [yy, mm] = r.period.split("-").map(Number);
        const daysInMonth = yy && mm ? new Date(yy, mm, 0).getDate() : 30;
        return {
          period: r.period,
          employee: e?.name ?? "—",
          esiNo: e?.esi_no ?? null,
          employeeShare,
          employerShare,
          total: employeeShare + employerShare,
          wage: Math.max(0, (r.gross ?? 0) - (r.lop_amount ?? 0)),
          days: Math.max(0, daysInMonth - Math.round(Number(r.lop_days ?? 0))),
        };
      });

      const { data: paidRows } = await supabase
        .from("statutory_dues_payments").select("amount, kind").eq("kind", "esi");
      const paid = (paidRows ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
      const accrued = rows.reduce((s, r) => s + r.total, 0);
      return { rows, accrued, paid, outstanding: Math.max(0, accrued - paid) };
    },
    staleTime: 30_000,
  });
}

export interface PfRegisterRow {
  period: string; employee: string; uan: string | null;
  gross: number; lopAmount: number; lopDays: number;
  pfWage: number | null;         // null = payslip from before 20260927180000
  employeeShare: number; employerShare: number; total: number;
}
export interface PfRegister { rows: PfRegisterRow[]; accrued: number; paid: number; outstanding: number }

/** PF register — every payslip that carried a PF contribution, newest first, with
 *  accrued-vs-paid; feeds the EPFO ECR export (lib/payroll/ecr.ts). */
export function usePfRegister() {
  return useQuery({
    queryKey: ["pf-register"],
    queryFn: async (): Promise<PfRegister> => {
      const supabase = createClient();
      const { data: sal, error } = await supabase
        .from("salary_payments")
        .select("period, pf, pf_employer, pf_wage, employee_id, gross, lop_days, lop_amount")
        .or("pf.gt.0,pf_employer.gt.0")
        .order("period", { ascending: false });
      if (error) throw error;
      const { data: emps } = await supabase.from("employees").select("id, name, pf_no");
      const empMap = new Map((emps ?? []).map((e) => [e.id, e]));
      const rows: PfRegisterRow[] = (sal ?? []).map((r) => {
        const e = empMap.get(r.employee_id);
        return {
          period: r.period, employee: e?.name ?? "—", uan: e?.pf_no ?? null,
          gross: r.gross ?? 0, lopAmount: r.lop_amount ?? 0, lopDays: Number(r.lop_days ?? 0),
          pfWage: r.pf_wage ?? null,
          employeeShare: r.pf ?? 0, employerShare: r.pf_employer ?? 0, total: (r.pf ?? 0) + (r.pf_employer ?? 0),
        };
      });
      const { data: paidRows } = await supabase.from("statutory_dues_payments").select("amount, kind").eq("kind", "pf");
      const paid = (paidRows ?? []).reduce((s, r) => s + (r.amount ?? 0), 0);
      const accrued = rows.reduce((s, r) => s + r.total, 0);
      return { rows, accrued, paid, outstanding: Math.max(0, accrued - paid) };
    },
    staleTime: 30_000,
  });
}

// ── Attendance ──────────────────────────────────────────────────────────────
export function useAttendance(period?: string) {
  return useQuery({
    queryKey: ["attendance", period ?? "all"],
    queryFn: async (): Promise<Attendance[]> => {
      const supabase = createClient();
      let q = supabase.from("attendance").select("*").order("work_date", { ascending: false });
      /* R-604: was `.lte(`${period}-31`)` — Postgres rejects "2026-09-31" (400), so every
         30-day month and February loaded NO attendance and payroll suggested a whole month
         of loss-of-pay. monthBounds gives the real next-month start. */
      if (period) {
        const { start, nextStart } = monthBounds(period);
        q = q.gte("work_date", start).lt("work_date", nextStart);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as Attendance[];
    },
    staleTime: 15_000,
  });
}

export type AttendanceCorrection = {
  employeeId: string;
  workDate: string;          // YYYY-MM-DD (IST day)
  checkIn: string | null;    // ISO instant; both null = mark absent
  checkOut: string | null;
  note: string;
};

/** R-603 / R-439: the OWNER fixes one employee-day (missed punch, forgotten
 *  checkout, or mark absent). The RPC checks role, tenant, note, times and date again. */
export function useCorrectAttendance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (v: AttendanceCorrection): Promise<string> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("correct_attendance", {
        p_employee_id: v.employeeId,
        p_work_date: v.workDate,
        p_check_in: v.checkIn,
        p_check_out: v.checkOut,
        p_note: v.note.trim(),
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (result) => {
      toast.success(result === "absent" ? "Marked absent" : "Attendance saved");
      void qc.invalidateQueries({ queryKey: ["attendance"] });
    },
    onError: (err: unknown) => toastError(err, { fallback: "Could not fix attendance." }),
  });
}

/** Short-lived signed URL for an attendance selfie (tenant-scoped by storage RLS). */
export async function getSelfieUrl(path: string): Promise<string | null> {
  const supabase = createClient();
  const { data } = await supabase.storage.from("attendance-selfies").createSignedUrl(path, 60 * 30);
  return data?.signedUrl ?? null;
}

export function useSetEmployeePin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { employeeId: string; pin: string }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("set_employee_pin", { p_employee_id: input.employeeId, p_pin: input.pin });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["employees"] }); toast.success("PIN set"); },
    onError: (err) => toastError(err),
  });
}

export function useMarkAttendance() {
  const qc = useQueryClient();
  return useMutation({
    // Goes through the API route so the office-network (IP) gate is enforced
    // server-side with the real client IP.
    mutationFn: async (input: { employeeId: string; pin: string; photo?: string | null }): Promise<string> => {
      const res = await fetch("/api/attendance/mark", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ employeeId: input.employeeId, pin: input.pin, photo: input.photo ?? null }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Could not mark attendance");
      return json.action as string;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["attendance"] }); },
    // errors surfaced by the caller (kiosk shows inline feedback)
  });
}

export function useAttendanceNetwork() {
  return useQuery({
    queryKey: ["attendance-network"],
    queryFn: async () => {
      const res = await fetch("/api/attendance/network");
      if (!res.ok) throw new Error("Failed to load network settings");
      return res.json() as Promise<{ allowedIps: string[]; currentIp: string; onAllowedNetwork: boolean; requireSelfie: boolean; requirePresence: boolean; retentionDays: number; requireFaceMatch: boolean; selfCheckIn?: { ok: true; outsideOffice: boolean } | { ok: false; error: string } }>;
    },
    staleTime: 10_000,
  });
}

/** R-605: owner turns "Can mark from outside office" on/off for one employee. */
export function useSetAttendanceAnywhere() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { employeeId: string; value: boolean }) => {
      const res = await fetch("/api/attendance/anywhere", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? "Could not save");
    },
    onSuccess: (_d, v) => {
      qc.invalidateQueries({ queryKey: ["employees"] });
      toast.success(v.value ? "Can now mark from outside the office" : "Office Wi-Fi only");
    },
    onError: (e: unknown) => toastError(e, { fallback: "Could not save. Nothing was changed." }),
  });
}

export function useSetAttendanceNetwork() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { action: "lock" | "clear" | "remove" | "require_selfie" | "require_presence" | "set_retention" | "require_face_match"; ip?: string; value?: boolean | number }) => {
      const res = await fetch("/api/attendance/network", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error ?? "Failed");
      return json as { allowedIps: string[]; currentIp: string };
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["attendance-network"] }); toast.success("Attendance network updated"); },
    onError: (e) => toastError(e),
  });
}

export function usePayStatutoryDues() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { amount: number; kind: string; paidOn: string; bankAccountId: string; notes?: string | null; challanNo?: string | null; period?: string | null }) => {
      const supabase = createClient();
      const { error } = await supabase.rpc("pay_statutory_dues", {
        p_amount:          input.amount,
        p_kind:            input.kind,
        p_paid_on:         input.paidOn,
        p_bank_account_id: input.bankAccountId,
        p_notes:           input.notes ?? null,
        p_challan_no:      input.challanNo ?? null,
        p_period:          input.period ?? null,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["statutory-dues"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      toast.success("Statutory dues paid");
    },
    onError: (err) => toastError(err),
  });
}
