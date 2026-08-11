/**
 * Campaigns — history + new send entry point.
 *
 * Lists previously sent campaigns with delivery stats. "New campaign"
 * button opens the composer dialog (same one available from Leads page).
 */

"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { KPI } from "@/components/shared/kpi";
import { Icon } from "@/components/ui/icon";
import { FAB } from "@/components/ui/fab";
import { formatDate } from "@/lib/utils";
import CampaignComposerDialog from "@/components/features/campaigns/campaign-composer-dialog";
import type { CampaignRow } from "@/lib/supabase/database.types";

function useCampaigns() {
  return useQuery({
    queryKey: ["campaigns"],
    queryFn: async (): Promise<CampaignRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("campaigns")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as CampaignRow[];
    },
  });
}

const STATUS_TONE: Record<string, "success"|"info"|"warning"|"danger"|"muted"> = {
  draft:     "muted",
  sending:   "info",
  sent:      "success",
  failed:    "danger",
  cancelled: "muted",
};

export default function CampaignsPage() {
  const [composerOpen, setComposerOpen] = React.useState(false);
  const { data: campaigns, isLoading, error, refetch } = useCampaigns();

  // KPIs
  const total       = campaigns?.length ?? 0;
  const sent        = (campaigns ?? []).reduce((s, c) => s + c.sent_count, 0);
  const failed      = (campaigns ?? []).reduce((s, c) => s + c.failed_count, 0);
  const reach       = (campaigns ?? []).reduce((s, c) => s + c.recipients_count, 0);
  const successRate = reach > 0 ? Math.round((sent / reach) * 100) : 0;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1500px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Engage</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Campaigns</h1>
          <p className="text-sm text-ink-3 mt-1">Newsletters, offers, win-backs — sent to filtered lead audiences</p>
        </div>
        <Button variant="primary" icon="send" onClick={() => setComposerOpen(true)}>
          New campaign
        </Button>
      </div>

      {!isLoading && campaigns && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KPI label="Total campaigns" value={total} />
          <KPI label="Total reach"     value={reach}      icon="users" />
          <KPI label="Delivered"       value={sent}       trend={`${successRate}% success rate`} trendKind="up" icon="check_circle" />
          <KPI label="Failed"          value={failed}     trendKind={failed > 0 ? "down" : undefined} icon={failed > 0 ? "alert" : "check_circle"} />
        </div>
      )}

      {error && (
        <EmptyState
          icon="alert"
          title="Could not load campaigns"
          body={error.message}
          action={<Button icon="refresh" onClick={() => refetch()}>Try again</Button>}
        />
      )}

      {isLoading && (
        <Card flush>
          <div className="p-3 space-y-3">
            {[1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        </Card>
      )}

      {!isLoading && !error && campaigns && campaigns.length === 0 && (
        <EmptyState
          icon="send"
          title="No campaigns yet"
          body="Send your first newsletter or offer — pick a lead audience, write a quick message, and broadcast in one click."
          action={
            <Button variant="primary" icon="send" onClick={() => setComposerOpen(true)}>
              Send first campaign
            </Button>
          }
        />
      )}

      {!isLoading && !error && campaigns && campaigns.length > 0 && (
        <>
          {/* Desktop table */}
          <Card flush className="hidden md:block">
              <table className="w-full">
                <thead className="bg-paper-2 border-b border-hairline">
                  <tr>
                    <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Campaign</th>
                    <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Subject</th>
                    <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Offer</th>
                    <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Reach</th>
                    <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Delivered</th>
                    <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Failed</th>
                    <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Status</th>
                    <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                      <td className="p-3">
                        <div className="font-medium text-sm text-ink">{c.name}</div>
                      </td>
                      <td className="p-3 text-sm text-ink-2 max-w-[280px] truncate">{c.subject}</td>
                      <td className="p-3 text-xs">
                        {c.offer_code ? (
                          <>
                            <span className="font-mono text-amber-ink">{c.offer_code}</span>
                            <span className="text-ink-3"> · {c.offer_discount_pct}%</span>
                          </>
                        ) : (
                          <span className="text-ink-3">—</span>
                        )}
                      </td>
                      <td className="p-3 text-right tabular-nums text-sm">{c.recipients_count}</td>
                      <td className="p-3 text-right tabular-nums text-sm text-emerald">{c.sent_count}</td>
                      <td className="p-3 text-right tabular-nums text-sm">
                        {c.failed_count > 0 ? <span className="text-rose">{c.failed_count}</span> : <span className="text-ink-3">0</span>}
                      </td>
                      <td className="p-3">
                        <Badge kind={STATUS_TONE[c.status] ?? "muted"} dot>
                          {c.status}
                        </Badge>
                      </td>
                      <td className="p-3 text-xs text-ink-3 tabular-nums">
                        {c.sent_at ? formatDate(c.sent_at) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
          </Card>

          {/* Mobile card list */}
          <ul className="md:hidden space-y-2">
            {campaigns.map((c) => (
              <li key={c.id}>
                <Card className="p-3">
                  <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="font-medium text-ink leading-tight">{c.name}</div>
                    <Badge kind={STATUS_TONE[c.status] ?? "muted"} dot>{c.status}</Badge>
                  </div>
                  {c.subject && (
                    <div className="text-xs text-ink-2 truncate mb-2">{c.subject}</div>
                  )}
                  <div className="flex items-center justify-between text-xs">
                    <div className="flex items-center gap-3 tabular-nums">
                      <span className="text-ink-2">{c.recipients_count} reach</span>
                      <span className="text-emerald">{c.sent_count} sent</span>
                      {c.failed_count > 0 && <span className="text-rose">{c.failed_count} failed</span>}
                    </div>
                    <span className="text-ink-3 tabular-nums">{c.sent_at ? formatDate(c.sent_at) : "—"}</span>
                  </div>
                </Card>
              </li>
            ))}
          </ul>
        </>
      )}

      {!isLoading && campaigns && campaigns.length > 0 && (
        <p className="text-[11px] text-ink-3 mt-3 flex items-center gap-1.5">
          <Icon name="info" size={11} />
          Click <Link href={"/leads" as never} className="text-amber-ink hover:underline">/leads</Link> to fine-tune audience before broadcasting.
        </p>
      )}

      {composerOpen && (
        <CampaignComposerDialog open={composerOpen} onOpenChange={setComposerOpen} />
      )}

      <FAB icon="send" label="Campaign" onClick={() => setComposerOpen(true)} ariaLabel="New campaign" />
    </div>
  );
}
