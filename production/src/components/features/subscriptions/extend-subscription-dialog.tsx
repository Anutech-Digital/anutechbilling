/**
 * ExtendSubscriptionDialog — operator-facing UI to issue an N-year
 * extension quote against an active subscription.
 *
 * UX:
 *   • Shows the current term + new term preview
 *   • Years (1 / 2 / 3) or, R-805, Months (1 / 3 / 6 / custom 1–11)
 *   • Live total from extensionCharge() — the same function the quote uses, so the
 *     preview and the quote cannot differ by a rupee (R-803 rule)
 *   • On submit: hits /api/subscriptions/[id]/extend, redirects to the
 *     new quote so operator can review + send to customer
 *
 * Caveats:
 *   • Does NOT process payment — extension flow ALWAYS goes through
 *     quote → send → customer pays. Two clean GST invoices.
 *   • Doesn't change the existing subscription until customer pays
 *     (renewal_date stays put until then).
 */

"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn, rupee, formatDate } from "@/lib/utils";
import type { Subscription } from "@/lib/supabase/database.types";
import { isSplitBilled } from "@/lib/billing/instalments";
import {
  EXTENSION_MONTH_PRESETS, MAX_EXTENSION_MONTHS,
  extensionCharge, extensionLabel, extensionLengthError, extensionMonths, extensionRenewalDate,
  type ExtensionLength,
} from "@/lib/renewals/extension-term";

interface Props {
  sub:    Subscription;
  open:   boolean;
  onOpenChange: (v: boolean) => void;
}

const PRESETS: { years: number; label: string; sublabel?: string }[] = [
  { years: 1, label: "1 year",  sublabel: "Add 12 months" },
  { years: 2, label: "2 years", sublabel: "Add 24 months" },
  { years: 3, label: "3 years", sublabel: "Add 36 months" },
];

type Unit = "years" | "months";

