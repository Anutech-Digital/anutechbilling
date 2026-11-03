/**
 * Book salary bank lines: create (or find) the salary record for each employee +
 * month, then reconcile the bank line(s) against it.
 *
 * ─── IT REUSES THE PAYROLL PATH, IT DOES NOT COPY IT ────────────────────────
 * A new record goes through the same `pay_salary` RPC the Payroll screen uses, so the
 * Salaries expense is booked exactly as it would be there. The link goes through
 * `reconcile_bank_txn`, whose `sync_salary_paid_status` trigger moves the record to
 * paid / partial. Nothing here writes paid_status itself.
 *
 * ─── IT RE-CHECKS AT THE MOMENT OF WRITING ──────────────────────────────────
 * The preview was computed from a cached list. Before each group it reads the salary
 * record again: a month someone marked paid in the meantime is refused, not topped up.
 *
 * ─── ONE GROUP FAILING DOES NOT STOP THE OTHERS ─────────────────────────────
 * Each group is reported separately. If a record is created but its reconcile fails,
 * the record stays (unpaid, visible in Payroll) and the result says so — it is not
 * rolled back by hand from the browser, which could fail halfway itself.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { compactName, isFullAndFinalText } from "@/lib/banking/salary-lines";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";

export type SalaryGroupInput = {
  /** Existing employee, or a name to create one with. */
  employee: { id: string } | { createName: string; monthlyGross: number };
  /** YYYY-MM */
  period: string;
  lines: Array<{ txnId: string; txnDate: string; amount: number; description: string }>;
  /**
   * The part of the transfer that is an incentive / commission, not the month's salary —
   * booked as payroll's incentive (still salary for TDS / Form 16), so the gross reads as
   * the real monthly salary. Only used when a NEW salary record is created.
   */
  incentive?: number;
};

export type SalaryGroupResult = {
  period: string;
  label: string;
  ok: boolean;
  /** What happened, in words the operator can act on. */
  message: string;
  /** R-2428: who was paid (once known) — for the "Start exit?" prompt after a full & final. */
  employeeId?: string;
  /** R-2428: a line in this group reads as a full & final settlement. */
  fullAndFinal?: boolean;
  /** R-2428: the latest payment date in the group (the default last working day). */
  lastPayDate?: string;
  /** R-2428: what the group's lines paid. */
  paid?: number;
};

/** R-2428: the full & final settlements just booked → one "Start exit?" prompt each. */
export function fnfPromptsFrom(results: readonly SalaryGroupResult[]): Array<{ employeeId: string; lastDay: string; amount: number }> {
  const seen = new Set<string>();
  return results.flatMap((r) => {
    if (!r.ok || !r.fullAndFinal || !r.employeeId || !r.lastPayDate || seen.has(r.employeeId)) return [];
    seen.add(r.employeeId);
    return [{ employeeId: r.employeeId, lastDay: r.lastPayDate, amount: r.paid ?? 0 }];
  });
}

async function currentTenantId(supabase: ReturnType<typeof createClient>): Promise<string> {
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not signed in — sign in again and retry.");
  const { data: me, error } = await supabase
    .from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (error || !me) throw new Error("Your user is not linked to a company — ask the owner to check Team.");
  return me.tenant_id;
}

