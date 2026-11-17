/**
 * R-1831 / R-2894: unlinked money-out bank lines whose amount equals one of these salaries' net —
 * the fact behind "Paid — link bank line" (lib/payroll/salary-status.ts). Keyed by whole rupees →
 * EVERY such line (date, narration, bank account), oldest first; salaryCandidates() orders them
 * nearest a salary's pay date. It used to be ONE account id per amount (first by id), so a second
 * same-amount line — the other month's — was never offered (Hitesh, 16 Nov).
 *
 * Lives beside queries/payroll.ts (not in it) so it does not clash with a card that is changing that
 * file; the old one-per-amount useUnlinkedSalaryBankLines there is unused now — remove it.
 * Only lines on or after `since` (the first salary month's first day) count — an older line cannot
 * pay this month. Same tenant, never a line already linked.
 */
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import { groupWaitingBankLines, type WaitingBankLine } from "@/lib/payroll/salary-bank-link";

async function myTenantId(): Promise<string> {
  const supabase = createClient();
  const { data: authData } = await supabase.auth.getUser();
  if (!authData?.user) throw new Error("Not authenticated");
  const { data: me, error } = await supabase.from("users").select("tenant_id").eq("id", authData.user.id).single();
  if (error || !me) throw new Error("User not linked to a tenant");
  return me.tenant_id;
}

export function useUnlinkedSalaryBankLines(nets: number[], since: string | null) {
  const amounts = [...new Set(nets.filter((n) => n > 0).map((n) => Math.round(n)))].sort((a, b) => a - b);
  return useQuery({
    queryKey: ["bank_transactions", "unlinked-salary-lines", since ?? "", amounts.join(",")],
    enabled: amounts.length > 0 && Boolean(since),
    queryFn: async (): Promise<Map<number, WaitingBankLine[]>> => {
      const supabase = createClient();
      const tid = await myTenantId();
      const rows = await fetchAllRows<WaitingBankLine & { tenant_id: string; matched_to_type: string | null }>((from, to) => supabase
        .from("bank_transactions")
        .select("id, debit, bank_account_id, txn_date, description, tenant_id, matched_to_type")
        .eq("tenant_id", tid)
        .is("matched_to_type", null)
        .in("debit", amounts)
        .gte("txn_date", since!)
        .order("id", { ascending: true })
        .range(from, to));
      /* A salary's own reconciled line is linked even if the line row says nothing. */
      const ids = rows.map((r) => r.id);
      const linked = new Set<string>();
      for (let i = 0; i < ids.length; i += 150) {
        const { data, error } = await supabase.from("salary_payments").select("reconciled_txn_id").in("reconciled_txn_id", ids.slice(i, i + 150));
        if (error) throw error;
        for (const r of data ?? []) if (r.reconciled_txn_id) linked.add(r.reconciled_txn_id as string);
      }
      return groupWaitingBankLines(rows, tid, linked);
    },
    staleTime: 30_000,
  });
}
