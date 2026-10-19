/**
 * ITR pack ka assembler — tables se `ItrSources` jodta hai, ginti lib/tax/itr.ts karta hai.
 *
 * ─── R-1579: "profit as per books" = P&L, ek hi source ─────────────────────
 * Pehle ye file apna P&L khud jodti thi (COGS purchase_orders se, saara gst_paid ghata kar,
 * commission / settlement bank charges ke bina, invoices / expenses bina paging) — aur ITR
 * ka profit P&L se alag aata tha. Ab revenue, COGS, kharche, commissions, bank charges aur
 * depreciation WAHI `report_pnl` (FY range) + `assemblePnl` se aate hain jo /accounting/pnl
 * ka hai (lib/tax/itr-from-pnl.ts). report_pnl SQL me jodta hai — koi 1000-row cap nahi.
 *
 * Is file ke apne reads sirf ITR wali cheezein hain, sab paged (fetchAllRows) ya sirf ginti:
 *  - Purchase orders (placed/provisioned/closed) — sirf NOTE: order hua par bill nahi aaya.
 *  - Credit / debit notes ki ginti — `count: exact, head: true` (rows nahi aati).
 *  - TDS = `tds_receivable` jahan `fiscal_year` FY se milta hai (reversed nahi).
 *  - Advance / self-assessment tax = `tax_payments`.
 *  - Asset register — P&L jaisa; depreciation assemblePnl ginta hai, yahan ginti (gap ke liye).
 *
 * Tenant scoping RLS karta hai — `.eq("tenant_id", …)` yahan nahi likha
 * jata (queries/leads.ts:24 wahi kehta hai).
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { computeItrPack, financialYear, type ItrPack, type ItrSources } from "@/lib/tax/itr";
import { itrBooksFromPnl } from "@/lib/tax/itr-from-pnl";
import { incomeTaxPaidForFy } from "@/lib/accounting/tax-payments";
import type { AssetBlock } from "@/lib/accounting/depreciation";
import { assemblePnl, type PnlRpcRow } from "@/lib/accounting/pnl-assemble";
import { rpcRowOrThrow } from "@/lib/accounting/report-rpc";
import { fetchAllRows } from "@/lib/ops/fetch-all";

export function useItrPack(fyStartYear: number) {
  return useQuery({
    queryKey: ["itr-pack", fyStartYear],
    queryFn: async (): Promise<ItrPack> => {
      const fy = financialYear(fyStartYear);
      const supabase = createClient();

      const [rpc, cn, dn, po, tds, taxPay, fa] = await Promise.all([
        supabase.rpc("report_pnl", { p_from: fy.start, p_to: fy.end }),
        supabase.from("credit_notes").select("id", { count: "exact", head: true })
          .gte("credit_date", fy.start).lte("credit_date", fy.end),
        supabase.from("debit_notes").select("id", { count: "exact", head: true })
          .gte("debit_date", fy.start).lte("debit_date", fy.end),
        fetchAllRows((a, b) => supabase.from("purchase_orders")
          .select("id, total_cost")
          .gte("placed_at", fy.start)
          // placed_at timestamptz hai; FY ke aakhri din ka poora din chahiye.
          .lt("placed_at", `${fy.startYear + 1}-04-01`)
          .in("status", ["placed", "provisioned", "closed"])
          .order("id").range(a, b)),
        fetchAllRows((a, b) => supabase.from("tds_receivable")
          .select("id, tds_amount")
          .eq("fiscal_year", fy.fiscalKey)
          // R-1567: a refunded / deleted payment's TDS is 'reversed' — not a credit to claim
          // (filter(): the generated TdsStatus type does not list it).
          .filter("status", "neq", "reversed")
          .order("id").range(a, b)),
        // Advance + self-assessment tax jo bank line se "tax payment" book hua (tax_payments).
        fetchAllRows((a, b) => supabase.from("tax_payments")
          .select("id, kind, amount, period, fy")
          .in("kind", ["advance_tax", "self_assessment_tax"])
          .order("id").range(a, b)),
        fetchAllRows((a, b) => supabase.from("fixed_assets")
          .select("id, name, block, cost, put_to_use, disposed_on, disposal_value")
          .order("id").range(a, b)),
      ]);
      for (const r of [cn, dn]) if (r.error) throw r.error;
      const row = rpcRowOrThrow<PnlRpcRow>(rpc, "report_pnl");

      const assets = fa.map((a) => ({ ...a, block: a.block as AssetBlock }));
      /* P&L ke flat aankde (revenue … netProfit) masters par nirbhar nahi — wo sirf `model`
         ke COGS andaze ke liye hain, aur tax andaza nahi leta. Isliye khaali masters. */
      const pnl = assemblePnl({ from: fy.start, to: fy.end }, row, {
        vendors: [], allocations: [], monthlyGross: new Map(), projects: [], employeeNames: new Map(), assets,
      });

      const sources: ItrSources = {
        ...itrBooksFromPnl(pnl, row),
        creditNoteCount: cn.count ?? 0,
        debitNoteCount: dn.count ?? 0,
        placedPoCost: po.reduce((s, p) => s + (p.total_cost ?? 0), 0),
        placedPoCount: po.length,
        tdsCredit: tds.reduce((s, t) => s + (t.tds_amount ?? 0), 0),
        tdsCount: tds.length,
        // Banking me bank line ko "Income tax" payment book karne se aata hai. Kuch book
        // nahi hua to 0 — aur pack ka gap wahi kehta rahega.
        advanceTaxPaid: incomeTaxPaidForFy(taxPay, fyStartYear),
        assetCount: assets.filter((a) => a.put_to_use <= fy.end && !(a.disposed_on && a.disposed_on < fy.start)).length,
      };

      return computeItrPack(fy, sources);
    },
  });
}
