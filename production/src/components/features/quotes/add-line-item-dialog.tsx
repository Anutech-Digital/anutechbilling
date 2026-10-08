/**
 * AddLineItemDialog — pick from catalog OR add a custom line.
 *
 * Two tabs:
 *   1. From catalog (shows items table, click "Add")
 *   2. Custom (free-form name, qty, rate, cost)
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TabBar } from "@/components/ui/tabs";
import { Skeleton } from "@/components/ui/skeleton";
import { EmptyState } from "@/components/shared/empty-state";
import { Icon } from "@/components/ui/icon";
import { useItems } from "@/lib/queries/items";
import { catalogDefaultQty } from "@/lib/quotes/line-items";
import { headlinePrice, isOwnService } from "@/lib/catalog/headline-price";
import { catalogYearlyPrice } from "@/lib/quotes/catalog-line";
import { floorWorkspaceRow } from "@/lib/catalog/workspace-floor";
import { rupee } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { formatForeign } from "@/lib/currency";
import type { QuoteLineItem, Item } from "@/lib/supabase/database.types";

interface AddLineItemDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAdd: (line: QuoteLineItem) => void;
  /** When billing a foreign currency (e.g. USD), the line uses the item's REAL
   *  foreign price if set — books stay ₹ via the exchange rate. */
  currency?: string | null;
  exchangeRate?: number | null;
  /** For a USD quote: "international" = use the item's catalog USD price (fall
   *  back to ₹-converted); "india" = always the ₹ price converted at the rate. */
  pricingBasis?: "international" | "india";
}

const customSchema = z.object({
  name: z.string().min(2, "Name required"),
  qty: z.coerce.number().int().min(1),
  // Rate/cost are entered in the quote's BILLING currency (₹ domestic, or the
  // foreign currency for a USD quote). Non-int allowed so USD cents work; we
  // round to canonical ₹ integers on save (books always stay ₹).
  rate: z.coerce.number().min(0),
  cost: z.coerce.number().min(0),
});
type CustomData = z.infer<typeof customSchema>;

