"use client";

/* Moved out of app/(app)/dashboard/page.tsx unchanged (R-2239, to keep the page under max-lines). */
import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import type { PartnerMetricsRow, TenantWithParent } from "@/lib/supabase/database.types";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { rupee } from "@/lib/utils";

// ============================================================
// PartnerRenewalAlertCard (Slice 4 — distributor inventory alerts)
// ============================================================

/**
 * Banner-style card shown on a distributor tenant's dashboard summarising
 * upcoming renewals across all sub-resellers. Lets Demo Co see "Anutech
 * has X seats renewing this month — confirm Google Workspace inventory"
 * at a glance, without having to navigate to /partners.
 *
 * Only renders when:
 *   • caller's tenant tier = 'distributor'
 *   • at least one partner has renewals_due_30d > 0
 *
 * Re-uses get_partner_metrics() RPC from Slice 3 — no extra schema needed.
 */
export function PartnerRenewalAlertCard() {
  const { data: hierarchy } = useQuery({
    queryKey: ["tenant", "hierarchy", "dashboard-partner-alert"],
    queryFn: async (): Promise<TenantWithParent | null> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_my_tenant_with_parent");
      const row = Array.isArray(data) ? data[0] : data;
      return (row as TenantWithParent | undefined) ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });

  const isDistributor = hierarchy?.tier === "distributor";

  const { data: metrics } = useQuery({
    enabled: isDistributor,
    queryKey: ["partner-metrics", "dashboard-summary"],
    queryFn: async (): Promise<PartnerMetricsRow[]> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_partner_metrics");
      return (data ?? []) as PartnerMetricsRow[];
    },
  });

  const totals = React.useMemo(() => {
    if (!metrics) return null;
    return metrics.reduce(
      (acc, m) => ({
        renewals:        acc.renewals + m.renewals_due_30d,
        renewal_value:   acc.renewal_value + m.renewal_revenue_30d,
        partners_w_due:  acc.partners_w_due + (m.renewals_due_30d > 0 ? 1 : 0),
      }),
      { renewals: 0, renewal_value: 0, partners_w_due: 0 },
    );
  }, [metrics]);

  if (!isDistributor) return null;
  if (!totals || totals.renewals === 0) return null;

  return (
    <Card className="p-4 mb-6 bg-amber-soft/40 border-amber-soft">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="h-9 w-9 rounded-lg bg-amber/15 text-amber-ink flex items-center justify-center shrink-0">
          <Icon name="alert" size={16} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">
            <b className="text-amber-ink">{totals.renewals}</b> partner renewal
            {totals.renewals === 1 ? "" : "s"} due in 30 days
            <span className="text-ink-3 font-normal"> ·</span>
            <span className="text-ink-2 font-mono font-medium ml-1.5">{rupee(totals.renewal_value)}</span>
            <span className="text-ink-3 font-normal text-xs ml-1">projected annual</span>
          </p>
          <p className="text-2xs text-ink-3">
            {totals.partners_w_due} of your sub-reseller{totals.partners_w_due === 1 ? "" : "s"} have customer renewals coming up. Confirm inventory + cash flow.
          </p>
        </div>
        <Button asChild variant="ghost" size="sm" icon="link">
          <Link href={"/partners" as any}>View partners →</Link>
        </Button>
      </div>
    </Card>
  );
}
