/**
 * R-1859 — the numbers the tax-audit answer needs for one FY, read the way the P&L reads them.
 *
 *  - Turnover = the P&L's revenue (report_pnl: invoices − credit notes + debit notes, taxable
 *    value ex-GST) — the same figure /accounting/pnl and the ITR pack show (R-1579).
 *  - Cash share = the FY's bank / cash account lines (bank_transactions), paged. Lines on a
 *    cash account (Petty Cash …) count as cash; transfers between own accounts do not count.
 * A running FY is read up to today. Tenant scoping is RLS (same as queries/itr.ts).
 */
"use client";

import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import { rpcRowOrThrow } from "@/lib/accounting/report-rpc";
import { fetchAllRows } from "@/lib/ops/fetch-all";
import type { PnlRpcRow } from "@/lib/accounting/pnl-assemble";
import { istToday } from "@/lib/dates/ist";
import { cashShares } from "./tax-audit";

export interface TaxAuditInputs {
  fyStartYear: number;
  turnover: number;
  cashReceiptsPct: number | null;
  cashPaymentsPct: number | null;
  partialYear: boolean;
}

export function useTaxAuditInputs(fyStartYear: number | null) {
  return useQuery({
    queryKey: ["tax-audit-inputs", fyStartYear],
    enabled: fyStartYear !== null,
    staleTime: 10 * 60_000,
    queryFn: async (): Promise<TaxAuditInputs> => {
      const y = fyStartYear as number;
      const today = istToday();
      const fyEnd = `${y + 1}-03-31`;
      const to = today < fyEnd ? today : fyEnd;
      const from = `${y}-04-01`;
      const supabase = createClient();
      const [rpc, accounts, lines] = await Promise.all([
        supabase.rpc("report_pnl", { p_from: from, p_to: to }),
        supabase.from("bank_accounts").select("id, account_type"),
        fetchAllRows((a, b) => supabase.from("bank_transactions")
          .select("id, bank_account_id, debit, credit, matched_to_type")
          .gte("txn_date", from).lte("txn_date", to)
          .order("id").range(a, b)),
      ]);
      if (accounts.error) throw accounts.error;
      const row = rpcRowOrThrow<PnlRpcRow>(rpc, "report_pnl");
      const cashIds = new Set((accounts.data ?? []).filter((a) => a.account_type === "cash").map((a) => a.id));
      const shares = cashShares(lines.map((l) => ({
        credit: Number(l.credit) || 0,
        debit: Number(l.debit) || 0,
        isCash: cashIds.has(l.bank_account_id),
        isTransfer: l.matched_to_type === "transfer",
      })));
      return {
        fyStartYear: y,
        turnover: Math.round((row.inv_taxable ?? 0) - (row.cn_taxable ?? 0) + (row.dn_taxable ?? 0)),
        cashReceiptsPct: shares?.receiptsPct ?? null,
        cashPaymentsPct: shares?.paymentsPct ?? null,
        partialYear: to < fyEnd,
      };
    },
  });
}