async function bookGroup(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
  g: SalaryGroupInput,
  tenantId: () => Promise<string>,
  /** Employees created earlier in this batch, by upper-cased name — created once. */
  createdIds: Map<string, string>,
): Promise<SalaryGroupResult> {
  const total = g.lines.reduce((s, l) => s + l.amount, 0);
  const incentive = Math.max(0, Math.round(g.incentive ?? 0));
  let label = "createName" in g.employee ? g.employee.createName : "employee";
  if (incentive >= total) {
    return { period: g.period, label, ok: false, message: `Incentive (₹${incentive}) must be less than the amount paid (₹${total}) — the rest is the salary.` };
  }

  /* 1. Employee */
  let employeeId: string;
  /* Letters only: "Hitesh Babu" and "Hites H Babu" must not become two employees. */
  const createKey = "createName" in g.employee ? compactName(g.employee.createName) : null;
  if ("createName" in g.employee && createKey && createdIds.has(createKey)) {
    employeeId = createdIds.get(createKey)!;
  } else if ("createName" in g.employee && createKey) {
    const { data, error } = await supabase
      .from("employees")
      .insert({ tenant_id: await tenantId(), name: g.employee.createName, monthly_gross: g.employee.monthlyGross })
      .select("id")
      .single();
    if (error) return { period: g.period, label, ok: false, message: `Could not create employee: ${error.message}` };
    employeeId = (data as { id: string }).id;
    createdIds.set(createKey, employeeId);
  } else if ("id" in g.employee) {
    employeeId = g.employee.id;
    const { data } = await supabase.from("employees").select("name").eq("id", employeeId).single();
    if (data) label = (data as { name: string }).name;
  } else {
    return { period: g.period, label, ok: false, message: "No employee chosen for this line." };
  }

  /* 2. Salary record — fresh read, not the preview's cache. */
  const { data: existing, error: exErr } = await supabase
    .from("salary_payments")
    .select("id, net, paid_amount, paid_status")
    .eq("employee_id", employeeId)
    .eq("period", g.period)
    .maybeSingle();
  if (exErr) return { period: g.period, label, ok: false, message: `Could not read the salary record: ${exErr.message}` };

  let salaryId: string;
  let created = false;
  if (existing) {
    const remaining = existing.net - existing.paid_amount;
    if (existing.paid_status === "paid" || remaining <= 0) {
      return { period: g.period, label, ok: false, message: `${g.period} salary is already marked paid — nothing was changed. If this line is a second payment, reconcile it by hand.` };
    }
    if (total > remaining) {
      return { period: g.period, label, ok: false, message: `The ${g.period} salary record has ₹${remaining} left to pay, but these lines total ₹${total}. Nothing was changed — check the record in Payroll.` };
    }
    salaryId = existing.id;
  } else {
    const payDate = g.lines.map((l) => l.txnDate).sort()[0];
    const { error: payErr } = await supabase.rpc("pay_salary", {
      p_employee_id: employeeId,
      p_period: g.period,
      p_pay_date: payDate,
      p_gross: total - incentive,
      p_lop_days: 0,
      p_lop_amount: 0,
      p_incentive: incentive,
      p_advance_recovered: 0,
      p_advance_loan_id: null,
      p_tds: 0,
      p_pf: 0,
      p_esi: 0,
      p_esi_employer: 0,
      p_pf_employer: 0,
      p_other: 0,
      p_bank_account_id: accountId,
      p_notes: `Created from bank line: ${g.lines.map((l) => l.description).join(" | ")}`,
    });
    if (payErr) return { period: g.period, label, ok: false, message: `Could not create the salary record: ${payErr.message}` };
    const { data: rec, error: recErr } = await supabase
      .from("salary_payments").select("id")
      .eq("employee_id", employeeId).eq("period", g.period).single();
    if (recErr || !rec) return { period: g.period, label, ok: false, message: "The salary record was created but could not be read back — reconcile the line by hand from Payroll." };
    salaryId = (rec as { id: string }).id;
    created = true;
  }

  /* 3. Reconcile each line — the trigger marks the record paid / partial. */
  let linked = 0;
  for (const l of g.lines) {
    const { error } = await supabase.rpc("reconcile_bank_txn", {
      p_txn_id: l.txnId,
      p_matched_to_type: "salary",
      p_matched_to_id: salaryId,
      p_match_confidence: "manual",
    });
    if (error) {
      return {
        period: g.period, label, ok: false,
        message: `${created ? "Salary record created, but " : ""}${linked} of ${g.lines.length} line(s) reconciled — the next failed: ${error.message}. The record stays in Payroll as unpaid/partial.`,
      };
    }
    linked++;
  }

  return {
    period: g.period, label, ok: true,
    employeeId,
    fullAndFinal: g.lines.some((l) => isFullAndFinalText(l.description)),
    lastPayDate: g.lines.map((l) => l.txnDate).sort().at(-1),
    paid: total,
    message: created
      ? `Salary record created (₹${total}) and ${linked} line${linked === 1 ? "" : "s"} reconciled.`
      : `${linked} line${linked === 1 ? "" : "s"} reconciled to the existing salary record.`,
  };
}

/**
 * Book every group in order. A new employee paid for several months is created by
 * the first group that names them and reused by the rest (keyed by upper-cased name).
 */
export async function bookSalaryGroups(
  supabase: ReturnType<typeof createClient>,
  accountId: string,
  groups: SalaryGroupInput[],
): Promise<SalaryGroupResult[]> {
  let tid: string | null = null;
  const tenantId = async () => (tid ??= await currentTenantId(supabase));
  const createdIds = new Map<string, string>();
  const results: SalaryGroupResult[] = [];
  for (const g of groups) results.push(await bookGroup(supabase, accountId, g, tenantId, createdIds));
  return results;
}

export function useBookSalaryLines() {
  const qc = useQueryClient();
  return useMutation({
    /* Sequential on purpose (see bookSalaryGroups): order is what lets a new employee
       be created once, and it keeps the results readable. */
    mutationFn: (input: { accountId: string; groups: SalaryGroupInput[] }): Promise<SalaryGroupResult[]> =>
      bookSalaryGroups(createClient(), input.accountId, input.groups),
    onSuccess: (results) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["salary-payments"] });
      qc.invalidateQueries({ queryKey: ["employees"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      const ok = results.filter((r) => r.ok).length;
      const failed = results.length - ok;
      if (failed === 0) toast.success(`${ok} salary ${ok === 1 ? "entry" : "entries"} booked and reconciled`);
      else toast.warning(`${ok} booked · ${failed} need attention — see the list`);
    },
    onError: (err) => toastError(err, { fallback: "Could not book the salary lines" }),
  });
}
