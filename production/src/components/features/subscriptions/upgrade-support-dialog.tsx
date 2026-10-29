/**
 * R-2073 — "Upgrade plan" for a support subscription (decision D5, 29 Oct 2026).
 *
 * Shows the pro-rata charge (new plan for the days left, less the current plan for the
 * same days) from buildSupportUpgrade — the same function the server saves the quote
 * with, so the preview and the quote cannot differ. Creates a DRAFT quote and opens it;
 * the renewal date stays, and the plan changes when the quote is paid.
 */
"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { rupee, formatDate } from "@/lib/utils";
import { istToday } from "@/lib/dates/ist";
import type { Item, Subscription } from "@/lib/supabase/database.types";
import { supportTier, type SupportTierId } from "@/lib/support/tiers";
import { upgradeTargets } from "@/lib/support/pro-rata-upgrade";
import { buildSupportUpgrade, supportUpgradeFrom } from "@/lib/support/upgrade-quote";

interface Props {
  sub:          Subscription;
  catalog:      readonly Item[];
  open:         boolean;
  onOpenChange: (v: boolean) => void;
}

const money = (n: number) => rupee(n, { decimals: Number.isInteger(n) ? 0 : 2 });

export default function UpgradeSupportDialog({ sub, catalog, open, onOpenChange }: Props) {
  const router = useRouter();
  const from = supportUpgradeFrom(sub);
  const targets = from ? upgradeTargets(from.tier) : [];
  const [toTier, setToTier] = React.useState<SupportTierId | null>(targets[0] ?? null);
  React.useEffect(() => { if (open) setToTier(targets[0] ?? null); }, [open, sub.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [submitting, setSubmitting] = React.useState(false);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  React.useEffect(() => { setSubmitError(null); }, [open, sub.id, toTier]);

  const built = from && toTier
    ? buildSupportUpgrade({
        sub,
        items: catalog.map((i) => ({ id: i.id, name: i.name, msrp: i.msrp, prices: i.prices })),
        toTier,
        today: istToday(),
      })
    : { ok: false as const, reason: "This plan has no higher support tier." };

  const onSubmit = async () => {
    if (!built.ok || !toTier) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      const res = await fetch(`/api/subscriptions/${sub.id}/upgrade-support`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to_tier: toTier }),
      });
      const json = (await res.json().catch(() => null)) as { quoteId?: string; amount?: number; error?: string } | null;
      if (!res.ok || !json?.quoteId) {
        const msg = json?.error ?? "Could not create the upgrade quote.";
        setSubmitError(msg);
        toast.error(msg, { description: "No quote was made." });
        return;
      }
      toast.success(`Upgrade quote ${json.quoteId} created (${rupee(json.amount ?? 0)} incl. GST) — opening it now`);
      onOpenChange(false);
      router.push(`/quotes/${json.quoteId}`);
    } catch (err) {
      setSubmitError("Could not reach the server. Check your connection, then try again.");
      toastError(err, { fallback: "Could not create the upgrade quote." });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">Subscription · Upgrade plan</p>
          <h2 className="font-serif text-2xl text-ink">{sub.customer_name}</h2>
          <p className="text-xs text-ink-2 mt-1">
            {sub.plan} · renews {sub.renewal_date ? formatDate(sub.renewal_date) : "—"}
          </p>
        </header>

        {targets.length > 1 && (
          <div className="flex gap-2 mb-4" role="group" aria-label="New plan">
            {targets.map((t) => (
              <Button key={t} size="sm" variant={t === toTier ? "primary" : "default"} aria-pressed={t === toTier} onClick={() => setToTier(t)}>
                {supportTier(t).label}
              </Button>
            ))}
          </div>
        )}

        {built.ok ? (
          <div className="bg-paper-2 rounded-md p-3 mb-4 text-sm" data-testid="upgrade-calc">
            <div className="flex justify-between mb-1">
              <span className="text-ink-3">Days left in this term</span>
              <span className="tabular-nums text-ink-2">{built.plan.calc.daysLeft} of {built.plan.calc.daysInTerm}</span>
            </div>
            <div className="flex justify-between gap-3 mb-1">
              <span className="text-ink-3">{supportTier(built.plan.toTier).label} ({money(built.plan.calc.toPrice)}) for those days</span>
              <span className="tabular-nums text-ink-2">{money(built.plan.calc.newTierCharge)}</span>
            </div>
            <div className="flex justify-between gap-3 mb-1">
              <span className="text-ink-3">Less {supportTier(built.plan.fromTier).label} ({money(built.plan.calc.fromPrice)}) for the same days</span>
              <span className="tabular-nums text-ink-2">−{money(built.plan.calc.oldTierCredit)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-hairline">
              <span className="font-medium text-ink">To pay, before GST</span>
              <span className="font-serif text-lg tabular-nums text-ink">{rupee(built.plan.calc.amountExGst)}</span>
            </div>
            <p className="text-2xs text-ink-3 mt-2">
              GST is added on the quote. The renewal date stays {sub.renewal_date ? formatDate(sub.renewal_date) : "the same"};
              the plan changes to {supportTier(built.plan.toTier).label} when the quote is paid. Downgrades take effect at renewal.
            </p>
          </div>
        ) : (
          <p role="alert" className="rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-xs text-rose mb-4">{built.reason}</p>
        )}

        {submitError && (
          <p role="alert" className="mt-3 rounded-md border border-rose/40 bg-rose/5 px-3 py-2 text-xs text-rose">{submitError}</p>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>Cancel</Button>
          {built.ok && (
            <Button variant="primary" icon="zap" onClick={onSubmit} disabled={submitting}>
              {submitting ? "Creating…" : "Create upgrade quote"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
