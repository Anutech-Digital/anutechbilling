/**
 * R-2700: the company payroll policy (lib/payroll/policy.ts) — read by the employee form and the
 * CTC screens, saved by the owner from the Payroll policy card. Read through GET
 * /api/payroll/policy, which returns the defaults when nothing was saved, so a caller never
 * has to guess.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { DEFAULT_PAYROLL_POLICY, parsePayrollPolicy, policyToRow, type PayrollPolicy } from "@/lib/payroll/policy";

export const PAYROLL_POLICY_QUERY_KEY = ["payroll-policy"] as const;

export function usePayrollPolicy() {
  return useQuery({
    queryKey: PAYROLL_POLICY_QUERY_KEY,
    queryFn: async (): Promise<PayrollPolicy> => {
      const res = await fetch("/api/payroll/policy");
      if (!res.ok) throw new Error("Could not read the payroll policy");
      const json = (await res.json()) as { policy?: PayrollPolicy };
      // Same parser as the server — a half-shaped answer falls back field by field.
      return parsePayrollPolicy(json.policy ? policyToRow({ ...DEFAULT_PAYROLL_POLICY, ...json.policy }) : null);
    },
    staleTime: 10 * 60 * 1000,
  });
}

/** Owner: save the policy. The route refuses bad input with a sentence. */
export function useSavePayrollPolicy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (policy: PayrollPolicy) => {
      const res = await fetch("/api/payroll/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ policy }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((json as { error?: string }).error ?? "Could not save the payroll policy");
      return (json as { policy: PayrollPolicy }).policy;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: PAYROLL_POLICY_QUERY_KEY });
      toast.success("Payroll policy saved", { description: "New employees and the CTC calculator use it. Existing employees keep their own settings." });
    },
    onError: (e: Error) => {
      toastError(e, { description: "Nothing was changed.", fallback: "Could not save the payroll policy" });
    },
  });
}
