/**
 * Money out — every debit bank line with the payee and the "what" resolved from the
 * record it was reconciled to (lib/accounting/payments-made.ts).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { payeeFromNarration } from "@/lib/banking/narration";
import { groupOf, type PaidOutLine } from "@/lib/accounting/payments-made";
import { fetchAllRows, fetchAllRowsIn, type PageQuery } from "@/lib/ops/fetch-all";

type Client = ReturnType<typeof createClient>;

function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
}

type DebitLine = {
  id: string; txn_date: string; description: string | null; debit: number; reference: string | null;
  matched_to_type: string | null; matched_to_id: string | null; bank_account_id: string;
};

/**
 * The records a set of bank lines was reconciled to, by id. R-1519: IN_CHUNK ids a request and
 * paged (one `.in()` with 1,500 ids is a refused URL and, at best, a 1000-row answer). A failed
 * lookup still degrades to "no record" (the line keeps its narration), as it always did.
 */
function lookup<T>(ids: string[], page: (run: string[], from: number, to: number) => PageQuery<T>): Promise<{ data: T[] }> {
  if (!ids.length) return Promise.resolve({ data: [] });
  return fetchAllRowsIn<T, string>(ids, page).then((data) => ({ data }), () => ({ data: [] }));
}

/**
 * Every money-out line. R-1519: the debit lines are paged — `.limit(2000)` came back as 1000
 * rows (the gateway caps every answer at 1000 and says nothing), so Money out listed and
 * summed only the newest 1000. `id` breaks txn_date ties so no page repeats or skips a line.
 */
