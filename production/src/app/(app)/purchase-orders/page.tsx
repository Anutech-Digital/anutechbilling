/**
 * Purchase Orders — operator's procurement queue.
 *
 * Auto-created by record_payment when a subscription spawns or rolls
 * forward. Operator opens each PO to confirm wholesale cost, capture
 * the vendor's order ref, and advance status (draft → placed →
 * provisioned → closed).
 *
 * KPIs:
 *   - Pending value (draft + placed POs, ₹) — money you owe vendors
 *   - Provisioned this month
 *   - Reconciliation hint: sold vs procured per vendor (Phase 2 deeper)
 */
"use client";

import * as React from "react";
import { usePurchaseOrders, usePurchaseOrderSummaries, type PurchaseOrderSummary } from "@/lib/queries/purchase-orders";
import { useSubscriptions }  from "@/lib/queries/subscriptions";
import PlaceOrderDialog      from "@/components/features/purchase-orders/place-order-dialog";
import { EmptyState }        from "@/components/shared/empty-state";
import { KPI }               from "@/components/shared/kpi";
import { Skeleton }          from "@/components/ui/skeleton";
import { Button }            from "@/components/ui/button";
import { Badge }             from "@/components/ui/badge";
import { Card }              from "@/components/ui/card";
import { TabBar, type TabBarItem } from "@/components/ui/tabs";
import { Input }             from "@/components/ui/input";
import { Icon }              from "@/components/ui/icon";
import { rupee, formatDate, cn } from "@/lib/utils";
import type { PurchaseOrderRow } from "@/lib/supabase/database.types";

const STATUS_META: Record<string, { label: string; kind: "warning"|"info"|"success"|"danger"|"muted" }> = {
  draft:       { label: "Draft",       kind: "warning" },
  placed:      { label: "Placed",      kind: "info"    },
  provisioned: { label: "Provisioned", kind: "success" },
  closed:      { label: "Closed",      kind: "muted"   },
  cancelled:   { label: "Cancelled",   kind: "danger"  },
};

