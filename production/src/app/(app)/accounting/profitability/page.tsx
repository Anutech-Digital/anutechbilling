/**
 * Per-Customer Profitability — kaun customer profitable hai, kaun nahi.
 *
 * For each customer in the period:
 *   Revenue = sum of paid/invoiced quote amounts
 *   COGS    = sum of (line_item.cost × qty) for those quotes
 *   Margin  = Revenue − COGS  (₹ + %)
 *
 * Color-coded action:
 *   Green  >25% margin    "Healthy — focus on expansion"
 *   Amber  15-25% margin  "Monitor — raise prices on renewal"
 *   Red    <15% margin    "Action — raise prices or churn out"
 *
 * Sorted by margin % ascending so the worst ones are at the top.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { LoadError } from "@/components/shared/load-error";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { primaryContactsFor } from "@/lib/contacts/primary";
import { utcDateISO } from "@/lib/dates/ist";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { canOpenRoute } from "@/lib/nav";

// ────────────────────────────────────────────────────────────────
// Range helpers (Indian FY = Apr 1 → Mar 31)
// ────────────────────────────────────────────────────────────────

function istToday(): Date {
  return new Date(new Date().getTime() + 5.5 * 60 * 60 * 1000);
}
function yyyymmdd(d: Date): string {
  return utcDateISO(d);
}
function fiscalYearStart(d: Date): Date {
  const yr = d.getUTCFullYear();
  const m  = d.getUTCMonth();
  const fyYear = m < 3 ? yr - 1 : yr;
  return new Date(Date.UTC(fyYear, 3, 1));
}
interface DateRange { from: string; to: string }

function thisFY(): DateRange {
  const t = istToday();
  return { from: yyyymmdd(fiscalYearStart(t)), to: yyyymmdd(t) };
}
function last12Months(): DateRange {
  const t = istToday();
  const f = new Date(t);
  f.setUTCMonth(f.getUTCMonth() - 12);
  return { from: yyyymmdd(f), to: yyyymmdd(t) };
}
function thisQuarter(): DateRange {
  const t = istToday();
  const qStart = Math.floor(t.getUTCMonth() / 3) * 3;
  const first = new Date(Date.UTC(t.getUTCFullYear(), qStart, 1));
  return { from: yyyymmdd(first), to: yyyymmdd(t) };
}

const QUICK_RANGES: { label: string; build: () => DateRange }[] = [
  { label: "This quarter",  build: thisQuarter   },
  { label: "This FY",       build: thisFY        },
  { label: "Last 12 months",build: last12Months  },
];

// ────────────────────────────────────────────────────────────────
// Aggregation hook
// ────────────────────────────────────────────────────────────────

interface QuoteLineItem {
  qty?:  number;
  rate?: number;
  cost?: number;
  name?: string;
}

interface CustomerProfitRow {
  customerId:   string | null;
  customerName: string;
  revenue:      number;
  cogs:         number;
  margin:       number;     // revenue - cogs
  marginPct:    number;     // (margin / revenue) × 100
  quoteCount:   number;
  seatCount:    number;
  contactEmail: string | null;
  contactPhone: string | null;
  health:       "green" | "amber" | "red";
  action:       string;
  /** True when COGS is sourced from real PO allocations (Phase 2), not heuristic line_items.cost. */
  costSourceIsActual: boolean;
}

interface Totals {
  revenue: number;
  cogs:    number;
  margin:  number;
  marginPct: number;
  customers: number;
  redCount:   number;
  amberCount: number;
  greenCount: number;
}

function healthFor(marginPct: number): { health: "green" | "amber" | "red"; action: string } {
  if (marginPct >= 25)  return { health: "green", action: "Healthy · focus on seat expansion + renewal" };
  if (marginPct >= 15)  return { health: "amber", action: "Monitor · raise prices on next renewal" };
  return                       { health: "red",   action: "Action · raise prices or let churn" };
}