export default function ExtendSubscriptionDialog({ sub, open, onOpenChange }: Props) {
  const router = useRouter();
  const [unit, setUnit] = React.useState<Unit>("years");
  const [years, setYears] = React.useState(1);
  const [months, setMonths] = React.useState(3);
  const [customMonths, setCustomMonths] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);

  /* R-805: months are not offered on a subscription billed in parts — its instalments are
     laid out per term, and a part-year move would shift them (the API refuses it too). */
  const monthsBlocked = isSplitBilled(sub.billing_cycle);
  const isCustom = unit === "months" && customMonths !== "";
  const len: ExtensionLength = unit === "years"
    ? { unit: "years", count: years }
    : { unit: "months", count: isCustom ? Number(customMonths) : months };
  const lenError = extensionLengthError(len);

  // Pricing preview — the same calculation the quote uses
  const charge = extensionCharge({
    seats: sub.seats ?? 0,
    mrr:   sub.mrr ?? 0,
    len:   lenError ? { unit: "years", count: 0 } : len,
  });
  const annualEstimate = Math.max(0, Math.round((sub.mrr ?? 0) * 12));

  // Term preview — the date record_payment will write
  const currentRenewal = sub.renewal_date ? sub.renewal_date.slice(0, 10) : null;
  const newRenewal = lenError ? null : extensionRenewalDate(sub, len);
  const addedMonths = lenError ? 0 : extensionMonths(len);

  const onSubmit = async () => {
    setSubmitting(true);
    try {
      const res  = await fetch(`/api/subscriptions/${sub.id}/extend`, {
        method:  "POST",
        headers: { "content-type": "application/json" },
        body:    JSON.stringify(unit === "years" ? { years } : { months: len.count }),
      });
      const json = await res.json();
      if (!res.ok) {
        toast.error(json.error ?? "Could not create extension quote");
        return;
      }
      toast.success(`Extension quote ${json.quoteId} created`);
      onOpenChange(false);
      router.push(`/quotes/${json.quoteId}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Network error");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">
            Subscription · Extend
          </p>
          <h2 className="font-serif text-2xl text-ink">{sub.customer_name}</h2>
          {sub.domain && (
            <p className="text-xs font-mono text-ink-3 mt-0.5">{sub.domain}</p>
          )}
          <p className="text-xs text-ink-2 mt-1">{sub.plan} · {sub.seats} seats</p>
        </header>

        {/* Term preview */}
        <div className="bg-paper-2 rounded-md p-3 mb-4 text-sm flex justify-between items-center">
          <div>
            <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold">Current renewal</p>
            <p className="font-medium text-ink tabular-nums">
              {currentRenewal ? formatDate(currentRenewal) : "—"}
            </p>
          </div>
          <div className="text-ink-3">→</div>
          <div className="text-right">
            <p className="text-3xs uppercase tracking-wider text-emerald font-semibold">New renewal</p>
            <p className="font-medium text-emerald tabular-nums">
              {newRenewal ? formatDate(newRenewal) : "—"}
            </p>
          </div>
        </div>

        {/* Length chooser — Years or Months (R-805) */}
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
            How long to add?
          </p>
          <div role="radiogroup" aria-label="Unit" className="inline-flex rounded-md border border-hairline p-0.5">
            {(["years", "months"] as const).map((u) => (
              <button
                key={u}
                type="button"
                role="radio"
                aria-checked={unit === u}
                disabled={u === "months" && monthsBlocked}
                onClick={() => setUnit(u)}
                className={cn(
                  "px-3 py-1 text-xs rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed",
                  unit === u ? "bg-amber-soft text-amber-ink font-medium" : "text-ink-2 hover:text-ink",
                )}
              >
                {u === "years" ? "Years" : "Months"}
              </button>
            ))}
          </div>
        </div>
        {monthsBlocked && (
          <p className="text-2xs text-ink-3 mb-2">Billed in parts — extend by whole years.</p>
        )}
        {unit === "years" ? (
          <div className="grid grid-cols-3 gap-2 mb-4">
            {PRESETS.map((p) => (
              <button
                key={p.years}
                type="button"
                onClick={() => setYears(p.years)}
                className={cn(
                  "border rounded-md p-3 text-left transition-colors",
                  years === p.years
                    ? "border-amber bg-amber-soft text-amber-ink"
                    : "border-hairline bg-paper hover:border-hairline-strong text-ink-2",
                )}
              >
                <p className="font-medium text-sm">{p.label}</p>
                {p.sublabel && <p className="text-3xs text-ink-3 mt-0.5">{p.sublabel}</p>}
              </button>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2 mb-4">
            {EXTENSION_MONTH_PRESETS.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => { setMonths(m); setCustomMonths(""); }}
                className={cn(
                  "border rounded-md p-3 text-left transition-colors",
                  !isCustom && months === m
                    ? "border-amber bg-amber-soft text-amber-ink"
                    : "border-hairline bg-paper hover:border-hairline-strong text-ink-2",
                )}
              >
                <p className="font-medium text-sm">{m === 1 ? "1 month" : `${m} months`}</p>
              </button>
            ))}
            <label
              className={cn(
                "border rounded-md p-2 text-left transition-colors flex flex-col",
                isCustom ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-2",
              )}
            >
              <span className="text-3xs text-ink-3">Custom</span>
              <input
                type="number"
                inputMode="numeric"
                min={1}
                max={MAX_EXTENSION_MONTHS}
                step={1}
                placeholder={`1–${MAX_EXTENSION_MONTHS}`}
                aria-label="Custom months"
                value={customMonths}
                onChange={(e) => setCustomMonths(e.target.value)}
                className="w-full bg-transparent text-sm font-medium tabular-nums outline-none"
              />
            </label>
          </div>
        )}
        {lenError && <p className="text-2xs text-rose mb-2" role="alert">{lenError}</p>}

        {/* Pricing breakdown */}
        <div className="border border-hairline rounded-md p-3 text-sm space-y-1.5 mb-2">
          <div className="flex justify-between">
            <span className="text-ink-3">Annual rate</span>
            <span className="tabular-nums text-ink-2">{rupee(annualEstimate)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-3">
              {unit === "years"
                ? `× ${extensionLabel(len)}`
                : `× ${lenError ? "—" : len.count}/12 months`}
            </span>
            <span className="tabular-nums text-ink-2">{rupee(charge.subtotal)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-ink-3">GST 18%</span>
            <span className="tabular-nums text-ink-2">{rupee(charge.tax)}</span>
          </div>
          <div className="flex justify-between pt-2 border-t border-hairline">
            <span className="font-medium text-ink">Total (incl GST)</span>
            <span className="font-serif text-lg tabular-nums text-ink">{rupee(charge.total)}</span>
          </div>
        </div>

        <p className="text-2xs text-ink-3 leading-relaxed mb-1">
          A separate <b className="text-ink-2">extension quote</b> will be issued — the original
          1-year invoice stays untouched. When the customer pays, the renewal date will
          advance by <Badge size="sm" kind="muted">{addedMonths} months</Badge>.
        </p>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" icon="file" onClick={onSubmit} disabled={submitting || !!lenError}>
            {submitting ? "Creating quote…" : `Create extension quote`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