export async function fetchMoneyOut(supabase: Client): Promise<PaidOutLine[]> {
  const [txns, { data: accounts }] = await Promise.all([
    fetchAllRows<DebitLine>((from, to) => supabase.from("bank_transactions")
      .select("id, txn_date, description, debit, reference, matched_to_type, matched_to_id, bank_account_id")
      .gt("debit", 0).order("txn_date", { ascending: false }).order("id", { ascending: true })
      .range(from, to)),
    supabase.from("bank_accounts").select("id, name"),
  ]);
  const accountName = new Map((accounts ?? []).map((a) => [a.id, a.name]));
  const rows = txns.filter((t) => t.matched_to_type !== "transfer");

  const idsOf = (type: string) => rows.filter((t) => t.matched_to_type === type && t.matched_to_id).map((t) => t.matched_to_id as string);
  const expIds = idsOf("expense"), salIds = idsOf("salary").concat(idsOf("split")), billIds = idsOf("vendor_bill"),
    statIds = idsOf("statutory"), prepIds = idsOf("prepaid"), commIds = idsOf("referral_commission"),
    vendIds = idsOf("vendor_payment");   // R-1866: matched_to_id = the vendor

  const [exps, sals, bills, dues, taxes, preps, comms, vends] = await Promise.all([
    lookup<{ id: string; vendor_name: string | null; category: string; bill_no: string | null; description: string | null }>(expIds, (run, from, to) =>
      supabase.from("expenses").select("id, vendor_name, category, bill_no, description").in("id", run).order("id").range(from, to)),
    lookup<unknown>(salIds, (run, from, to) =>
      supabase.from("salary_payments").select("id, period, employee_id, employees!salary_payments_employee_id_fkey(name)").in("id", run).order("id").range(from, to)),
    lookup<{ id: string; vendor_name: string; bill_no: string | null }>(billIds, (run, from, to) =>
      supabase.from("vendor_bills").select("id, vendor_name, bill_no").in("id", run).order("id").range(from, to)),
    lookup<{ id: string; kind: string; period: string | null; challan_no: string | null }>(statIds, (run, from, to) =>
      supabase.from("statutory_dues_payments").select("id, kind, period, challan_no").in("id", run).order("id").range(from, to)),
    lookup<{ id: string; kind: string; period: string | null; fy: string | null }>(statIds, (run, from, to) =>
      supabase.from("tax_payments").select("id, kind, period, fy").in("id", run).order("id").range(from, to)),
    lookup<{ id: string; vendor_name: string; category: string }>(prepIds, (run, from, to) =>
      supabase.from("prepaid_advances").select("id, vendor_name, category").in("id", run).order("id").range(from, to)),
    lookup<unknown>(commIds, (run, from, to) =>
      supabase.from("referral_commissions").select("id, referral_partners(name)").in("id", run).order("id").range(from, to)),
    lookup<{ id: string; name: string }>(vendIds, (run, from, to) =>
      supabase.from("vendors").select("id, name").in("id", run).order("id").range(from, to)),
  ]);
  const vend = new Map(vends.data.map((v) => [v.id, v]));
  const exp = new Map(exps.data.map((e) => [e.id, e]));
  const sal = new Map((sals.data as { id: string; period: string; employees?: { name: string | null } | null }[]).map((s) => [s.id, s]));
  const bill = new Map(bills.data.map((b) => [b.id, b]));
  const due = new Map(dues.data.map((d) => [d.id, d]));
  const tax = new Map(taxes.data.map((t) => [t.id, t]));
  const prep = new Map(preps.data.map((p) => [p.id, p]));
  const comm = new Map((comms.data as { id: string; referral_partners?: { name: string | null } | null }[]).map((c) => [c.id, c]));

  const KIND: Record<string, string> = { tds: "TDS challan", pf: "PF (EPFO) challan", esi: "ESI challan", mixed: "TDS/PF/ESI challan", gst: "GST (3B) challan", advance_tax: "Advance tax", self_assessment_tax: "Self-assessment tax" };
  const narr = (d: string | null) => { const p = payeeFromNarration(d); return p ? titleCase(p) : (d ?? "").slice(0, 40) || "—"; };

  return rows.flatMap((t) => {
    const group = groupOf(t.matched_to_type);
    if (!group) return [];
    const id = t.matched_to_id ?? "";
    let payee = narr(t.description), what = "—", reference: string | null = t.reference ?? null;
    switch (t.matched_to_type) {
      case "expense": { const e = exp.get(id); if (e) { payee = e.vendor_name || payee; what = e.category; reference = e.bill_no ?? reference; } break; }
      case "vendor_payment": { const v = vend.get(id); if (v) payee = v.name; what = "Vendor payment"; break; }   // R-1866
      case "vendor_bill": { const b = bill.get(id); if (b) { payee = b.vendor_name; what = "Vendor bill"; reference = b.bill_no ?? reference; } break; }
      case "salary": case "split": { const s = sal.get(id); if (s) { payee = s.employees?.name ?? payee; what = `Salary ${s.period}${t.matched_to_type === "split" ? " (+ advance)" : ""}`; } else what = "Salary"; break; }
      case "statutory": {
        const d = due.get(id), x = tax.get(id);
        if (d) { payee = "Government"; what = `${KIND[d.kind] ?? d.kind}${d.period ? ` · ${d.period}` : ""}`; reference = d.challan_no ?? reference; }
        else if (x) { payee = "Government"; what = `${KIND[x.kind] ?? x.kind}${x.period ? ` · ${x.period}` : x.fy ? ` · FY ${x.fy}` : ""}`; }
        else what = "Statutory / tax";
        break;
      }
      case "prepaid": { const p = prep.get(id); if (p) { payee = p.vendor_name; what = `Advance (${p.category})`; } else what = "Advance"; break; }
      case "referral_commission": { const c = comm.get(id); payee = c?.referral_partners?.name ?? payee; what = "Referral commission"; break; }
      case "manual": what = "Capital / loan / EMI (hand-booked)"; break;
      case "project": what = "Project payment"; break;
      case "payment": what = "Customer refund"; break;
      default: what = t.matched_to_type ?? "Not reconciled";
    }
    return [{
      id: t.id, txn_date: t.txn_date, amount: t.debit, payee, what, reference,
      account: accountName.get(t.bank_account_id) ?? "—", group, matched_to_type: t.matched_to_type, matched_to_id: t.matched_to_id, description: t.description,
      bank_account_id: t.bank_account_id,
    } satisfies PaidOutLine];
  });
}

export function useMoneyOut() {
  return useQuery({
    queryKey: ["payments-made"],
    queryFn: (): Promise<PaidOutLine[]> => fetchMoneyOut(createClient()),
    staleTime: 30_000,
  });
}