function useProfitability(range: DateRange) {
  return useQuery({
    queryKey: ["accounting", "profitability", range],
    queryFn: async (): Promise<{ rows: CustomerProfitRow[]; totals: Totals }> => {
      const supabase = createClient();

      // Pull quotes that have actually generated revenue (paid or invoiced).
      // line_items has `cost` per line (vendor wholesale) and `rate` (customer price);
      // multiplying by `qty` gives the true gross profit picture per quote.
      const { data: quotes, error: qErr } = await supabase
        .from("quotes")
        .select("id, customer_id, customer_name, amount, line_items, seats, created_date, payment_status")
        .gte("created_date", range.from)
        .lte("created_date", range.to)
        .in("payment_status", ["received", "partial", "invoiced"]);
      if (qErr) throw qErr;

      // Pull contact info for the customers we touched.
      const ids = Array.from(
        new Set((quotes ?? []).map((q) => q.customer_id).filter((x): x is string => !!x)),
      );
      /* The PRIMARY CONTACT, not customers.contact_*. Those columns stopped being the
         truth on 10 Sep 2026 — a customer's people live in `contacts`, one marked
         primary. One batched lookup, so a report over 200 customers stays one query. */
      const contacts = new Map<string, { email: string | null; phone: string | null }>();
      if (ids.length > 0) {
        const primaries = await primaryContactsFor(supabase, ids);
        for (const [id, p] of primaries) contacts.set(id, { email: p.email, phone: p.phone });
      }

      const grouped = new Map<string, CustomerProfitRow>();

      for (const q of quotes ?? []) {
        const key = q.customer_id ?? q.customer_name ?? "unknown";
        let row = grouped.get(key);

        // Revenue: GST-exclusive (we strip the 18% from amount because GST
        // is pass-through — not real revenue). amount × 100/118.
        const revenueExGST = Math.round((q.amount ?? 0) * 100 / 118);

        // COGS: sum of line_items[].cost × qty. cost is stored pre-GST.
        let lineCogs = 0;
        const lineItems = Array.isArray(q.line_items) ? (q.line_items as QuoteLineItem[]) : [];
        for (const li of lineItems) {
          const qty  = li.qty  ?? 0;
          const cost = li.cost ?? 0;
          lineCogs += qty * cost;
        }

        if (!row) {
          const contact = q.customer_id ? contacts.get(q.customer_id) : null;
          row = {
            customerId:   q.customer_id ?? null,
            customerName: q.customer_name ?? "—",
            revenue:      0,
            cogs:         0,
            margin:       0,
            marginPct:    0,
            quoteCount:   0,
            seatCount:    0,
            contactEmail: contact?.email ?? null,
            contactPhone: contact?.phone ?? null,
            health:       "green",
            action:       "",
            costSourceIsActual: false,
          };
          grouped.set(key, row);
        }

        row.revenue    += revenueExGST;
        row.cogs       += lineCogs;
        row.quoteCount += 1;
        row.seatCount  += q.seats ?? 0;
      }

      // Phase 2 — override estimated COGS with REAL cost from PO allocations
      // wherever the operator has matched bills. This makes the report reflect
      // actual vendor invoices instead of the 83% heuristic stored at quote time.
      if (ids.length > 0) {
        const { data: poSummaries } = await supabase
          .from("purchase_order_summary" as never)
          .select("customer_id, allocated_total, allocation_count")
          .in("customer_id", ids);
        const actualByCustomer = new Map<string, number>();
        for (const s of (poSummaries ?? []) as Array<{ customer_id: string | null; allocated_total: number; allocation_count: number }>) {
          if (!s.customer_id || s.allocation_count === 0) continue;
          actualByCustomer.set(
            s.customer_id,
            (actualByCustomer.get(s.customer_id) ?? 0) + s.allocated_total,
          );
        }
        for (const r of grouped.values()) {
          if (!r.customerId) continue;
          const actual = actualByCustomer.get(r.customerId);
          if (actual !== undefined && actual > 0) {
            r.cogs               = actual;
            r.costSourceIsActual = true;
          }
        }
      }

      // Compute derived fields after summing
      const rows = Array.from(grouped.values()).map((r) => {
        r.margin    = r.revenue - r.cogs;
        r.marginPct = r.revenue > 0 ? (r.margin / r.revenue) * 100 : 0;
        const { health, action } = healthFor(r.marginPct);
        r.health = health;
        r.action = action;
        return r;
      });

      // Sort: worst margin % first (so action items are at top)
      rows.sort((a, b) => a.marginPct - b.marginPct);

      const totals: Totals = {
        revenue: rows.reduce((s, r) => s + r.revenue, 0),
        cogs:    rows.reduce((s, r) => s + r.cogs,    0),
        margin:  0,
        marginPct: 0,
        customers:  rows.length,
        redCount:   rows.filter((r) => r.health === "red").length,
        amberCount: rows.filter((r) => r.health === "amber").length,
        greenCount: rows.filter((r) => r.health === "green").length,
      };
      totals.margin    = totals.revenue - totals.cogs;
      totals.marginPct = totals.revenue > 0 ? (totals.margin / totals.revenue) * 100 : 0;

      return { rows, totals };
    },
  });
}

// ────────────────────────────────────────────────────────────────
// Page
// ────────────────────────────────────────────────────────────────

