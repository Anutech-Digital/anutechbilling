/**
 * ItemForm — modal to add or edit a catalog item.
 */
"use client";

import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useQuery } from "@tanstack/react-query";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { useCreateItem, useUpdateItem } from "@/lib/queries/items";
import { rupee } from "@/lib/utils";
import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import type { Item, ItemPrices, ItemPriceTier, TenantWithParent } from "@/lib/supabase/database.types";

const VENDORS = [
  { value: "google",    label: "Google" },
  { value: "microsoft", label: "Microsoft" },
  { value: "zoho",      label: "Zoho" },
  { value: "other",     label: "Other" },
] as const;

const schema = z.object({
  id:        z.string().min(2, "Item ID required").max(50).regex(/^[A-Za-z0-9_-]+$/, "Only A-Z, 0-9, _ and - allowed"),
  name:      z.string().min(2, "Name required"),
  vendor:    z.enum(["google", "microsoft", "zoho", "other"]),
  kind:      z.enum(["main", "addon"]),
  hsn:       z.string().optional(),
});

interface PriceTierRow {
  /** Which underlying tier this row binds to (monthly or annual) */
  tier:   ItemPriceTier;
  /** "mo" = display as ₹/seat/month · "yr" = display as ₹/seat/year (×12 of stored value) */
  unit:   "mo" | "yr";
  label:  string;
  hint:   string;
  badge?: string;
}

const PRICE_TIERS: PriceTierRow[] = [
  { tier: "monthly", unit: "mo", label: "Monthly (flex)",       hint: "No commitment · billed monthly" },
  { tier: "annual",  unit: "mo", label: "Annual, monthly bill", hint: "1-yr commit · 12 monthly invoices" },
  { tier: "annual",  unit: "yr", label: "Annual, yearly bill",  hint: "1-yr commit · 1 invoice per year (= ₹/mo × 12)", badge: "Headline" },
];

type FormData = z.infer<typeof schema>;

interface ItemFormProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** When provided, the form is in edit mode */
  item?: Item;
}

