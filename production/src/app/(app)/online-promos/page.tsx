/**
 * Online Promos — admin page.
 *
 * Manages automatic site-wide discounts shown as a banner on the public
 * buy page (/buy/workspace). Different from coupons (where visitor types
 * a code): these auto-apply to every visitor, no input needed.
 *
 * Stacks BELOW Google promo (from catalog) and ABOVE any visitor-entered
 * coupon code.
 *
 * Pardeep typically has ONE promo live at a time — UI gently surfaces
 * "more than one active" as a warning. The /api/public/site-promo/current
 * endpoint picks the most-recently-updated active one.
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Icon } from "@/components/ui/icon";
import { FAB } from "@/components/ui/fab";
import { EmptyState } from "@/components/shared/empty-state";
import { KPI } from "@/components/shared/kpi";
import { formatDate, rupee, cn } from "@/lib/utils";
import {
  useSitePromos,
  useToggleSitePromo,
  useDeleteSitePromo,
} from "@/lib/queries/site-promos";
import CreatePromoDialog from "@/components/features/site-promos/create-promo-dialog";
import { useConfirm } from "@/components/providers/confirm-provider";
import type { SitePromoRow, SitePromoBannerStyle } from "@/lib/supabase/database.types";

function bannerBg(style: SitePromoBannerStyle): string {
  switch (style) {
    case "rose":    return "bg-gradient-to-r from-rose-500 to-rose-600";
    case "emerald": return "bg-gradient-to-r from-emerald-500 to-emerald-600";
    case "indigo":  return "bg-gradient-to-r from-indigo-500 to-indigo-600";
    case "ink":     return "bg-gradient-to-r from-ink to-ink/80";
    case "amber":
    default:        return "bg-gradient-to-r from-amber-500 to-amber-600";
  }
}

function promoStateTone(p: SitePromoRow): {
  kind: "success" | "warning" | "danger" | "muted";
  label: string;
} {
  if (!p.is_active)                                                        return { kind: "muted",  label: "paused" };
  if (p.valid_until && new Date(p.valid_until) < new Date())               return { kind: "danger", label: "expired" };
  if (new Date(p.valid_from) > new Date())                                 return { kind: "warning", label: "scheduled" };
  return { kind: "success", label: "live" };
}

function discountLabel(p: SitePromoRow): string {
  return p.discount_type === "percent"
    ? `${p.discount_value}% off`
    : `${rupee(p.discount_value)} off`;
}

export default function OnlinePromosPage() {
  const { data: promos, isLoading, error, refetch } = useSitePromos();
  const toggle = useToggleSitePromo();
  const del    = useDeleteSitePromo();
  const confirm = useConfirm();

  const [createOpen, setCreateOpen] = React.useState(false);

  const total      = promos?.length ?? 0;
  const liveNow    = (promos ?? []).filter((p) => promoStateTone(p).kind === "success").length;
  const scheduled  = (promos ?? []).filter((p) => promoStateTone(p).kind === "warning").length;
  const expired    = (promos ?? []).filter((p) => promoStateTone(p).kind === "danger").length;

  async function onToggle(p: SitePromoRow) {
    try {
      await toggle.mutateAsync({ id: p.id, is_active: !p.is_active });
      toast.success(`${p.headline.slice(0, 30)} ${!p.is_active ? "is now LIVE" : "paused"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not toggle");
    }
  }

  async function onDelete(p: SitePromoRow) {
    if (!(await confirm({ title: `Delete promo "${p.headline}"?`, body: "This removes it from the buy page immediately.", confirmLabel: "Delete", danger: true }))) {
      return;
    }
    try {
      await del.mutateAsync(p.id);
      toast.success("Promo deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  }

  // The active list, sorted by updated_at desc — top is the one that wins
  // on the buy page when multiple are active.
  const activePromos = (promos ?? []).filter((p) => promoStateTone(p).kind === "success");
  const winning      = activePromos[0] ?? null;

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1500px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Engage</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Online Promos</h1>
          <p className="text-sm text-ink-3 mt-1">
            Auto-applied banner sales on the public buy page · no code required
          </p>
        </div>
        <Button variant="primary" icon="zap" onClick={() => setCreateOpen(true)}>
          Launch promo
        </Button>
      </div>

      {!isLoading && promos && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KPI label="Total promos" value={total} />
          <KPI label="Live right now" value={liveNow} icon="zap" trendKind={liveNow > 0 ? "up" : undefined} />
          <KPI label="Scheduled"     value={scheduled} icon="clock" />
          <KPI label="Expired"       value={expired} icon="alert" />
        </div>
      )}

      {/* "What's live" preview banner — exactly what the visitor will see */}
      {winning && (
        <div className="mb-6">
          <p className="text-[10px] uppercase tracking-wider text-ink-3 font-semibold mb-2">
            Currently live on <code className="font-mono text-ink-2">/buy/workspace</code>
          </p>
          <div className={cn("rounded-lg px-4 py-3 text-paper shadow-lg", bannerBg(winning.banner_style))}>
            <div className="flex items-center gap-3 flex-wrap">
              {winning.badge_text && (
                <span className="text-[10px] uppercase tracking-wider font-semibold bg-paper/20 backdrop-blur px-2 py-1 rounded-full">
                  {winning.badge_text}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-serif text-base sm:text-lg leading-tight">{winning.headline}</div>
                {winning.subheadline && (
                  <div className="text-[11px] sm:text-xs opacity-90 mt-0.5">{winning.subheadline}</div>
                )}
              </div>
              <span className="font-mono text-xs bg-paper text-ink px-2 py-1 rounded font-semibold whitespace-nowrap">
                {discountLabel(winning)}
              </span>
            </div>
          </div>
          {activePromos.length > 1 && (
            <p className="text-[11px] text-amber-ink mt-2 inline-flex items-center gap-1.5">
              <Icon name="alert" size={11} />
              {activePromos.length} promos are active — only the most-recently-updated one shows on the buy page.
            </p>
          )}
        </div>
      )}

      {error && (
        <EmptyState
          icon="alert"
          title="Could not load promos"
          body={error instanceof Error ? error.message : "Unknown error"}
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

      {!isLoading && !error && promos && promos.length === 0 && (
        <EmptyState
          icon="zap"
          title="No promos yet"
          body="Launch your first online sale — auto-applied banner discount on /buy/workspace, no code required. Stacks below Google's promo, above coupons."
          action={
            <Button variant="primary" icon="zap" onClick={() => setCreateOpen(true)}>
              Launch first promo
            </Button>
          }
        />
      )}

      {!isLoading && !error && promos && promos.length > 0 && (
        <>
          {/* Desktop table */}
          <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Headline</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Discount</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Tier</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Seats</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Ends</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">State</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {promos.map((p) => {
                  const state = promoStateTone(p);
                  return (
                    <tr key={p.id} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                      <td className="p-3">
                        <div className="flex items-center gap-2">
                          <span className={cn("inline-block w-2 h-6 rounded-full", bannerBg(p.banner_style))} />
                          <div className="min-w-0">
                            <div className="font-medium text-sm text-ink truncate max-w-[280px]">{p.headline}</div>
                          </div>
                        </div>
                      </td>
                      <td className="p-3 text-sm text-ink-2 whitespace-nowrap">{discountLabel(p)}</td>
                      <td className="p-3 text-xs">
                        {p.applies_to_tier ? (
                          <Badge size="sm" kind="info">{p.applies_to_tier}</Badge>
                        ) : (
                          <span className="text-ink-3">all</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-ink-2 tabular-nums">
                        {p.min_seats}+
                        {p.max_seats != null ? ` · max ${p.max_seats}` : ""}
                      </td>
                      <td className="p-3 text-xs text-ink-2 tabular-nums">
                        {p.valid_until ? formatDate(p.valid_until) : <span className="text-ink-3">never</span>}
                      </td>
                      <td className="p-3">
                        <Badge kind={state.kind} dot>{state.label}</Badge>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onToggle(p)}
                          disabled={toggle.isPending}
                        >
                          {p.is_active ? "Pause" : "Resume"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="trash"
                          onClick={() => onDelete(p)}
                          disabled={del.isPending}
                          className="text-rose hover:text-rose"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Card>

          {/* Mobile card list */}
          <ul className="md:hidden space-y-2">
            {promos.map((p) => {
              const state = promoStateTone(p);
              return (
                <li key={p.id}>
                  <Card className="p-3">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={cn("inline-block w-1.5 h-6 rounded-full shrink-0", bannerBg(p.banner_style))} />
                        <div className="font-medium text-ink leading-tight truncate">{p.headline}</div>
                      </div>
                      <Badge kind={state.kind} dot>{state.label}</Badge>
                    </div>
                    <div className="flex items-center justify-between text-xs mb-2">
                      <span className="text-ink font-medium">{discountLabel(p)}</span>
                      <span className="text-ink-3 tabular-nums">
                        {p.valid_until ? `ends ${formatDate(p.valid_until)}` : "no end date"}
                      </span>
                    </div>
                    <div className="text-[11px] text-ink-3 tabular-nums mb-2">
                      {p.min_seats}+ seats
                      {p.max_seats != null ? ` · max ${p.max_seats}` : ""}
                      {p.applies_to_tier ? ` · ${p.applies_to_tier}` : ""}
                    </div>
                    <div className="flex items-center gap-1 pt-1 border-t border-hairline">
                      <Button variant="ghost" size="sm" onClick={() => onToggle(p)} disabled={toggle.isPending}>
                        {p.is_active ? "Pause" : "Resume"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        onClick={() => onDelete(p)}
                        disabled={del.isPending}
                        className="text-rose hover:text-rose ml-auto"
                      />
                    </div>
                  </Card>
                </li>
              );
            })}
          </ul>
        </>
      )}

      {!isLoading && promos && promos.length > 0 && (
        <p className="text-[11px] text-ink-3 mt-3 flex items-center gap-1.5">
          <Icon name="info" size={11} />
          Stacks below Google promo (catalog), above any visitor coupon code. Discount is applied pre-GST; 18% GST recomputed on the discounted subtotal.
        </p>
      )}

      {createOpen && (
        <CreatePromoDialog open={createOpen} onOpenChange={setCreateOpen} />
      )}

      <FAB icon="zap" label="Promo" onClick={() => setCreateOpen(true)} ariaLabel="Launch promo" />
    </div>
  );
}
