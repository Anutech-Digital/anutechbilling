/**
 * R-1586: the 24Q (salary TDS) export's reads — every salary payment of the quarter, every
 * employee and every challan, not the first 1000 of each.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. A 24Q missing deductees is a
 * short TDS return.
 */
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import type { createClient } from "@/lib/supabase/client";

export async function read24Q(supabase: ReturnType<typeof createClient>, periods: string[]) {
  const pays = await fetchAllRows((from, to) => supabase
    .from("salary_payments")
    .select("employee_id, period, pay_date, gross, lop_amount, incentive, tds")
    .in("period", periods)
    .order("id", { ascending: true })
    .range(from, to));
  if (!pays.length) return { pays, emps: [], challans: [] };
  const emps = await fetchAllRowsIn(pays.map((p) => p.employee_id), (run, from, to) => supabase
    .from("employees").select("id, name, pan").in("id", run)
    .order("id", { ascending: true })
    .range(from, to));
  /* Challan per month — the TDS (or mixed) statutory payment booked for that period
     (migration 20260927130000). The caller keeps the FIRST challan of a period; the old
     read had no order at all (whichever row the database gave first), so it is now the
     earliest paid one — paid_on, then id for a total order across pages. */
  const challans = await fetchAllRows((from, to) => supabase
    .from("statutory_dues_payments")
    .select("period, kind, challan_no, paid_on").in("period", periods).in("kind", ["tds", "mixed"])
    .order("paid_on", { ascending: true })
    .order("id", { ascending: true })
    .range(from, to));
  return { pays, emps, challans };
}
