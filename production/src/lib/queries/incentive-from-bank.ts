/**
 * R-1839 (Pardeep, 24 Oct: "koi payment employee ko incentive dete hai uski bhi to ho sakti
 * hai") — a bank debit that is an employee's incentive / bonus, booked through payroll by
 * book_bank_txn_as_incentive (migration 20261024142228_r1839_owner_equity.sql):
 *   (a) the month has a salary record → the incentive is added to it (Bonus column, TDS, net,
 *       the month's Salaries expense); (b) none → a one-off payroll record via pay_salary.
 * Either way it is salary: payslip, Salary Register, TDS u/s 192, Form 16, P&L Salaries.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { toastError } from "@/lib/errors/toast-error";
import { payeeFromNarration } from "@/lib/banking/narration";
import { matchEmployee } from "@/lib/banking/salary-lines";

const untyped = () => createClient() as unknown as SupabaseClient;

/** The employee a bank narration names: the payee slot first, else one employee whose name is in the text. */
export function suggestEmployee(description: string | null | undefined, employees: ReadonlyArray<{ id: string; name: string; is_active?: boolean }>): string {
  const list = employees.filter((e) => e.is_active !== false);
  const m = matchEmployee(payeeFromNarration(description), list);
  if (m.kind === "match") return m.id;
  const text = ` ${(description ?? "").toUpperCase().replace(/[^A-Z]+/g, " ")} `;
  const hits = list.filter((e) => {
    const first = e.name.toUpperCase().replace(/[^A-Z ]+/g, " ").trim().split(/\s+/)[0] ?? "";
    return first.length >= 3 && text.includes(` ${first} `);
  });
  return hits.length === 1 ? hits[0].id : "";
}

/** The employee's salary record for that month, if any — decides "add to the month" vs "one-off". */
export function useSalaryRecordFor(employeeId: string, period: string) {
  return useQuery({
    queryKey: ["salary_payments", "for-incentive", employeeId, period],
    enabled: Boolean(employeeId) && /^\d{4}-\d{2}$/.test(period),
    queryFn: async () => {
      const { data, error } = await untyped()
        .from("salary_payments")
        .select("id, gross, incentive, tds, net, paid_status")
        .eq("employee_id", employeeId)
        .eq("period", period)
        .maybeSingle();
      if (error) throw new Error(error.message);
      return data as { id: string; gross: number; incentive: number | null; tds: number; net: number; paid_status: string } | null;
    },
  });
}

export function useBookBankTxnAsIncentive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { transactionId: string; employeeId: string; period: string; tds: number }) => {
      const { data, error } = await untyped().rpc("book_bank_txn_as_incentive", {
        p_txn_id: input.transactionId,
        p_employee_id: input.employeeId,
        p_period: input.period,
        p_tds: input.tds,
      });
      if (error) throw new Error(error.message);
      return data as { salary_id: string; mode: "added_to_month" | "one_off"; incentive: number; tds: number; paid: number };
    },
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["bank_transactions"] });
      qc.invalidateQueries({ queryKey: ["bank_accounts"] });
      qc.invalidateQueries({ queryKey: ["salary_payments"] });
      qc.invalidateQueries({ queryKey: ["expenses"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(res?.mode === "added_to_month"
        ? "Incentive added to that month's salary & reconciled — it is on the payslip"
        : "Incentive booked in Payroll & reconciled — it is on the payslip");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't book the incentive" }),
  });
}
