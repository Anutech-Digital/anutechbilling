/**
 * R-1586: the 26Q (non-salary TDS) export's reads — every TDS-deducted expense in the range
 * and every vendor behind them, not the first 1000.
 *
 * The data gateway answers at most 1000 rows a request (src/server/postgrest/build.ts
 * MAX_ROWS) and says nothing when it cut the answer short. A 26Q missing deductees is a
 * short TDS return.
 *
 * R-1580: also the TDS deducted on referral / channel-partner commissions (s.194H) — a
 * commission row with tds_amount > 0, not cancelled, credited (earned_date) in the range.
 * Before, those deductees were missing from the 26Q working altogether.
 */
import { fetchAllRows, fetchAllRowsIn } from "@/lib/ops/fetch-all";
import { panFromGstin } from "@/lib/accounting/tds-deductor";
import { TDS_SECTION_RATES } from "@/lib/accounting/tds-rates";
import type { createClient } from "@/lib/supabase/client";

export async function read26Q(supabase: ReturnType<typeof createClient>, range: { from: string; to: string }) {
  const [exps, comms] = await Promise.all([
    fetchAllRows((from, to) => supabase
      .from("expenses")
      .select("id, expense_date, vendor_name, vendor_id, amount, gst_paid, tds_section, tds_amount")
      .gte("expense_date", range.from).lte("expense_date", range.to)
      .gt("tds_amount", 0)
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRows((from, to) => supabase
      .from("referral_commissions")
      .select("id, partner_id, earned_date, gross_commission, tds_amount, status")
      .gte("earned_date", range.from).lte("earned_date", range.to)
      .gt("tds_amount", 0)
      .neq("status", "cancelled")
      .order("id", { ascending: true })
      .range(from, to)),
  ]);
  const [vends, partners] = await Promise.all([
    fetchAllRowsIn(exps.map((e) => e.vendor_id), (run, from, to) => supabase
      .from("vendors").select("id, gstin, pan").in("id", run)
      .order("id", { ascending: true })
      .range(from, to)),
    fetchAllRowsIn(comms.map((c) => c.partner_id), (run, from, to) => supabase
      .from("referral_partners").select("id, name, gstin, pan").in("id", run)
      .order("id", { ascending: true })
      .range(from, to)),
  ]);
  return { exps, vends, comms, partners };
}

/** Section 194H — commission / brokerage (lib/accounting/tds-rates.ts). */
export const COMMISSION_TDS_SECTION = TDS_SECTION_RATES["194H"].section;

export type Row26Q = [deductee: string, pan: string, section: string, date: string, amountPaid: number, tds: number];

/**
 * The 26Q working rows: expenses (amount ex-GST) + partner commissions (gross commission),
 * deductee-wise, sorted by name then date. PAN: the deductee's own, else lifted from a
 * well-formed GSTIN; "" when neither — counted in `missingPan`, never dropped.
 */
export function build26QRows(read: Awaited<ReturnType<typeof read26Q>>): { rows: Row26Q[]; totalTds: number; missingPan: number } {
  const panByVid = new Map<string, string>();
  for (const v of read.vends) panByVid.set(v.id, v.pan ?? panFromGstin(v.gstin) ?? "");
  const partnerById = new Map(read.partners.map((p) => [p.id, p]));
  const expRows = read.exps.map((e): Row26Q => [
    e.vendor_name ?? "—",
    e.vendor_id ? panByVid.get(e.vendor_id) ?? "" : "",
    e.tds_section ?? "",
    e.expense_date,
    (e.amount ?? 0) - (e.gst_paid ?? 0),   // amount on which TDS applies (ex-GST base)
    e.tds_amount ?? 0,
  ]);
  const commRows = read.comms.map((c): Row26Q => {
    const p = partnerById.get(c.partner_id);
    return [
      p?.name ?? "—",
      p ? p.pan ?? panFromGstin(p.gstin) ?? "" : "",
      COMMISSION_TDS_SECTION,
      c.earned_date,
      c.gross_commission ?? 0,              // commission credited — TDS base under 194H
      c.tds_amount ?? 0,
    ];
  });
  const rows = [...expRows, ...commRows]
    .sort((a, b) => a[0].localeCompare(b[0]) || a[3].localeCompare(b[3]));
  return {
    rows,
    totalTds: rows.reduce((s, r) => s + r[5], 0),
    missingPan: rows.filter((r) => !r[1]).length,
  };
}