export function ItemForm({ open, onOpenChange, item }: ItemFormProps) {
  const createItem = useCreateItem();
  const updateItem = useUpdateItem();
  const isEdit = !!item;

  const [vendor, setVendor] = React.useState<FormData["vendor"]>(item?.vendor ?? "google");
  const [kind,   setKind]   = React.useState<FormData["kind"]>(item?.kind ?? "main");

  // Per-commitment pricing matrix. Stored locally — saved as JSON on submit.
  const blankTier = { msrp: 0, wholesale: 0 };
  const [prices, setPrices] = React.useState<ItemPrices>(
    item?.prices ?? {
      monthly: { ...blankTier },
      annual:  { ...blankTier },
    },
  );

  // Partner pricing (Slice 1 — migration 0041). Distributor tenants can mark
  // a SKU visible to sub-reseller children + set the wholesale ₹/seat/mo
  // those children pay. Section only renders when the caller's tenant is a
  // distributor (read from get_my_tenant_with_parent RPC).
  const [isPartnerVisible, setIsPartnerVisible] = React.useState(item?.is_partner_visible ?? false);
  const [partnerPrice,     setPartnerPrice]     = React.useState<number>(item?.partner_price ?? 0);

  const { data: hierarchy } = useQuery({
    queryKey: ["tenant", "hierarchy", "form"],
    queryFn: async (): Promise<TenantWithParent | null> => {
      const supabase = createClient();
      const { data } = await supabase.rpc("get_my_tenant_with_parent");
      const row = Array.isArray(data) ? data[0] : data;
      return (row as TenantWithParent | undefined) ?? null;
    },
    staleTime: 5 * 60 * 1000,
  });
  const isDistributor = hierarchy?.tier === "distributor";

  const setTier = (tier: ItemPriceTier, field: "msrp" | "wholesale", value: number) => {
    setPrices((p) => ({
      ...p,
      [tier]: { ...(p[tier] ?? blankTier), [field]: Math.max(0, value) },
    }));
  };
  // Real USD price (per seat / month) for export deals.
  const setUsd = (field: "msrp" | "wholesale", value: number) => {
    setPrices((p) => ({
      ...p,
      usd: { ...(p.usd ?? blankTier), [field]: Math.max(0, value) },
    }));
  };

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<FormData>({
    resolver: zodResolver(schema),
    defaultValues: item
      ? { id: item.id, name: item.name, vendor: item.vendor, kind: item.kind, hsn: item.hsn ?? "998313" }
      : { vendor: "google", kind: "main", hsn: "998313" },
  });

  React.useEffect(() => {
    if (!open) {
      reset();
      setVendor("google");
      setKind("main");
      setPrices({
        monthly: { ...blankTier },
        annual:  { ...blankTier },
      });
      setIsPartnerVisible(false);
      setPartnerPrice(0);
    } else if (item) {
      reset({ id: item.id, name: item.name, vendor: item.vendor, kind: item.kind, hsn: item.hsn ?? "998313" });
      setVendor(item.vendor);
      setKind(item.kind);
      setPrices(
        item.prices && Object.keys(item.prices).length > 0
          ? item.prices
          : {
              // Backfill from legacy msrp/wholesale columns
              annual: { msrp: item.msrp, wholesale: item.wholesale },
            },
      );
      setIsPartnerVisible(item.is_partner_visible ?? false);
      setPartnerPrice(item.partner_price ?? 0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item, reset]);

  // Headline tier = annual if set, else monthly (used to populate legacy msrp/wholesale)
  const headlineTier = prices.annual ?? prices.monthly ?? blankTier;

  const onSubmit = async (data: FormData) => {
    // Strip tiers where both prices are 0 (treat as "not offered")
    const cleanPrices: ItemPrices = {};
    for (const tier of ["monthly", "annual"] as ItemPriceTier[]) {
      const v = prices[tier];
      if (v && (v.msrp > 0 || v.wholesale > 0)) cleanPrices[tier] = v;
    }
    // Preserve the optional real USD price (per seat / month) for export deals.
    if (prices.usd && (prices.usd.msrp > 0 || prices.usd.wholesale > 0)) cleanPrices.usd = prices.usd;

    if (Object.keys(cleanPrices).length === 0) {
      // No tier filled — error out
      alert("Please enter at least one commitment tier pricing");
      return;
    }

    // Distributor sanity: if marked partner-visible, must have a partner price
    if (isDistributor && isPartnerVisible && partnerPrice <= 0) {
      alert("Partner price required when SKU is marked visible to sub-resellers");
      return;
    }

    // Auto-set legacy msrp/wholesale from the headline tier so downstream code keeps working
    const headline = cleanPrices.annual ?? cleanPrices.monthly ?? blankTier;

    // Partner fields only apply for distributor tenants. For other tenants we
    // leave them untouched (so sub-reseller catalogs don't get accidentally
    // toggled to partner-visible).
    const partnerPatch = isDistributor
      ? {
          is_partner_visible: isPartnerVisible,
          partner_price:      isPartnerVisible ? partnerPrice : null,
        }
      : {};

    try {
      if (isEdit) {
        await updateItem.mutateAsync({
          id: item!.id,
          patch: { ...data, msrp: headline.msrp, wholesale: headline.wholesale, prices: cleanPrices, ...partnerPatch },
        });
      } else {
        await createItem.mutateAsync({
          id: data.id,
          name: data.name,
          vendor: data.vendor,
          kind: data.kind,
          hsn: data.hsn || "998313",
          msrp: headline.msrp,
          wholesale: headline.wholesale,
          prices: cleanPrices,
          ...partnerPatch,
        });
      }
      onOpenChange(false);
    } catch {
      // toast handled in hook
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="md:!max-w-4xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `Edit item · ${item!.name}` : "Add catalog item"}</DialogTitle>
          <DialogDescription>
            {isEdit
              ? "Update pricing or vendor info. Existing quotes are not affected."
              : "Add a product you sell. Margin is auto-computed from customer price − wholesale cost."}
          </DialogDescription>
        </DialogHeader>

        <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
            <FormField label="Item ID (SKU)" required htmlFor="id">
              <Input
                id="id"
                placeholder="e.g. GW-STD"
                disabled={isEdit}
                className="font-mono uppercase"
                error={errors.id?.message}
                {...register("id")}
              />
            </FormField>
            <FormField label="Vendor" required htmlFor="vendor">
              <Select
                value={vendor}
                onValueChange={(v) => {
                  setVendor(v as FormData["vendor"]);
                  (register("vendor") as any).onChange({ target: { value: v, name: "vendor" } });
                }}
              >
                <SelectTrigger id="vendor">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {VENDORS.map((v) => (
                    <SelectItem key={v.value} value={v.value}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input type="hidden" {...register("vendor")} value={vendor} />
            </FormField>
            <FormField label="Type" required htmlFor="kind">
              <Select
                value={kind}
                onValueChange={(v) => {
                  setKind(v as FormData["kind"]);
                  (register("kind") as any).onChange({ target: { value: v, name: "kind" } });
                }}
              >
                <SelectTrigger id="kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="main">Main plan</SelectItem>
                  <SelectItem value="addon">Add-on</SelectItem>
                </SelectContent>
              </Select>
              <input type="hidden" {...register("kind")} value={kind} />
            </FormField>
            <FormField label="HSN code" htmlFor="hsn">
              <Input
                id="hsn"
                placeholder="e.g. 998313"
                className="font-mono"
                {...register("hsn")}
              />
            </FormField>
          </div>

          <FormField label="Product name" required htmlFor="name">
            <Input
              id="name"
              placeholder="e.g. Google Workspace Standard"
              error={errors.name?.message}
              {...register("name")}
            />
          </FormField>

          {/* ─── Pricing matrix by commitment ─── */}
          <div className="rounded-lg border border-hairline overflow-hidden">
            <div className="px-3 py-2 bg-paper-2 border-b border-hairline flex items-center justify-between">
              <div>
                <div className="text-sm font-semibold text-ink">Pricing by commitment</div>
                <div className="text-[11px] text-ink-3">All rates in ₹/seat/month · leave 0 to skip a tier</div>
              </div>
              <Icon name="info" size={13} className="text-ink-3" />
            </div>

            {/* Header row */}
            <div className="grid grid-cols-[minmax(220px,1fr)_170px_170px_100px] gap-3 px-4 py-2 bg-paper border-b border-hairline text-[10px] uppercase tracking-wider text-ink-3 font-semibold">
              <div>Commitment</div>
              <div className="text-right">Customer ₹</div>
              <div className="text-right">Cost ₹</div>
              <div className="text-right">Margin</div>
            </div>

            {PRICE_TIERS.map((row, idx) => {
              // Underlying value (always stored as ₹/seat/month)
              const stored = prices[row.tier] ?? blankTier;
              // Multiplier: monthly display = 1, yearly display = 12
              const mult = row.unit === "yr" ? 12 : 1;
              const displayMsrp = stored.msrp * mult;
              const displayWholesale = stored.wholesale * mult;
              const m = displayMsrp - displayWholesale;
              const pct = displayMsrp > 0 ? Math.round((m / displayMsrp) * 100) : 0;
              const tone =
                pct >= 18 ? "text-emerald" :
                pct >= 14 ? "text-amber-ink" :
                pct > 0   ? "text-rose" : "text-ink-3";

              // Editing a yearly-display input means dividing by 12 before storing
              const handleEdit = (field: "msrp" | "wholesale", raw: number) => {
                const stored = row.unit === "yr" ? Math.round(raw / 12) : raw;
                setTier(row.tier, field, stored);
              };

              return (
                <div
                  key={`${row.tier}-${row.unit}-${idx}`}
                  className={cn(
                    "grid grid-cols-[minmax(220px,1fr)_170px_170px_100px] gap-3 items-center px-4 py-2.5 border-b border-hairline last:border-0",
                    row.badge && "bg-amber-soft/30",
                  )}
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-medium text-ink whitespace-nowrap">{row.label}</span>
                      {row.badge && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber text-paper font-semibold tracking-wider uppercase">
                          {row.badge}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-ink-3">{row.hint}</div>
                  </div>
                  <div>
                    <Input
                      type="number"
                      min={0}
                      prefix="₹"
                      suffix={row.unit === "yr" ? "/yr" : "/mo"}
                      value={displayMsrp || ""}
                      onChange={(e) => handleEdit("msrp", parseInt(e.target.value) || 0)}
                      className="text-right tabular-nums"
                    />
                  </div>
                  <div>
                    <Input
                      type="number"
                      min={0}
                      prefix="₹"
                      suffix={row.unit === "yr" ? "/yr" : "/mo"}
                      value={displayWholesale || ""}
                      onChange={(e) => handleEdit("wholesale", parseInt(e.target.value) || 0)}
                      className="text-right tabular-nums"
                    />
                  </div>
                  <div className="text-right">
                    {displayMsrp > 0 ? (
                      <div className={cn("text-sm font-medium tabular-nums leading-tight", tone)}>
                        {rupee(m)}
                        <div className="text-[10px] font-normal">{pct}%</div>
                      </div>
                    ) : (
                      <span className="text-xs text-ink-3">—</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ─── USD price (export / international deals) ─── */}
          <div className="rounded-lg border border-hairline overflow-hidden">
            <div className="px-3 py-2 bg-paper-2 border-b border-hairline">
              <div className="text-sm font-semibold text-ink inline-flex items-center gap-2 flex-wrap">
                🌍 USD price <Badge kind="info" size="sm">Export · optional</Badge>
              </div>
              <div className="text-[11px] text-ink-3">
                Product ka <b>asli USD price</b> (jaise Google ka published $ rate) — ₹ se convert NAHI.
                International customer ko USD me quote/invoice tab ye use hoga. Khaali chhodo to ₹ price
                convert ho jayega.
              </div>
            </div>
            <div className="px-4 py-3 grid grid-cols-2 gap-3">
              <FormField label="USD price (customer)" htmlFor="usd_msrp">
                <Input
                  id="usd_msrp"
                  type="number"
                  min={0}
                  step="0.01"
                  prefix="$"
                  suffix="/seat/mo"
                  placeholder="0.00"
                  value={prices.usd?.msrp || ""}
                  onChange={(e) => setUsd("msrp", parseFloat(e.target.value) || 0)}
                  className="text-right tabular-nums"
                />
              </FormField>
              <FormField label="USD cost (wholesale)" htmlFor="usd_wholesale">
                <Input
                  id="usd_wholesale"
                  type="number"
                  min={0}
                  step="0.01"
                  prefix="$"
                  suffix="/seat/mo"
                  placeholder="0.00"
                  value={prices.usd?.wholesale || ""}
                  onChange={(e) => setUsd("wholesale", parseFloat(e.target.value) || 0)}
                  className="text-right tabular-nums"
                />
              </FormField>
            </div>
          </div>

          {/* ─── Partner pricing (distributor only) ─── */}
          {isDistributor && (
            <div className="rounded-lg border border-hairline overflow-hidden">
              <div className="px-3 py-2 bg-paper-2 border-b border-hairline flex items-center justify-between">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink inline-flex items-center gap-2 flex-wrap">
                    Partner pricing
                    <Badge kind="warning" size="sm">Distributor only</Badge>
                  </div>
                  <div className="text-[11px] text-ink-3">
                    Sub-reseller children dekhenge ye SKU + price apne "From your distributor" tab me.
                  </div>
                </div>
                <Icon name="link" size={13} className="text-ink-3 flex-shrink-0" />
              </div>
              <div className="px-4 py-3 space-y-3">
                <label className="flex items-center gap-2 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={isPartnerVisible}
                    onChange={(e) => setIsPartnerVisible(e.target.checked)}
                    className="h-4 w-4 rounded border-hairline text-amber focus:ring-amber"
                  />
                  <span className="text-sm text-ink">Make visible to my sub-resellers</span>
                </label>
                <div className={cn("transition-opacity", !isPartnerVisible && "opacity-40 pointer-events-none")}>
                  <FormField label="Partner wholesale price *" htmlFor="partner_price">
                    <Input
                      id="partner_price"
                      type="number"
                      min={0}
                      prefix="₹"
                      suffix="/seat/mo"
                      placeholder="0"
                      value={partnerPrice || ""}
                      onChange={(e) => setPartnerPrice(Math.max(0, parseInt(e.target.value) || 0))}
                      className="text-right tabular-nums max-w-xs"
                    />
                    <div className="mt-1 text-[10px] text-ink-3">
                      Ye rate sub-reseller ka wholesale cost banega. Annual yearly bill ke liye × 12 hoga ({rupee(partnerPrice * 12)}/seat/yr).
                    </div>
                  </FormField>
                </div>
              </div>
            </div>
          )}

          {/* Headline summary */}
          {headlineTier.msrp > 0 && (
            <div className="text-[11px] text-ink-3 flex items-center gap-1.5">
              <Icon name="info" size={11} />
              Headline rate{" "}
              <b className="text-ink">{rupee(headlineTier.msrp)}/seat/mo</b>{" "}
              (= <b className="text-ink">{rupee(headlineTier.msrp * 12)}/seat/yr</b>){" "}
              will appear in quotes, dashboards and the customer-facing PDF.
            </div>
          )}

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              loading={isSubmitting || createItem.isPending || updateItem.isPending}
            >
              {isEdit ? "Save changes" : "Add to catalog"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