export default function PurchaseOrdersPage() {
  const { data: pos,  isLoading, error, refetch } = usePurchaseOrders();
  const { data: subs }                            = useSubscriptions();
  const { data: summaries }                       = usePurchaseOrderSummaries();

  // Map summary by PO id for quick lookup
  const summaryById = React.useMemo(() => {
    const map = new Map<string, PurchaseOrderSummary>();
    for (const s of summaries ?? []) map.set(s.purchase_order_id, s);
    return map;
  }, [summaries]);
  const [tab,    setTab]    = React.useState("open");
  const [vendor, setVendor] = React.useState("all");
  const [search, setSearch] = React.useState("");
  const [selected, setSelected] = React.useState<PurchaseOrderRow | null>(null);

  const filtered = (pos ?? []).filter((p) => {
    if (tab === "open"        && (p.status !== "draft" && p.status !== "placed")) return false;
    if (tab === "draft"       && p.status !== "draft") return false;
    if (tab === "placed"      && p.status !== "placed") return false;
    if (tab === "provisioned" && p.status !== "provisioned") return false;
    if (tab === "closed"      && p.status !== "closed" && p.status !== "cancelled") return false;
    if (vendor !== "all" && p.vendor !== vendor) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (
        !p.id.toLowerCase().includes(q) &&
        !p.customer_name.toLowerCase().includes(q) &&
        !(p.domain?.toLowerCase().includes(q) ?? false) &&
        !p.plan.toLowerCase().includes(q) &&
        !(p.vendor_order_id?.toLowerCase().includes(q) ?? false)
      ) return false;
    }
    return true;
  });

  // Counts for tabs
  const counts = {
    all:         pos?.length ?? 0,
    open:        (pos ?? []).filter((p) => p.status === "draft" || p.status === "placed").length,
    draft:       (pos ?? []).filter((p) => p.status === "draft").length,
    placed:      (pos ?? []).filter((p) => p.status === "placed").length,
    provisioned: (pos ?? []).filter((p) => p.status === "provisioned").length,
    closed:      (pos ?? []).filter((p) => p.status === "closed" || p.status === "cancelled").length,
  };

  const tabs: TabBarItem[] = [
    { id: "open",        label: "Open",        count: counts.open,        dot: "amber"   },
    { id: "draft",       label: "Draft",       count: counts.draft },
    { id: "placed",      label: "Placed",      count: counts.placed,      dot: "indigo"  },
    { id: "provisioned", label: "Provisioned", count: counts.provisioned, dot: "emerald" },
    { id: "closed",      label: "Closed",      count: counts.closed,      dot: "slate"   },
  ];

  // KPIs
  const pendingValue       = (pos ?? []).filter((p) => p.status === "draft").reduce((s, p) => s + p.total_cost, 0);
  const placedValue        = (pos ?? []).filter((p) => p.status === "placed").reduce((s, p) => s + p.total_cost, 0);
  const provisionedSeats   = (pos ?? []).filter((p) => p.status === "provisioned").reduce((s, p) => s + p.seats, 0);
  const draftCount         = counts.draft;
  // Reconciliation hint: customer-sold seats vs PO-procured seats (per vendor)
  const reconBy: Record<string, { sold: number; ordered: number }> = {};
  for (const s of subs ?? []) {
    if (s.status !== "active") continue;
    const k = s.vendor;
    reconBy[k] = reconBy[k] ?? { sold: 0, ordered: 0 };
    reconBy[k].sold += s.seats;
  }
  for (const p of pos ?? []) {
    if (p.status === "cancelled" || p.status === "closed") continue;
    const k = p.vendor;
    reconBy[k] = reconBy[k] ?? { sold: 0, ordered: 0 };
    reconBy[k].ordered += p.seats;
  }
  const reconRows = Object.entries(reconBy).filter(([, v]) => v.sold || v.ordered);
  const reconGap  = reconRows.reduce((g, [, v]) => g + Math.max(0, v.sold - v.ordered), 0);

  // Phase 2 — total variance summary (used as a tooltip / future KPI)
  const reconciledCount = (summaries ?? []).filter((s) => s.allocation_count > 0).length;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Purchases</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Purchase Orders</h1>
          <p className="text-sm text-ink-3 mt-1">What you owe Google/Microsoft/Zoho for active customer subs</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button icon="refresh" onClick={() => refetch()}>Refresh</Button>
        </div>
      </div>

      {/* KPIs */}
      {!isLoading && pos && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KPI label="Pending to place"   value={draftCount}                trend={rupee(pendingValue, { compact: true }) + " value"} trendKind="down" trendIcon="alert" />
          <KPI label="Placed (in flight)" value={rupee(placedValue, { compact: true })} trend={`${counts.placed} POs`} icon="rupee" />
          <KPI label="Provisioned seats"  value={provisionedSeats}          trend={`${counts.provisioned} POs`} trendKind="up" />
          <KPI label="Sold vs procured"   value={reconGap === 0 ? "✓ matched" : `${reconGap} short`} trend={`${reconciledCount} POs reconciled with bills`} trendKind={reconGap === 0 ? "up" : "down"} icon={reconGap === 0 ? "check_circle" : "alert"} />
        </div>
      )}

      {/* Tabs */}
      {!isLoading && pos && pos.length > 0 && (
        <div className="mb-3">
          <TabBar value={tab} onChange={setTab} items={tabs} />
        </div>
      )}

      {/* Filter row */}
      {!isLoading && pos && pos.length > 0 && (
        <div className="flex justify-between items-center gap-3 flex-wrap mb-3">
          <div className="inline-flex gap-1 bg-paper-2 rounded-md p-0.5">
            {[
              { value: "all",       label: "All Vendors" },
              { value: "google",    label: "Google" },
              { value: "microsoft", label: "Microsoft" },
              { value: "zoho",      label: "Zoho" },
            ].map((opt) => (
              <button
                key={opt.value}
                onClick={() => setVendor(opt.value)}
                className={cn(
                  "px-3 py-1 text-xs font-medium rounded transition-colors",
                  vendor === opt.value ? "bg-paper text-ink shadow-sm" : "text-ink-3 hover:text-ink"
                )}
              >
                {opt.label}
              </button>
            ))}
          </div>
          <div className="w-72">
            <Input
              prefix={<Icon name="search" size={14} />}
              placeholder="PO, customer, domain, vendor order ID…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <EmptyState
          icon="alert"
          title="Could not load purchase orders"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {/* Loading */}
      {isLoading && (
        <Card flush>
          <table className="w-full">
            <tbody>
              {[1, 2, 3, 4].map((i) => (
                <tr key={i} className="border-b border-hairline">
                  {[1, 2, 3, 4, 5, 6].map((j) => (
                    <td key={j} className="p-3"><Skeleton className="h-3 w-full" /></td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}

      {/* Empty */}
      {!isLoading && !error && pos && pos.length === 0 && (
        <EmptyState
          icon="cart"
          title="No purchase orders yet"
          body="Purchase Orders are auto-created when a customer pays for a subscription. As soon as your first payment comes through, a draft PO will appear here for you to place with Google/Microsoft/Zoho."
        />
      )}

      {/* Desktop table */}
      {!isLoading && !error && filtered.length > 0 && (
        <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">PO ID</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Customer · Domain</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Plan</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Vendor</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Seats</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Term</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Expected</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider" title="Actual bill amount allocated to this PO">Allocated</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Vendor ref</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Created</th>
                  <th className="w-28"></th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p) => {
                  const meta = STATUS_META[p.status];
                  return (
                    <tr
                      key={p.id}
                      className="border-b border-hairline last:border-0 hover:bg-paper-2/40 cursor-pointer"
                      onClick={() => setSelected(p)}
                    >
                      <td className="p-3 font-mono text-xs font-semibold text-ink">{p.id}</td>
                      <td className="p-3">
                        <div className="font-medium text-sm text-ink">{p.customer_name}</div>
                        {p.domain && <div className="text-[11px] text-ink-3 font-mono">{p.domain}</div>}
                      </td>
                      <td className="p-3 text-sm text-ink-2">{p.plan}</td>
                      <td className="p-3">
                        <Badge kind={p.vendor === "zoho" ? "success" : "info"}>{p.vendor}</Badge>
                      </td>
                      <td className="p-3 text-right tabular-nums text-sm">{p.seats}</td>
                      <td className="p-3 text-right tabular-nums text-sm">{p.term_months}m</td>
                      <td className="p-3 text-right tabular-nums text-sm font-medium">
                        {rupee(p.total_cost)}
                        <div className="text-[10px] text-ink-3">{rupee(p.unit_cost_pm)}/seat/mo</div>
                      </td>
                      <td className="p-3 text-right tabular-nums text-sm">
                        {(() => {
                          const s = summaryById.get(p.id);
                          if (!s || s.allocation_count === 0) {
                            return <span className="text-ink-3">—</span>;
                          }
                          const v = s.variance_amount;
                          return (
                            <>
                              <div className="font-medium">{rupee(s.allocated_total)}</div>
                              <div className={cn(
                                "text-[10px] tabular-nums",
                                Math.abs(v) < 100  ? "text-emerald" :
                                v > 0              ? "text-amber-ink" :
                                                     "text-rose",
                              )}>
                                {Math.abs(v) < 100
                                  ? "✓ match"
                                  : `${v > 0 ? "−" : "+"}${rupee(Math.abs(v))}`}
                              </div>
                            </>
                          );
                        })()}
                      </td>
                      <td className="p-3 font-mono text-[11px] text-ink-2">
                        {p.vendor_order_id ?? <span className="text-ink-3">—</span>}
                      </td>
                      <td className="p-3"><Badge kind={meta.kind} dot>{meta.label}</Badge></td>
                      <td className="p-3 text-sm text-ink-2 tabular-nums">{formatDate(p.created_at)}</td>
                      <td className="p-3">
                        <Button
                          size="sm"
                          variant={p.status === "draft" ? "primary" : "default"}
                          onClick={(e) => { e.stopPropagation(); setSelected(p); }}
                        >
                          {p.status === "draft"      ? "Place" :
                           p.status === "placed"     ? "Provision" :
                           p.status === "provisioned" ? "Close" : "View"}
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
        </Card>
      )}

      {/* Mobile card list */}
      {!isLoading && !error && filtered.length > 0 && (
        <ul className="md:hidden space-y-2 mb-3">
          {filtered.map((p) => {
            const meta = STATUS_META[p.status];
            return (
              <li
                key={p.id}
                onClick={() => setSelected(p)}
                className="bg-paper border border-hairline rounded-lg p-3 active:bg-paper-2/50"
              >
                <div className="flex items-start justify-between gap-3 mb-1.5">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-xs font-semibold text-ink">{p.id}</span>
                    <p className="text-sm font-medium text-ink mt-0.5 truncate">{p.customer_name}</p>
                    {p.domain && <p className="text-[11px] text-ink-3 font-mono truncate">{p.domain}</p>}
                  </div>
                  <div className="text-right shrink-0">
                    <p className="font-serif text-base tabular-nums text-ink">{rupee(p.total_cost)}</p>
                    <p className="text-[10px] text-ink-3">{p.seats}s · {p.term_months}m</p>
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 mt-2 pt-2 border-t border-hairline/60 text-xs">
                  <span className="text-ink-3 truncate">{p.plan}</span>
                  <Badge kind={meta.kind} size="sm" dot>{meta.label}</Badge>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {/* Filtered empty */}
      {!isLoading && !error && pos && pos.length > 0 && filtered.length === 0 && (
        <div className="mt-6">
          <EmptyState
            icon="search"
            title="No purchase orders match"
            body="Try changing tab, vendor filter, or search term."
            action={<Button icon="x" onClick={() => { setTab("open"); setVendor("all"); setSearch(""); }}>Clear filters</Button>}
            compact
          />
        </div>
      )}

      {/* Reconciliation hint card */}
      {!isLoading && pos && pos.length > 0 && reconRows.length > 0 && (
        <Card title="Sold vs Procured" sub="Per-vendor seat reconciliation (open POs + active subs)" className="mt-6">
          <table className="w-full text-sm">
            <thead className="text-ink-3">
              <tr>
                <th className="text-left py-1 text-xs uppercase tracking-wider">Vendor</th>
                <th className="text-right py-1 text-xs uppercase tracking-wider">Customer seats sold</th>
                <th className="text-right py-1 text-xs uppercase tracking-wider">PO seats ordered</th>
                <th className="text-right py-1 text-xs uppercase tracking-wider">Gap</th>
              </tr>
            </thead>
            <tbody>
              {reconRows.map(([v, info]) => {
                const gap = info.sold - info.ordered;
                return (
                  <tr key={v} className="border-t border-hairline">
                    <td className="py-2"><Badge kind={v === "zoho" ? "success" : "info"}>{v}</Badge></td>
                    <td className="py-2 text-right tabular-nums">{info.sold}</td>
                    <td className="py-2 text-right tabular-nums">{info.ordered}</td>
                    <td className={cn(
                      "py-2 text-right tabular-nums font-medium",
                      gap > 0  ? "text-rose"    :
                      gap < 0  ? "text-amber-ink" : "text-emerald",
                    )}>
                      {gap > 0  ? `${gap} short` :
                       gap < 0  ? `${Math.abs(gap)} over` : "✓ matched"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          <p className="text-[11px] text-ink-3 mt-3">
            <Icon name="info" size={11} className="inline mr-1" />
            Gap = customer subscriptions waiting on procurement. Negative = over-ordered (maybe seat reduction).
          </p>
        </Card>
      )}

      {/* Dialog */}
      {selected && (
        <PlaceOrderDialog
          po={selected}
          open={!!selected}
          onOpenChange={(v) => { if (!v) setSelected(null); }}
        />
      )}
    </div>
  );
}
