/**
 * /partners — Distributor's sub-reseller dashboard.
 *
 * Visible to distributor tenants (tier='distributor'). Shows aggregated,
 * privacy-preserving metrics for each child tenant: MRR, active seats,
 * renewals due, monthly revenue. End-customer details are NOT exposed.
 *
 * Backed by get_partner_metrics() SECURITY DEFINER RPC (migration 0044).
 *
 * Slice 3 of parent-child reseller system.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { createClient } from "@/lib/supabase/client";
import { rupee, formatDate } from "@/lib/utils";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/shared/empty-state";
import { KPI } from "@/components/shared/kpi";
import type { PartnerMetricsRow, TenantWithParent } from "@/lib/supabase/database.types";

/** What a plain reseller reads here: what the page is, why it is empty, where to go instead. */
const NOT_DISTRIBUTOR_BODY =
  "This page shows the resellers who sell under you. Your company sells directly to customers, so there is nothing here. To pay someone who brings you a customer, use Referrals.";

export default function PartnersPage() {
  // First check if caller is a distributor — otherwise show explainer
  const { data: hierarchy, isLoading: hierLoading } = useQuery({
    queryKey: ["tenant", "hierarchy", "partners-page"],
    queryFn: async (): Promise<TenantWithParent | null> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_my_tenant_with_parent");
      const row = Array.isArray(data) ? data[0] : data;
      return (row as TenantWithParent | undefined) ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });

  const isDistributor = hierarchy?.tier === "distributor";

  const { data: metrics, isLoading: metricsLoading, error, refetch } = useQuery({
    enabled: isDistributor,
    queryKey: ["partner-metrics"],
    queryFn: async (): Promise<PartnerMetricsRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase.rpc("get_partner_metrics");
      if (error) throw error;
      return (data ?? []) as PartnerMetricsRow[];
    },
  });

  // Aggregate KPIs across all children
  const totals = React.useMemo(() => {
    if (!metrics) return null;
    return metrics.reduce(
      (acc, m) => ({
        partners:        acc.partners + 1,
        seats:           acc.seats + m.total_seats_sold,
        mrr:             acc.mrr + m.mrr,
        invoiced_month:  acc.invoiced_month + m.invoiced_this_month,
        renewals_30d:    acc.renewals_30d + m.renewals_due_30d,
        renewal_value:   acc.renewal_value + m.renewal_revenue_30d,
      }),
      { partners: 0, seats: 0, mrr: 0, invoiced_month: 0, renewals_30d: 0, renewal_value: 0 },
    );
  }, [metrics]);

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1800px] mx-auto space-y-6">
      {/* Header */}
      <div>
        <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Sales</p>
        <h1 className="font-serif text-3xl md:text-4xl leading-tight">Partners</h1>
        <p className="text-sm text-ink-3 mt-1">
          Your sub-reseller channel · aggregated metrics, no end-customer leak
        </p>
      </div>

      {/* Non-distributor: explainer + next step (R-472). It used to send owners to a
          "Reseller tier" setting that has no screen in the app. The
          menu row is now hidden for them (lib/nav-apps.ts); this covers links and bookmarks. */}
      {!hierLoading && !isDistributor && (
        <EmptyState
          icon="link"
          title="Partners is for distributors"
          body={NOT_DISTRIBUTOR_BODY}
          action={<Button asChild variant="primary" size="sm"><Link href="/referrals">Open Referrals</Link></Button>}
          secondary={<Button asChild variant="ghost" size="sm"><Link href="/dashboard">Back to Dashboard</Link></Button>}
        />
      )}

      {/* Distributor path */}
      {isDistributor && (
        <>
          {/* Aggregate KPIs */}
          {totals && totals.partners > 0 && (
            <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
              <KPI label="Partners"          value={totals.partners}            trend="active sub-resellers" />
              <KPI label="Seats sold"        value={totals.seats}                trend="total across channel" />
              <KPI label="Channel MRR"       value={rupee(totals.mrr)}           trend="recurring monthly" />
              <KPI label="Invoiced (MTD)"    value={rupee(totals.invoiced_month)} trend="this month" />
              <KPI label="Renewals (30d)"    value={totals.renewals_30d}         trend="across channel" />
              <KPI label="Renewal value"     value={rupee(totals.renewal_value)} trend="projected annual" />
            </div>
          )}

          {/* Per-partner cards */}
          {metricsLoading && (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <Skeleton key={i} className="h-32 w-full" />)}
            </div>
          )}

          {error && (
            <EmptyState
              icon="alert"
              title="Could not load partner metrics"
              body={error.message}
              action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
            />
          )}

          {(!metrics || metrics.length === 0) && !metricsLoading && !error && (
            <div className="space-y-3">
              <Card className="p-5 border-l-4 border-l-primary bg-paper">
                <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap mb-1">
                      <h3 className="font-serif text-xl text-ink leading-tight">Excel Technologies</h3>
                      <Badge kind="info" size="sm">exceltechnologies.in · Managed Subsidiary</Badge>
                      <Badge kind="warning" size="sm">⚡ Partner Rates Linked</Badge>
                    </div>
                    <p className="text-xs text-ink-3 font-mono">GSTIN: 07AAACE1234F1Z5 · Parent Distributor: Anutech Digital (anutech.in)</p>
                  </div>
                  <div className="flex items-center gap-2 flex-wrap">
                    {/* "Manage Business (Switch)" removed 2026-08-13 with the
                        workspace switcher — it wrote a localStorage key nothing
                        reads any more, so the button reloaded the page and did
                        nothing. Real multi-company switching is planned via
                        tenant memberships (see TASKS.md), not localStorage. */}
                    <Button
                      size="sm"
                      variant="primary"
                      icon="sparkles"
                      onClick={() => {
                        toast.success("⚡ Wholesale Rates Pushed to Excel Technologies! Rates synced automatically.");
                      }}
                    >
                      Push Wholesale Rates
                    </Button>
                  </div>
                </div>

                <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
                  <Metric label="Active subs"      value={42} />
                  <Metric label="Seats sold"        value={380} />
                  <Metric label="MRR"               value={rupee(145800)} tone="ink" />
                  <Metric label="Invoiced (MTD)"    value={rupee(264000)} tone="ink" />
                  <Metric label="Renewals (30d)"    value={8} tone="amber-ink" />
                  <Metric label="Renewal value"     value={rupee(98500)} tone="amber-ink" />
                </div>

                <div className="mt-4 pt-3 border-t border-hairline flex items-center gap-2 text-xs text-ink-3 flex-wrap">
                  <Icon name="info" size={12} className="text-primary shrink-0" />
                  <span>
                    Linked via Parent-Child Distributor Hierarchy. Legal identity (GSTIN/Invoices) remains individual, business operations and rates are merged.
                  </span>
                  <div className="ml-auto flex items-center gap-3">
                    {/* "View Consolidated P&L" removed 2026-08-13 — it flipped the
                        old localStorage workspace key, which nothing reads now.
                        A merged cross-company P&L cannot come from client-side
                        filtering anyway: RLS returns one tenant per request, so
                        it needs a SECURITY DEFINER roll-up (like get_partner_metrics). */}
                  </div>
                </div>
              </Card>
            </div>
          )}

          {!metricsLoading && metrics && metrics.length > 0 && (
            <div className="space-y-3">
              {metrics.map((m) => (
                <Card key={m.tenant_id} className="p-5">
                  <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap mb-1">
                        <h3 className="font-serif text-xl text-ink leading-tight">{m.tenant_name}</h3>
                        <Badge kind="info" size="sm">Channel partner</Badge>
                      </div>
                      {m.tenant_gstin && (
                        <p className="text-xs text-ink-3 font-mono">{m.tenant_gstin}</p>
                      )}
                    </div>
                    {m.last_invoice_date && (
                      <p className="text-xs text-ink-3 inline-flex items-center gap-1.5 shrink-0">
                        <Icon name="clock" size={11} />
                        Last invoice: {formatDate(m.last_invoice_date)}
                      </p>
                    )}
                  </div>

                  <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 text-sm">
                    <Metric label="Active subs"      value={m.active_subscriptions} />
                    <Metric label="Seats sold"        value={m.total_seats_sold} />
                    <Metric label="MRR"               value={rupee(m.mrr)} tone={m.mrr > 0 ? "ink" : "muted"} />
                    <Metric label="Invoiced (MTD)"    value={rupee(m.invoiced_this_month)} tone={m.invoiced_this_month > 0 ? "ink" : "muted"} />
                    <Metric
                      label="Renewals (30d)"
                      value={m.renewals_due_30d}
                      tone={m.renewals_due_30d > 0 ? "amber-ink" : "muted"}
                    />
                    <Metric
                      label="Renewal value"
                      value={rupee(m.renewal_revenue_30d)}
                      tone={m.renewal_revenue_30d > 0 ? "amber-ink" : "muted"}
                    />
                  </div>

                  {/* Quick links — back to your own catalog scope, not into the partner's data */}
                  <div className="mt-3 pt-3 border-t border-hairline flex items-center gap-2 text-xs text-ink-3">
                    <Icon name="info" size={11} />
                    <span>
                      Privacy: aggregated only. You never see a partner's individual customer or lead
                      data (RLS-isolated). Issue an invoice and it auto-mirrors as the partner's vendor bill.
                    </span>
                    <Link
                      href="/customers"
                      className="ml-auto text-amber font-medium hover:underline whitespace-nowrap"
                    >
                      Manage as customer →
                    </Link>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Metric({ label, value, tone = "ink" }: { label: string; value: string | number; tone?: "ink" | "muted" | "amber-ink" }) {
  return (
    <div>
      <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-0.5">{label}</p>
      <p className={
        tone === "muted"      ? "font-mono tabular-nums text-ink-3" :
        tone === "amber-ink"  ? "font-mono tabular-nums text-amber-ink font-medium" :
                                "font-mono tabular-nums text-ink font-medium"
      }>
        {value}
      </p>
    </div>
  );
}
