/**
 * R-2674: "Due back within 12 months?" — where a loan shows on the Balance Sheet (current vs
 * non-current asset). The rule is SQL (migration 20261111201800_r2674_loans_current_split.sql):
 *   loans_given_current_parts()  per loan given: principal left, current part, why
 *   set_loan_due_within_12m()    the owner's / accountant's answer (loan given with no due date, or a staff loan)
 * The Balance Sheet totals come from loans_current_split() in balance-sheet.ts.
 * All three are newer than database.generated.ts → untyped client.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { LoanGivenCurrentPart } from "@/lib/accounting/loans-current-split";

export type LoanChoiceKind = "loan_given" | "employee_loan";

/** "Not on this database yet": function (PGRST202 / 42883) or column (42703) from before the migration. */
function notInstalled(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "PGRST202" || code === "42883" || code === "42703";
}

/** Per loan given: where it shows on the Balance Sheet. null = the database does not have R-2674 yet (hide the control). */
export function useLoanGivenCurrentParts(enabled = true) {
  return useQuery({
    queryKey: ["loans-given", "current-parts"],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<Map<string, LoanGivenCurrentPart> | null> => {
      const supabase = createClient() as unknown as SupabaseClient;
      let rows: LoanGivenCurrentPart[];
      try {
        // Paged + ordered: one row per loan (closed ones too), past the gateway cap of 1000 rows.
        rows = await fetchAllRows<LoanGivenCurrentPart>((from, to) => supabase
          .rpc("loans_given_current_parts", {}).order("loan_id", { ascending: true }).range(from, to) as never);
      } catch (e) {
        if (notInstalled(e)) return null;
        throw e;
      }
      const out = new Map<string, LoanGivenCurrentPart>();
      for (const r of rows) {
        out.set(r.loan_id, { ...r, principal_left: Number(r.principal_left) || 0, current_part: Number(r.current_part) || 0 });
      }
      return out;
    },
  });
}

/** Staff loans the owner marked "due after 12 months" (ids). null = the database does not have R-2674 yet. */
export function useStaffLoansNonCurrent(enabled = true) {
  return useQuery({
    queryKey: ["employee-loans", "non-current"],
    enabled,
    staleTime: 30_000,
    queryFn: async (): Promise<Set<string> | null> => {
      const supabase = createClient() as unknown as SupabaseClient;
      try {
        const rows = await fetchAllRows<{ id: string }>((from, to) => supabase
          .from("employee_loans").select("id").eq("due_within_12m", false)
          .order("id", { ascending: true }).range(from, to) as never);
        return new Set(rows.map((r) => r.id));
      } catch (e) {
        if (notInstalled(e)) return null;
        throw e;
      }
    },
  });
}

export function useSetLoanDueWithin12m() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { kind: LoanChoiceKind; loanId: string; dueWithin: boolean }): Promise<boolean> => {
      const supabase = createClient() as unknown as SupabaseClient;
      const { data, error } = await supabase.rpc("set_loan_due_within_12m", {
        p_kind: input.kind, p_loan_id: input.loanId, p_due_within: input.dueWithin,
      });
      if (error) throw new Error(error.message);
      return data === true;
    },
    onSuccess: (_changed, input) => {
      qc.invalidateQueries({ queryKey: ["loans-given"] });
      qc.invalidateQueries({ queryKey: ["employee-loans"] });
      qc.invalidateQueries({ queryKey: ["balance-sheet"] });
      toast.success(input.dueWithin
        ? "Saved — shown under Current assets on the Balance Sheet"
        : "Saved — shown as a non-current asset on the Balance Sheet");
    },
    onError: (err) => toastError(err, { fallback: "Couldn't save the answer", description: "Nothing was changed. Try again." }),
  });
}