export function AddLineItemDialog({ open, onOpenChange, onAdd, currency, exchangeRate, pricingBasis = "international" }: AddLineItemDialogProps) {
  const isUsd = (currency ?? "INR").toUpperCase() === "USD";
  // A usable rate (> 1). Below that we can't convert ₹ → foreign meaningfully.
  const fx = exchangeRate && exchangeRate > 1 ? exchangeRate : null;
  // Use the item's real foreign price only when billing USD AND the quote is on
  // the "international" basis. On the "india" basis we always convert the ₹ price.
  const useIntlUsd = isUsd && pricingBasis === "international";
  // Custom-line entry currency: a USD quote WITH a usable exchange rate lets the
  // reseller type the price in USD (converted → canonical ₹ on save). Without a
  // rate we can't convert, so fall back to ₹ entry.
  const usdEntry = isUsd && !!fx;
  const entryCur = usdEntry ? (currency ?? "USD") : "₹";
  const { data: allItems, isLoading } = useItems();
  // Subscription quote line picker — exclude one-time (Items Catalog) products.
  // R-387: rows are floored to the GW list price here too, so the price SHOWN in this picker is
  // the price the line gets (catalogYearlyPrice floors as well) and matches the quote chips.
  const items = React.useMemo(
    () => (allItems ?? []).filter((i) => i.item_type !== "one_time").map((i) => floorWorkspaceRow(i)),
    [allItems],
  );
  const [tab, setTab] = React.useState("catalog");
  const [search, setSearch] = React.useState("");

  const filtered = (items ?? []).filter((it) => {
    if (!search.trim()) return true;
    const s = search.toLowerCase();
    return it.name.toLowerCase().includes(s) || it.id.toLowerCase().includes(s);
  });

  // Custom form
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<CustomData>({
    resolver: zodResolver(customSchema),
    defaultValues: { qty: 10, rate: 0, cost: 0 },
  });

  React.useEffect(() => {
    if (!open) {
      reset();
      setSearch("");
      setTab("catalog");
    }
  }, [open, reset]);

  const addFromCatalog = (it: Item) => {
    // Catalog stores prices as ₹/seat/MONTH. QuoteLineItem.rate/cost must be
    // ₹/seat/YEAR (the canonical storage unit). Default commitment is
    // "annual_yearly" so we use the annual tier × 12. The commitment picker
    // can later switch to monthly which recalculates via updateCommitment().
    const usdTier    = it.prices?.usd;
    let msrpPerYear: number;
    let wholesalePerYear: number;
    if (useIntlUsd && usdTier && usdTier.msrp > 0) {
      // International basis + a REAL USD price set → the canonical ₹ line = the USD
      // price × 12 × exchange rate. Books stay ₹; the USD shown later (₹ ÷ rate)
      // round-trips back to the real USD price the customer was quoted.
      const rate = exchangeRate && exchangeRate > 0 ? exchangeRate : 1;
      msrpPerYear      = Math.round(usdTier.msrp * 12 * rate);
      wholesalePerYear = Math.round(usdTier.wholesale * 12 * rate);
    } else {
      // Domestic (or no USD price) → the ₹ catalog price, shared with the quote's
      // product chips and support toggle (lib/quotes/catalog-line.ts). A yearly-total
      // plan (support "(Yearly)") is priced from prices.annual_total there.
      const p = catalogYearlyPrice(it);
      msrpPerYear      = p.rate;
      wholesalePerYear = p.cost;
    }

    onAdd({
      id: crypto.randomUUID(),
      item_id: it.id,
      name: it.name,
      // Per-seat (Workspace/M365/Zoho) defaults to ~10; flat hosting to 1. See
      // catalogDefaultQty — a flat ₹X/mo plan at the old ×10 was a 10× overquote.
      qty: catalogDefaultQty(it.vendor),
      rate: msrpPerYear,                    // store as ₹/seat/year (canonical)
      cost: wholesalePerYear,
      commitment: "annual_yearly",
    });
    onOpenChange(false);
  };

  const addCustom = (data: CustomData) => {
    // Books are always ₹: a USD entry converts at the exchange rate, a ₹ entry
    // just rounds to an integer. QuoteLineItem.rate/cost are canonical ₹/seat/year.
    const rateInr = usdEntry ? Math.round(data.rate * fx!) : Math.round(data.rate);
    const costInr = usdEntry ? Math.round(data.cost * fx!) : Math.round(data.cost);
    onAdd({
      id: crypto.randomUUID(),
      name: data.name,
      qty: data.qty,
      rate: rateInr,
      cost: costInr,
    });
    onOpenChange(false);
  };

  const customRate = watch("rate") || 0;
  const customCost = watch("cost") || 0;
  const customMargin = customRate - customCost;
  const customMarginPct = customRate > 0 ? Math.round((customMargin / customRate) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl p-0">
        <DialogHeader className="px-6 pt-6">
          <DialogTitle>Add line item</DialogTitle>
          <DialogDescription>
            Pick from your catalog (auto-fills rate + cost), or enter a custom item.
          </DialogDescription>
        </DialogHeader>

        <div className="px-6 pt-4">
          <TabBar
            value={tab}
            onChange={setTab}
            items={[
              { id: "catalog", label: `From catalog (${items?.length ?? 0})` },
              { id: "custom",  label: "Custom item" },
            ]}
          />
        </div>

        {/* CATALOG tab */}
        {tab === "catalog" && (
          <div className="min-w-0">
            <div className="px-6 pt-4 pb-2">
              <Input
                aria-label="Search items"
                prefix={<Icon name="search" size={14} />}
                placeholder="Search items by name or SKU…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
              />
            </div>

            <div className="max-h-[400px] overflow-y-auto overflow-x-hidden min-w-0 border-t border-hairline">
              {isLoading ? (
                <div className="p-4 space-y-2">
                  {[1, 2, 3, 4].map((i) => (
                    <Skeleton key={i} className="h-10 w-full" />
                  ))}
                </div>
              ) : (items?.length ?? 0) === 0 ? (
                <EmptyState
                  icon="package"
                  title="No items in catalog"
                  body="Add items via /items page first, then come back to build a quote."
                  compact
                />
              ) : filtered.length === 0 ? (
                <div className="py-10 text-center text-sm text-ink-3">
                  No items match "{search}"
                </div>
              ) : (
                <ul className="divide-y divide-hairline">
                  {filtered.map((it) => (
                    <li key={it.id}>
                      {/* Responsive flex row (was a 4-col table that overflowed
                          on phones — squished names + clipped Add button). The
                          whole row adds the item; "Add" is a visual affordance. */}
                      <button
                        type="button"
                        onClick={() => addFromCatalog(it)}
                        className="w-full flex items-center gap-2.5 px-4 sm:px-6 py-3 text-left hover:bg-paper-2 transition-colors"
                      >
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="font-medium text-sm text-ink truncate">{it.name}</span>
                            <Badge
                              size="sm"
                              kind={it.vendor === "google" || it.vendor === "microsoft" ? "info" : "success"}
                              className="shrink-0"
                            >
                              {it.vendor}
                            </Badge>
                            {it.kind === "addon" && (
                              <Badge size="sm" kind="outline" className="shrink-0">Add-on</Badge>
                            )}
                          </div>
                          <div className="text-2xs text-ink-3 font-mono truncate">{it.id}</div>
                        </div>
                        <div className="text-right shrink-0 tabular-nums">
                          {useIntlUsd && it.prices?.usd && it.prices.usd.msrp > 0 ? (
                            // International basis + a real foreign price — show it directly.
                            <div className="font-medium text-sm">{formatForeign(it.prices.usd.msrp, currency ?? "USD")}/mo</div>
                          ) : isUsd && fx ? (
                            // No foreign price set — convert the ₹ price at the rate
                            // so the picker shows the SAME currency the quote bills in.
                            <div className="font-medium text-sm">
                              {formatForeign(it.msrp / fx, currency ?? "USD")}/mo
                              <span className="block text-3xs text-ink-3 font-normal">≈ {rupee(it.msrp)} @ ₹{fx}</span>
                            </div>
                          ) : (
                            <div className="font-medium text-sm">
                              {rupee(headlinePrice(it).amount)}/{headlinePrice(it).unit}
                              {isUsd && <span className="block text-3xs text-amber-ink font-normal">set the exchange rate to show {currency}</span>}
                            </div>
                          )}
                          {isOwnService(it) ? (
                            <div className="text-3xs text-ink-3">Own service</div>
                          ) : (
                          <div className={cn(
                            "text-3xs",
                            it.margin_pct >= 18 ? "text-emerald" : it.margin_pct >= 14 ? "text-amber-ink" : "text-rose"
                          )}>
                            {it.margin_pct}% margin
                          </div>
                          )}
                        </div>
                        <span className="shrink-0 inline-flex items-center gap-1 rounded-md bg-amber text-white text-xs font-semibold px-2.5 py-1.5">
                          <Icon name="plus" size={13} /> Add
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="px-6 py-3 border-t border-hairline bg-paper-2 text-xs text-ink-3 flex justify-between items-center">
              <span>Tip: rate & cost auto-fill from catalog. Quantity defaults to 10.</span>
              <button
                onClick={() => setTab("custom")}
                className="text-amber-ink underline hover:text-amber font-medium"
              >
                Can't find it? Add custom →
              </button>
            </div>
          </div>
        )}

        {/* CUSTOM tab */}
        {tab === "custom" && (
          <form onSubmit={handleSubmit(addCustom)} className="px-6 pb-6 pt-4 space-y-4">
            <FormField label="Item name" required htmlFor="custom-name">
              <Input
                id="custom-name"
                placeholder="e.g., Custom training package"
                autoFocus
                error={errors.name?.message}
                {...register("name")}
              />
            </FormField>

            <div className="grid grid-cols-3 gap-3">
              <FormField label="Quantity" required htmlFor="custom-qty">
                <Input
                  id="custom-qty"
                  type="number"
                  min={1}
                  error={errors.qty?.message}
                  {...register("qty", { valueAsNumber: true })}
                />
              </FormField>
              <FormField label={`Rate (${entryCur})`} required htmlFor="custom-rate">
                <Input
                  id="custom-rate"
                  type="number"
                  min={0}
                  step={usdEntry ? "0.01" : "1"}
                  prefix={usdEntry ? "$" : "₹"}
                  error={errors.rate?.message}
                  {...register("rate", { valueAsNumber: true })}
                />
              </FormField>
              <FormField label={`Cost (${entryCur})`} required htmlFor="custom-cost">
                <Input
                  id="custom-cost"
                  type="number"
                  min={0}
                  step={usdEntry ? "0.01" : "1"}
                  prefix={usdEntry ? "$" : "₹"}
                  helper="Your cost"
                  error={errors.cost?.message}
                  {...register("cost", { valueAsNumber: true })}
                />
              </FormField>
            </div>

            {/* USD entry: make the ₹-books conversion explicit so it's never a surprise */}
            {usdEntry && customRate > 0 && (
              <p className="text-2xs text-ink-3">
                Billed in {entryCur} · recorded in books as{" "}
                <span className="font-medium text-ink-2">{rupee(Math.round(customRate * (fx ?? 1)))}</span>/unit at ₹{fx}/{entryCur}.
              </p>
            )}

            {/* Margin preview */}
            {customRate > 0 && (
              <div className={cn(
                "rounded-md p-3 text-sm flex items-center justify-between",
                customMarginPct >= 18 ? "bg-emerald-soft" :
                customMarginPct >= 14 ? "bg-amber-soft" :
                "bg-rose-soft"
              )}>
                <span className="text-ink-2">Margin per unit:</span>
                <span className={cn(
                  "font-serif text-lg tabular-nums",
                  customMarginPct >= 18 ? "text-emerald" :
                  customMarginPct >= 14 ? "text-amber-ink" :
                  "text-rose"
                )}>
                  {usdEntry ? formatForeign(customMargin, currency ?? "USD") : rupee(customMargin)} ({customMarginPct}%)
                </span>
              </div>
            )}

            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
              <Button type="submit" variant="primary" loading={isSubmitting}>Add line</Button>
            </div>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