export default function ProfitabilityPage() {
  const [range, setRange] = React.useState<DateRange>(thisFY());
  const { data, isLoading, isError, refetch } = useProfitability(range);
  /* R-255: the customer name links to the profile only for a role that may open it. */
  const canOpenCustomer = canOpenRoute(useCurrentUser().data?.role, "/customers/x");
  /* R-270: a failed load printed ₹0 revenue, 0.0% margin and "No paid customers". */
  const failed = isError && !data;

  const rows   = data?.rows   ?? [];
  const totals = data?.totals ?? { revenue: 0, cogs: 0, margin: 0, marginPct: 0, customers: 0, redCount: 0, amberCount: 0, greenCount: 0 };

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto">
      {/* Header */}
      <div className="mb-6">
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Accounting</p>
        <h1 className="font-serif text-3xl md:text-4xl tracking-tight">Customer Profitability</h1>
        <p className="text-sm text-ink-3 mt-1 max-w-2xl">
          Per-customer gross margin (revenue minus wholesale cost from quote line items).
          Worst margins sorted to the top — those are your action items.
          GST stripped from revenue since it&apos;s pass-through, not real income.
        </p>
      </div>

      {/* Range picker */}
      <Card className="mb-6 p-3 md:p-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap gap-1.5">
            {QUICK_RANGES.map((q) => {
              const target = q.build();
              const active = range.from === target.from && range.to === target.to;
              return (
                <button
                  key={q.label}
                  type="button"
                  onClick={() => setRange(target)}
                  className={`text-xs px-3 py-1.5 rounded-full border transition-colors ${
                    active
                      ? "border-amber bg-amber-soft text-amber-ink font-semibold"
                      : "border-hairline text-ink-3 hover:text-ink hover:bg-paper-2"
                  }`}
                >
                  {q.label}
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-2 ml-auto flex-wrap">
            <input aria-label="From date" type="date" value={range.from}
              onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
            <span className="text-xs text-ink-3">to</span>
            <input aria-label="To date" type="date" value={range.to}
              onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
              className="px-3 py-1.5 text-sm rounded-md border border-hairline bg-paper" />
          </div>
        </div>
      </Card>

      {/* KPI strip */}
      {!failed && (
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3 md:gap-4 mb-6">
        <KPI label="Total revenue (ex-GST)" value={rupee(totals.revenue)} />
        <KPI label="Total COGS"             value={rupee(totals.cogs)}    tone="rose" />
        <KPI label="Gross margin"           value={rupee(totals.margin)}  tone={totals.margin >= 0 ? "emerald" : "rose"} big />
        <KPI label="Margin %"               value={`${totals.marginPct.toFixed(1)}%`}
             tone={totals.marginPct >= 25 ? "emerald" : totals.marginPct >= 15 ? "amber" : "rose"} />
        <KPI label="Customers"              value={`${totals.customers}`} hint={`${totals.greenCount}🟢 ${totals.amberCount}🟡 ${totals.redCount}🔴`} />
      </div>
      )}

      {/* Action banner if there are red customers */}
      {totals.redCount > 0 && (
        <Card className="p-4 mb-6 border-rose/40 bg-rose-soft/30">
          <div className="text-sm text-ink-2 leading-relaxed">
            <Icon name="alert" size={16} className="text-rose inline mr-1.5 align-text-bottom" />
            <b>{totals.redCount} {totals.redCount === 1 ? "customer is" : "customers are"}</b> on
            sub-15% margin — that&apos;s below the SME reseller healthy threshold.
            On their next renewal, raise the per-seat price by ₹50-100/mo or accept they&apos;ll churn.
          </div>
        </Card>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-3">
          {[1,2,3,4,5].map((i) => <Skeleton key={i} className="h-16 w-full" />)}
        </div>
      ) : failed ? (
        <LoadError what="Customer profitability" onRetry={() => { void refetch(); }} />
      ) : rows.length === 0 ? (
        <Card className="py-2">
          <EmptyState
            icon="users"
            title="No paid customers in this range"
            body="Profitability needs at least one quote that's been marked received / partial / invoiced. Try a longer date range."
          />
        </Card>
      ) : (
        <>
          {/* Desktop */}
          <Card className="hidden md:block overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-paper-2/50 text-3xs uppercase tracking-wider text-ink-3 font-semibold">
                <tr>
                  <th className="text-left  px-4 py-3 w-12"></th>
                  <th className="text-left  px-4 py-3">Customer</th>
                  <th className="text-right px-4 py-3">Quotes</th>
                  <th className="text-right px-4 py-3">Seats</th>
                  <th className="text-right px-4 py-3">Revenue</th>
                  <th className="text-right px-4 py-3">COGS</th>
                  <th className="text-right px-4 py-3">Margin</th>
                  <th className="text-right px-4 py-3">Margin %</th>
                  <th className="text-left  px-4 py-3">Recommended action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-hairline">
                {rows.map((r) => (
                  <tr key={r.customerId ?? r.customerName} className="hover:bg-paper-2/40">
                    <td className="px-4 py-3">
                      <span className={`inline-block w-2.5 h-2.5 rounded-full ${
                        r.health === "green" ? "bg-emerald" :
                        r.health === "amber" ? "bg-amber"   :
                                               "bg-rose"
                      }`} />
                    </td>
                    <td className="px-4 py-3">
                      {r.customerId && canOpenCustomer ? (
                        <Link href={`/customers/${r.customerId}`} className="font-medium text-ink hover:text-amber-ink hover:underline">
                          {r.customerName}
                        </Link>
                      ) : (
                        <span className="font-medium text-ink">{r.customerName}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-ink-3 font-mono">{r.quoteCount}</td>
                    <td className="px-4 py-3 text-right text-ink-3 font-mono">{r.seatCount}</td>
                    <td className="px-4 py-3 text-right text-ink font-mono">{rupee(r.revenue)}</td>
                    <td className="px-4 py-3 text-right text-rose font-mono">{rupee(r.cogs)}</td>
                    <td className="px-4 py-3 text-right font-semibold font-mono">
                      <span className={r.margin >= 0 ? "text-emerald" : "text-rose"}>
                        {rupee(r.margin)}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      <Badge color={r.health === "green" ? "emerald" : r.health === "amber" ? "amber" : "rose"}>
                        {r.marginPct.toFixed(1)}%
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-xs text-ink-2">{r.action}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot className="bg-paper-2/30 border-t-2 border-ink">
                <tr>
                  <td colSpan={2} className="px-4 py-3 text-2xs uppercase tracking-wider text-ink-3 font-semibold">
                    Total ({rows.length})
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-ink-3">
                    {rows.reduce((s, r) => s + r.quoteCount, 0)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-ink-3">
                    {rows.reduce((s, r) => s + r.seatCount, 0)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-ink">{rupee(totals.revenue)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-rose">{rupee(totals.cogs)}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold">
                    <span className={totals.margin >= 0 ? "text-emerald" : "text-rose"}>
                      {rupee(totals.margin)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right font-serif text-lg text-ink">
                    {totals.marginPct.toFixed(1)}%
                  </td>
                  <td />
                </tr>
              </tfoot>
            </table>
          </Card>

          {/* Mobile */}
          <ul className="md:hidden space-y-2.5">
            {rows.map((r) => (
              <li key={r.customerId ?? r.customerName}>
                <Card className="p-4">
                  <div className="flex items-start gap-2.5 mb-2">
                    <span className={`mt-1.5 inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${
                      r.health === "green" ? "bg-emerald" :
                      r.health === "amber" ? "bg-amber"   :
                                             "bg-rose"
                    }`} />
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-ink leading-tight">
                        {r.customerId && canOpenCustomer ? (
                          <Link href={`/customers/${r.customerId}`} className="hover:text-amber-ink">
                            {r.customerName}
                          </Link>
                        ) : r.customerName}
                      </div>
                      <div className="text-xs text-ink-3 mt-0.5">
                        {r.quoteCount} {r.quoteCount === 1 ? "quote" : "quotes"} · {r.seatCount} seats
                      </div>
                    </div>
                    <Badge color={r.health === "green" ? "emerald" : r.health === "amber" ? "amber" : "rose"}>
                      {r.marginPct.toFixed(1)}%
                    </Badge>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-xs mb-2">
                    <div>
                      <div className="text-ink-3 uppercase tracking-wider">Revenue</div>
                      <div className="font-mono text-ink">{rupee(r.revenue)}</div>
                    </div>
                    <div>
                      <div className="text-ink-3 uppercase tracking-wider">COGS</div>
                      <div className="font-mono text-rose">{rupee(r.cogs)}</div>
                    </div>
                    <div>
                      <div className="text-ink-3 uppercase tracking-wider">Margin</div>
                      <div className={`font-mono font-semibold ${r.margin >= 0 ? "text-emerald" : "text-rose"}`}>
                        {rupee(r.margin)}
                      </div>
                    </div>
                  </div>
                  <div className="text-xs text-ink-3 italic">{r.action}</div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────
// KPI primitive
// ────────────────────────────────────────────────────────────────

function KPI({
  label, value, hint, tone, big,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: "emerald" | "rose" | "amber";
  big?: boolean;
}) {
  const colorClass = tone === "emerald" ? "text-emerald"
                   : tone === "rose"    ? "text-rose"
                   : tone === "amber"   ? "text-amber-ink"
                   : "text-ink";
  return (
    <Card className="p-3 md:p-4">
      <div className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-1">{label}</div>
      <div className={`font-serif ${big ? "text-2xl md:text-3xl" : "text-xl md:text-2xl"} ${colorClass} leading-tight`}>
        {value}
      </div>
      {hint && <div className="text-xs text-ink-3 mt-1">{hint}</div>}
    </Card>
  );
}
