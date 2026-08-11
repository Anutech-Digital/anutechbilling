/**
 * Profit by product / service — which products actually make money.
 *
 * For every quote that has generated revenue (payment received / partial /
 * invoiced), we break its line items out by product name and aggregate:
 *   Units    = Σ qty
 *   Revenue  = Σ qty × rate   (ex-GST customer price; rate is stored ₹/seat/yr)
 *   Cost     = Σ qty × cost   (vendor wholesale, ex-GST)
 *   Profit   = Revenue − Cost
 *   Margin % = Profit / Revenue × 100
 *
 * Sorted by profit (highest earners first). Read-only — no money writes.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Button } from "@/components/ui/button";
import { StatStrip } from "@/components/shared/stat-strip";
import { rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { QuoteLineItem } from "@/lib/supabase/database.types";

interface ProductRow {
  name:      string;
  units:     number;
  orders:    number;
  revenue:   number;
  cost:      number;
  profit:    number;
  marginPct: number;
}

function useProfitByProduct() {
  return useQuery({
    queryKey: ["reports", "profit-by-product"],
    queryFn: async (): Promise<ProductRow[]> => {
      const supabase = createClient();
      // Revenue-generating quotes only (money actually in the flow).
      const { data, error } = await supabase
        .from("quotes")
        .select("line_items, payment_status")
        .in("payment_status", ["received", "partial", "invoiced"]);
      if (error) throw error;

      const byName = new Map<string, ProductRow>();
      for (const q of data ?? []) {
        const lines = Array.isArray(q.line_items) ? (q.line_items as QuoteLineItem[]) : [];
        for (const li of lines) {
          const name = (li.name ?? "").trim() || "Unnamed";
          const qty  = li.qty ?? 0;
          const rev  = qty * (li.rate ?? 0);
          const cost = qty * (li.cost ?? 0);
          const row = byName.get(name) ?? { name, units: 0, orders: 0, revenue: 0, cost: 0, profit: 0, marginPct: 0 };
          row.units   += qty;
          row.orders  += 1;
          row.revenue += rev;
          row.cost    += cost;
          byName.set(name, row);
        }
      }

      const rows = Array.from(byName.values()).map((r) => {
        r.profit    = r.revenue - r.cost;
        r.marginPct = r.revenue > 0 ? Math.round((r.profit / r.revenue) * 100) : 0;
        return r;
      });
      rows.sort((a, b) => b.profit - a.profit);
      return rows;
    },
  });
}

export default function ProfitByProductPage() {
  const { data: rows, isLoading, error, refetch } = useProfitByProduct();

  const totals = React.useMemo(() => {
    const t = (rows ?? []).reduce(
      (s, r) => ({ revenue: s.revenue + r.revenue, cost: s.cost + r.cost, profit: s.profit + r.profit }),
      { revenue: 0, cost: 0, profit: 0 },
    );
    const marginPct = t.revenue > 0 ? Math.round((t.profit / t.revenue) * 100) : 0;
    return { ...t, marginPct };
  }, [rows]);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1240px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
            <Link href={"/reports" as never} className="hover:text-amber-ink hover:underline">Reports</Link> · Profit
          </p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Profit by product / service</h1>
          <p className="text-sm text-ink-3 mt-1">Revenue − vendor cost, per product — across all paid / invoiced deals (ex-GST).</p>
        </div>
      </div>

      {!isLoading && !error && rows && rows.length > 0 && (
        <StatStrip
          className="mb-5"
          items={[
            { label: "Revenue (ex-GST)", value: rupee(totals.revenue, { compact: true }) },
            { label: "Vendor cost",      value: rupee(totals.cost, { compact: true }), tone: "rose" },
            { label: "Profit",           value: rupee(totals.profit, { compact: true }), tone: "emerald" },
            { label: "Blended margin",   value: `${totals.marginPct}%`, tone: totals.marginPct >= 15 ? "emerald" : "rose" },
          ]}
        />
      )}

      {error && (
        <EmptyState icon="alert" title="Could not load report" body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>} />
      )}

      {isLoading && (
        <Card flush>
          <div className="p-4 space-y-3">
            {[1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        </Card>
      )}

      {!isLoading && !error && rows && rows.length === 0 && (
        <EmptyState
          icon="package"
          title="No product profit yet"
          body="Once quotes are paid, each product's revenue, cost and profit will show up here."
        />
      )}

      {!isLoading && !error && rows && rows.length > 0 && (
        <>
        {/* Mobile card list — table side-scrolls on phones (§20). */}
        <ul className="md:hidden space-y-2">
          {rows.map((r) => (
            <li key={r.name} className="rounded-lg border border-hairline bg-paper p-3">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <span className="font-medium text-ink text-sm truncate">{r.name}</span>
                <Badge kind={r.marginPct >= 25 ? "success" : r.marginPct >= 15 ? "warning" : "danger"} dot>{r.marginPct}%</Badge>
              </div>
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div><span className="text-ink-3 block">Revenue</span><span className="tabular-nums">{rupee(r.revenue)}</span></div>
                <div><span className="text-ink-3 block">Cost</span><span className="tabular-nums text-ink-2">{rupee(r.cost)}</span></div>
                <div><span className="text-ink-3 block">Profit</span><span className="tabular-nums text-emerald font-medium">{rupee(r.profit)}</span></div>
              </div>
              <div className="text-[11px] text-ink-3 mt-1.5 tabular-nums">{r.units} units · {r.orders} orders</div>
            </li>
          ))}
          <li className="rounded-lg border-2 border-ink bg-paper-2/40 p-3">
            <div className="flex items-center justify-between text-sm font-semibold">
              <span>Total</span><span className="tabular-nums">{totals.marginPct}%</span>
            </div>
            <div className="grid grid-cols-3 gap-2 text-xs mt-1.5">
              <div><span className="text-ink-3 block">Revenue</span><span className="tabular-nums">{rupee(totals.revenue)}</span></div>
              <div><span className="text-ink-3 block">Cost</span><span className="tabular-nums">{rupee(totals.cost)}</span></div>
              <div><span className="text-ink-3 block">Profit</span><span className="tabular-nums text-emerald">{rupee(totals.profit)}</span></div>
            </div>
          </li>
        </ul>

        {/* Desktop table */}
        <Card flush className="hidden md:block">
          <table className="w-full">
            <thead className="bg-paper-2 border-b border-hairline">
              <tr>
                <th className="text-left  p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Product / service</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Units</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Orders</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Revenue</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Cost</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Profit</th>
                <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Margin</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.name} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                  <td className="p-3 text-sm font-medium text-ink">{r.name}</td>
                  <td className="p-3 text-right tabular-nums text-sm text-ink-2">{r.units}</td>
                  <td className="p-3 text-right tabular-nums text-sm text-ink-2">{r.orders}</td>
                  <td className="p-3 text-right tabular-nums text-sm">{rupee(r.revenue)}</td>
                  <td className="p-3 text-right tabular-nums text-sm text-ink-2">{rupee(r.cost)}</td>
                  <td className="p-3 text-right tabular-nums text-sm font-medium text-emerald">{rupee(r.profit)}</td>
                  <td className="p-3 text-right">
                    <Badge kind={r.marginPct >= 25 ? "success" : r.marginPct >= 15 ? "warning" : "danger"} dot>
                      {r.marginPct}%
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-ink bg-paper-2/40 font-semibold">
                <td className="p-3 text-sm">Total</td>
                <td></td>
                <td></td>
                <td className="p-3 text-right tabular-nums text-sm">{rupee(totals.revenue)}</td>
                <td className="p-3 text-right tabular-nums text-sm">{rupee(totals.cost)}</td>
                <td className="p-3 text-right tabular-nums text-sm text-emerald">{rupee(totals.profit)}</td>
                <td className="p-3 text-right tabular-nums text-sm">{totals.marginPct}%</td>
              </tr>
            </tfoot>
          </table>
        </Card>
        </>
      )}
    </div>
  );
}
