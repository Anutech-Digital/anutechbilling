/**
 * Coupons — admin page.
 *
 * Pardeep manages public-buy-page discount codes here:
 *  - List of all codes with KPIs (count, active, redemptions, total saved)
 *  - Create new code (modal)
 *  - Toggle active / delete (inline actions)
 *  - View per-code redemption audit log
 *
 * Public side: visitors enter the code in the /buy/workspace calculator,
 * validation hits /api/public/coupons/validate (no auth), and real
 * redemption happens inside the checkout route via `redeem_coupon` RPC.
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
import { formatDate, rupee } from "@/lib/utils";
import {
  useCoupons,
  useDeleteCoupon,
  useToggleCoupon,
  useCouponRedemptions,
} from "@/lib/queries/coupons";
import CreateCouponDialog        from "@/components/features/coupons/create-coupon-dialog";
import CouponRedemptionsDialog   from "@/components/features/coupons/coupon-redemptions-dialog";
import { useConfirm }            from "@/components/providers/confirm-provider";
import type { CouponRow }        from "@/lib/supabase/database.types";

function couponStateTone(c: CouponRow): {
  kind: "success" | "warning" | "danger" | "muted";
  label: string;
} {
  if (!c.is_active)                                                       return { kind: "muted",   label: "inactive" };
  if (c.valid_until && new Date(c.valid_until) < new Date())              return { kind: "danger",  label: "expired"  };
  if (c.max_redemptions !== null && c.redemption_count >= c.max_redemptions) return { kind: "warning", label: "maxed out" };
  return { kind: "success", label: "active" };
}

function discountLabel(c: CouponRow): string {
  return c.discount_type === "percent"
    ? `${c.discount_value}% off`
    : `${rupee(c.discount_value)} off`;
}

// One-shot hook to fetch ALL redemptions across coupons. Used to compute
// the "total saved" KPI on the page header — cheap query (< 100 rows in
// practice for small tenants, paginate later if needed).
function useAllRedemptions() {
  return useCouponRedemptions(undefined);
}

export default function CouponsPage() {
  const { data: coupons, isLoading, error, refetch } = useCoupons();
  const { data: allRedemptions } = useAllRedemptions();
  const toggle = useToggleCoupon();
  const del    = useDeleteCoupon();
  const confirm = useConfirm();

  const [createOpen,           setCreateOpen]         = React.useState(false);
  const [viewingRedemptions,   setViewingRedemptions] = React.useState<string | null>(null);

  // KPIs
  const total       = coupons?.length ?? 0;
  const active      = (coupons ?? []).filter((c) => couponStateTone(c).kind === "success").length;
  const totalUses   = (coupons ?? []).reduce((s, c) => s + (c.redemption_count ?? 0), 0);
  const totalSaved  = (allRedemptions ?? []).reduce((s, r) => s + (r.amount_saved ?? 0), 0);

  async function onToggle(c: CouponRow) {
    try {
      await toggle.mutateAsync({ code: c.code, is_active: !c.is_active });
      toast.success(`${c.code} ${!c.is_active ? "activated" : "deactivated"}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not toggle");
    }
  }

  async function onDelete(c: CouponRow) {
    if (!(await confirm({
      title: `Delete coupon "${c.code}"?`,
      body: `This cannot be undone. (${c.redemption_count} redemption${c.redemption_count === 1 ? "" : "s"} on record.)`,
      danger: true,
      confirmLabel: "Delete",
    }))) {
      return;
    }
    try {
      await del.mutateAsync(c.code);
      toast.success(`${c.code} deleted`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not delete");
    }
  }

  function copyToClipboard(code: string) {
    navigator.clipboard?.writeText(code).then(
      () => toast.success(`Copied ${code}`),
      () => toast.error("Could not copy — your browser blocked clipboard access"),
    );
  }

  return (
    <div className="p-4 md:p-6 lg:p-8 max-w-[1500px] mx-auto">
      <div className="flex items-end justify-between gap-3 flex-wrap mb-6">
        <div>
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Engage</p>
          <h1 className="font-serif text-3xl md:text-4xl leading-tight">Coupons</h1>
          <p className="text-sm text-ink-3 mt-1">
            Discount codes for the public buy page · separate from Google promo
          </p>
        </div>
        <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
          New coupon
        </Button>
      </div>

      {!isLoading && coupons && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <KPI label="Total coupons" value={total} />
          <KPI label="Active right now" value={active} icon="check_circle" trendKind={active > 0 ? "up" : undefined} />
          <KPI label="Total redemptions" value={totalUses} icon="receipt" />
          <KPI label="Total saved by customers" value={rupee(totalSaved)} icon="trending_up" />
        </div>
      )}

      {error && (
        <EmptyState
          icon="alert"
          title="Could not load coupons"
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

      {!isLoading && !error && coupons && coupons.length === 0 && (
        <EmptyState
          icon="rupee"
          title="No coupons yet"
          body="Create your first discount code — visitors can apply it on the public buy page (it's separate from any Google promo)."
          action={
            <Button variant="primary" icon="plus" onClick={() => setCreateOpen(true)}>
              Create first coupon
            </Button>
          }
        />
      )}

      {!isLoading && !error && coupons && coupons.length > 0 && (
        <>
          {/* Desktop table */}
          <Card flush className="hidden md:block">
            <table className="w-full">
              <thead className="bg-paper-2 border-b border-hairline">
                <tr>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Code</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Discount</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Tier</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Seats</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Uses</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Expires</th>
                  <th className="text-left p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">State</th>
                  <th className="text-right p-3 text-xs font-semibold text-ink-3 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => {
                  const state = couponStateTone(c);
                  return (
                    <tr key={c.code} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                      <td className="p-3">
                        <button
                          type="button"
                          onClick={() => copyToClipboard(c.code)}
                          className="font-mono text-sm font-semibold text-amber-ink hover:underline inline-flex items-center gap-1"
                          title="Click to copy"
                        >
                          {c.code}
                          <Icon name="copy" size={11} />
                        </button>
                        {c.description && (
                          <div className="text-[11px] text-ink-3 mt-0.5 max-w-[220px] truncate">
                            {c.description}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-sm text-ink-2">{discountLabel(c)}</td>
                      <td className="p-3 text-xs">
                        {c.applies_to_tier ? (
                          <Badge size="sm" kind="info">{c.applies_to_tier}</Badge>
                        ) : (
                          <span className="text-ink-3">any</span>
                        )}
                      </td>
                      <td className="p-3 text-xs text-ink-2 tabular-nums">
                        {c.min_seats}+
                        {c.max_seats != null ? ` · max ${c.max_seats}` : ""}
                      </td>
                      <td className="p-3 text-right">
                        <button
                          type="button"
                          onClick={() => setViewingRedemptions(c.code)}
                          className="text-sm tabular-nums text-ink hover:text-amber-ink hover:underline"
                          title="View redemption log"
                        >
                          {c.redemption_count}
                          {c.max_redemptions != null && (
                            <span className="text-ink-3"> / {c.max_redemptions}</span>
                          )}
                        </button>
                      </td>
                      <td className="p-3 text-xs text-ink-2 tabular-nums">
                        {c.valid_until ? formatDate(c.valid_until) : <span className="text-ink-3">never</span>}
                      </td>
                      <td className="p-3">
                        <Badge kind={state.kind} dot>{state.label}</Badge>
                      </td>
                      <td className="p-3 text-right whitespace-nowrap">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onToggle(c)}
                          disabled={toggle.isPending}
                        >
                          {c.is_active ? "Disable" : "Enable"}
                        </Button>
                        <Button
                          variant="ghost"
                          size="sm"
                          icon="trash"
                          onClick={() => onDelete(c)}
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
            {coupons.map((c) => {
              const state = couponStateTone(c);
              return (
                <li key={c.code}>
                  <Card className="p-3">
                    <div className="flex items-start justify-between gap-2 mb-1.5">
                      <button
                        type="button"
                        onClick={() => copyToClipboard(c.code)}
                        className="font-mono text-sm font-semibold text-amber-ink hover:underline inline-flex items-center gap-1"
                        title="Click to copy"
                      >
                        {c.code}
                        <Icon name="copy" size={11} />
                      </button>
                      <Badge kind={state.kind} dot>{state.label}</Badge>
                    </div>
                    <div className="flex items-center justify-between text-xs mb-2">
                      <span className="text-ink font-medium">{discountLabel(c)}</span>
                      <button
                        type="button"
                        onClick={() => setViewingRedemptions(c.code)}
                        className="tabular-nums text-ink-2 hover:text-amber-ink hover:underline"
                        title="View redemption log"
                      >
                        {c.redemption_count}
                        {c.max_redemptions != null && <span className="text-ink-3"> / {c.max_redemptions}</span>}
                        {" uses"}
                      </button>
                    </div>
                    <div className="text-[11px] text-ink-3 tabular-nums mb-2">
                      {c.min_seats}+ seats
                      {c.max_seats != null ? ` · max ${c.max_seats}` : ""}
                      {" · "}
                      {c.valid_until ? `expires ${formatDate(c.valid_until)}` : "no expiry"}
                    </div>
                    <div className="flex items-center gap-1 pt-1 border-t border-hairline">
                      <Button variant="ghost" size="sm" onClick={() => onToggle(c)} disabled={toggle.isPending}>
                        {c.is_active ? "Disable" : "Enable"}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        icon="trash"
                        onClick={() => onDelete(c)}
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

      {!isLoading && coupons && coupons.length > 0 && (
        <p className="text-[11px] text-ink-3 mt-3 flex items-center gap-1.5">
          <Icon name="info" size={11} />
          Live on the public <span className="font-mono text-ink-2">/buy/workspace</span> page. Discount is applied pre-GST, then 18% GST recomputed on the discounted base.
        </p>
      )}

      {createOpen && (
        <CreateCouponDialog open={createOpen} onOpenChange={setCreateOpen} />
      )}

      {viewingRedemptions && (
        <CouponRedemptionsDialog
          open={!!viewingRedemptions}
          onOpenChange={(v) => !v && setViewingRedemptions(null)}
          code={viewingRedemptions}
        />
      )}

      <FAB icon="plus" label="Coupon" onClick={() => setCreateOpen(true)} ariaLabel="New coupon" />
    </div>
  );
}
