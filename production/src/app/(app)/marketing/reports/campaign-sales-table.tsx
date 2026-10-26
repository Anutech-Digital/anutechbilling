/**
 * R-1980 — "Sales by campaign" on Marketing → Reports.
 *
 * Money actually received because of each ad campaign (ex GST, refunds taken off), next to
 * what the campaign cost and the clicks and leads it brought. The arithmetic and every rule
 * behind it is lib/marketing/campaign-sales.ts; the reads are lib/queries/marketing-sales.ts.
 */
"use client";

import * as React from "react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { loadErrorBody } from "@/components/shared/load-error";
import { rupee, cn } from "@/lib/utils";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { useCampaignSales } from "@/lib/queries/marketing-sales";
import type { RangeKey } from "@/lib/queries/marketing";
import { NO_CAMPAIGN, adChannelLabel, type CampaignSalesRow } from "@/lib/marketing/campaign-sales";

const th = "px-3 py-2.5 text-2xs font-semibold text-ink-3 uppercase tracking-wider";
const num = "px-3 py-2.5 text-right tabular-nums text-sm";

function Row({ r }: { r: CampaignSalesRow }) {
  const none = r.key === NO_CAMPAIGN;
  return (
    <>
      <tr className="border-b border-hairline last:border-0">
        <td className="px-3 py-2.5">
          <p className={cn("text-sm font-medium", none ? "text-ink-2" : "text-ink")}>{r.name}</p>
          {adChannelLabel(r.channel) && <p className="text-2xs text-ink-3">{adChannelLabel(r.channel)}</p>}
        </td>
        <td className={num}>{r.spend > 0 ? rupee(r.spend) : "—"}</td>
        <td className={num}>{r.clicks > 0 ? r.clicks.toLocaleString("en-IN") : "—"}</td>
        <td className={num}>{r.leads}</td>
        <td className={num}>{r.paidOrders}</td>
        <td className={num}>
          <span className="font-medium text-ink">{rupee(r.revenue)}</span>
          {r.refunded > 0 && <p className="text-2xs text-ink-3">after {rupee(r.refunded)} refunded</p>}
        </td>
        <td className={num}>{r.roas === null ? "—" : `${r.roas.toFixed(2)}×`}</td>
        <td className={num}>{r.cac === null ? "—" : rupee(r.cac)}</td>
      </tr>
      {r.children.map((k, i) => (
        <tr key={i} className="border-b border-hairline bg-paper-2/40">
          <td className="py-1.5 pl-8 pr-3 text-xs text-ink-2">
            {k.adSet || k.ad ? <>{k.adSet ?? "—"} <span className="text-ink-3">›</span> {k.ad ?? "—"}</> : <span className="text-ink-3">No ad set / ad recorded</span>}
          </td>
          <td className={cn(num, "py-1.5 text-xs text-ink-3")}>—</td>
          <td className={cn(num, "py-1.5 text-xs text-ink-3")}>—</td>
          <td className={cn(num, "py-1.5 text-xs text-ink-3")}>—</td>
          <td className={cn(num, "py-1.5 text-xs")}>{k.paidOrders}</td>
          <td className={cn(num, "py-1.5 text-xs")}>{rupee(k.revenue)}</td>
          <td className={cn(num, "py-1.5 text-xs text-ink-3")}>—</td>
          <td className={cn(num, "py-1.5 text-xs text-ink-3")}>—</td>
        </tr>
      ))}
    </>
  );
}

export function CampaignSalesTable({ range }: { range: RangeKey }) {
  const { data: me } = useCurrentUser();
  const { data, isLoading, error } = useCampaignSales(range, me?.tenantId);

  return (
    <Card flush id="sales-by-campaign">
      <div className="px-4 pt-4 pb-2">
        <p className="text-sm font-semibold text-ink">Sales by campaign</p>
        <p className="text-[12px] text-ink-3 mt-0.5 max-w-[60rem]">
          Money received in this period, excluding GST, minus refunds — traced from each payment to its order and the ad
          that brought it. Spend is what the ad account reported plus other costs booked against the campaign.
        </p>
      </div>
      {isLoading ? (
        <div className="p-4"><Skeleton className="h-40 w-full" /></div>
      ) : error ? (
        <EmptyState icon="alert" title="Could not load sales by campaign" body={loadErrorBody(error)} />
      ) : !data || data.rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-ink-3">No campaign spend, leads or payments in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px]">
            <thead className="bg-paper-2 border-y border-hairline-strong">
              <tr>
                <th className={cn(th, "text-left")}>Campaign</th>
                <th className={cn(th, "text-right")}>Spend</th>
                <th className={cn(th, "text-right")}>Clicks</th>
                <th className={cn(th, "text-right")}>Leads</th>
                <th className={cn(th, "text-right")}>Paid orders</th>
                <th className={cn(th, "text-right")}>Revenue (ex GST)</th>
                <th className={cn(th, "text-right")}>ROAS</th>
                <th className={cn(th, "text-right")}>CAC</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => <Row key={r.key} r={r} />)}
            </tbody>
            <tfoot className="bg-paper-2 border-t border-hairline-strong">
              <tr>
                <td className="px-3 py-2.5 text-sm font-semibold text-ink">Total</td>
                <td className={cn(num, "font-semibold")}>{rupee(data.totals.spend)}</td>
                <td className={cn(num, "font-semibold")}>{data.totals.clicks.toLocaleString("en-IN")}</td>
                <td className={cn(num, "font-semibold")}>{data.totals.leads}</td>
                <td className={cn(num, "font-semibold")}>{data.totals.paidOrders}</td>
                <td className={cn(num, "font-semibold")}>{rupee(data.totals.revenue)}</td>
                <td className={cn(num, "font-semibold")}>
                  {data.totals.roas === null ? "—" : `${data.totals.roas.toFixed(2)}×`}
                  {/* R-1980: the ads' return — orders no campaign brought are not in it. */}
                  <p className="text-2xs font-normal text-ink-3">campaigns only</p>
                </td>
                <td className={num} />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </Card>
  );
}
