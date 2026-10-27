/**
 * CouponRedemptionsDialog — read-only audit log for one coupon code.
 *
 * Shows every successful redemption (one row per visitor-buy) so Pardeep
 * can verify the campaign worked, see who claimed it, and reconcile
 * discount given.
 */

"use client";

import * as React from "react";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Badge } from "@/components/ui/badge";
import { formatDate, rupee } from "@/lib/utils";
import { useCouponRedemptions } from "@/lib/queries/coupons";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  code: string | null;
  /** R-1981: the campaign the coupon belongs to (coupons.campaign_id), or null. */
  campaignName?: string | null;
}

export default function CouponRedemptionsDialog({ open, onOpenChange, code, campaignName }: Props) {
  const { data, isLoading, error } = useCouponRedemptions(code ?? undefined);

  const totalSaved = (data ?? []).reduce((s, r) => s + (r.amount_saved ?? 0), 0);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">
            Audit log
          </p>
          <h2 className="font-serif text-2xl text-ink">
            Redemptions · <span className="font-mono text-amber-ink">{code ?? "—"}</span>
          </h2>
          <p className="text-xs text-ink-3 mt-1">
            One row per successful claim. Discount totals what we gave back to customers.
          </p>
          <p className="text-xs text-ink-3 mt-1">
            Campaign: <span className="text-ink-2 font-medium">{campaignName || "No campaign"}</span>
          </p>
        </header>

        {isLoading && (
          <div className="space-y-2">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        )}

        {error && (
          <EmptyState
            icon="alert"
            title="Could not load redemptions"
            body={error instanceof Error ? error.message : "Unknown error"}
          />
        )}

        {!isLoading && !error && data && data.length === 0 && (
          <EmptyState
            icon="receipt"
            title="No redemptions yet"
            body="This coupon hasn't been used. Share the code with leads via WhatsApp or campaigns."
          />
        )}

        {!isLoading && !error && data && data.length > 0 && (
          <>
            <div className="mb-3 flex items-center gap-3 text-xs text-ink-3">
              <span><b className="text-ink">{data.length}</b> redemption{data.length === 1 ? "" : "s"}</span>
              <span aria-hidden>·</span>
              <span>Total saved: <b className="text-emerald">{rupee(totalSaved)}</b></span>
            </div>
            <div className="overflow-x-auto -mx-2">
              <table className="w-full">
                <thead className="bg-paper-2 border-b border-hairline">
                  <tr>
                    <th className="text-left p-2 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Redeemed</th>
                    <th className="text-left p-2 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Contact</th>
                    <th className="text-left p-2 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Tier · Seats</th>
                    <th className="text-left p-2 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Quote</th>
                    <th className="text-right p-2 text-3xs font-semibold text-ink-3 uppercase tracking-wider">Saved</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((r) => (
                    <tr key={r.id} className="border-b border-hairline last:border-0 hover:bg-paper-2/40">
                      <td className="p-2 text-xs text-ink-2 tabular-nums">
                        {formatDate(r.redeemed_at)}
                      </td>
                      <td className="p-2">
                        <div className="text-sm text-ink">{r.contact_name ?? "—"}</div>
                        <div className="text-xs text-ink-3">{r.contact_email ?? ""}</div>
                      </td>
                      <td className="p-2 text-xs">
                        {r.tier_id ? <Badge size="sm" kind="info">{r.tier_id}</Badge> : <span className="text-ink-3">—</span>}
                        {r.seats ? <span className="ml-1.5 text-ink-2">· {r.seats}</span> : null}
                      </td>
                      <td className="p-2 text-xs font-mono text-ink-2">
                        {r.quote_id ?? <span className="text-ink-3">—</span>}
                      </td>
                      <td className="p-2 text-right text-sm font-medium text-emerald tabular-nums">
                        {rupee(r.amount_saved)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
