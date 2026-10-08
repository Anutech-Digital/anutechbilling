/**
 * CreatePromoDialog — admin form to launch a new online sale.
 *
 * Used from /online-promos. Inserts via useCreateSitePromo (RPC).
 * Live preview shows EXACTLY how the banner will look on /buy/workspace
 * so Pardeep can copy-tweak before going live.
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { useCreateSitePromo } from "@/lib/queries/site-promos";
import type { SitePromoBannerStyle } from "@/lib/supabase/database.types";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type Tier = "" | "starter" | "standard" | "plus" | "enterprise";

const BANNER_STYLES: { id: SitePromoBannerStyle; label: string; bg: string; ring: string }[] = [
  { id: "amber",   label: "Amber",   bg: "bg-gradient-to-r from-amber-500 to-amber-600",   ring: "ring-amber" },
  { id: "rose",    label: "Rose",    bg: "bg-gradient-to-r from-rose-500 to-rose-600",     ring: "ring-rose" },
  { id: "emerald", label: "Emerald", bg: "bg-gradient-to-r from-emerald-500 to-emerald-600", ring: "ring-emerald" },
  { id: "indigo",  label: "Indigo",  bg: "bg-gradient-to-r from-indigo-500 to-indigo-600", ring: "ring-indigo" },
  { id: "ink",     label: "Black",   bg: "bg-gradient-to-r from-ink to-ink/80",           ring: "ring-ink" },
];

const PRESET_HEADLINES = [
  { h: "Diwali Sale — extra 15% off all plans",        d: "Limited time · stacks on top of Google promo" },
  { h: "Year-end blowout — 20% extra off",             d: "Hurry, ends 31 March" },
  { h: "Independence Day deal — flat ₹500 off",        d: "Use anytime till 20 August" },
  { h: "GST refund festival — 10% back to you",        d: "Auto-applied at checkout" },
];

export default function CreatePromoDialog({ open, onOpenChange }: Props) {
  const create = useCreateSitePromo();

  const [headline,       setHeadline]       = React.useState("");
  const [subheadline,    setSubheadline]    = React.useState("");
  const [badgeText,      setBadgeText]      = React.useState("Limited time");
  const [discountType,   setDiscountType]   = React.useState<"percent" | "flat">("percent");
  const [discountValue,  setDiscountValue]  = React.useState("15");
  const [bannerStyle,    setBannerStyle]    = React.useState<SitePromoBannerStyle>("amber");
  const [tier,           setTier]           = React.useState<Tier>("");
  const [minSeats,       setMinSeats]       = React.useState("1");
  const [maxSeats,       setMaxSeats]       = React.useState("");
  const [validUntil,     setValidUntil]     = React.useState("");

  const submitting = create.isPending;

  const reset = () => {
    setHeadline(""); setSubheadline(""); setBadgeText("Limited time");
    setDiscountType("percent"); setDiscountValue("15");
    setBannerStyle("amber");
    setTier(""); setMinSeats("1"); setMaxSeats("");
    setValidUntil("");
  };

  const onSubmit = async () => {
    if (headline.trim().length < 4) {
      toast.error("Headline is too short", { description: "Use at least 4 characters." });
      return;
    }
    const dv = Number(discountValue);
    if (!Number.isFinite(dv) || dv <= 0) {
      toast.error("Enter a discount", { description: "The discount must be more than 0." });
      return;
    }
    if (discountType === "percent" && dv > 100) {
      toast.error("Discount is over 100%", { description: "Enter a percent between 1 and 100." });
      return;
    }

    try {
      const id = await create.mutateAsync({
        headline:        headline.trim(),
        subheadline:     subheadline.trim() || null,
        badge_text:      badgeText.trim() || null,
        discount_type:   discountType,
        discount_value:  dv,
        applies_to_tier: tier || null,
        min_seats:       Number(minSeats) || 1,
        max_seats:       maxSeats ? Number(maxSeats) : null,
        banner_style:    bannerStyle,
        valid_until:     validUntil ? new Date(validUntil).toISOString() : null,
      });
      toast.success(`Promo ${id} created and live`);
      reset();
      onOpenChange(false);
    } catch (err) {
      toastError(err, {
        fallback: "Promo not created.",
        description: "Nothing went live. Check the fields and press Create again.",
      });
    }
  };

  const previewBg = BANNER_STYLES.find((s) => s.id === bannerStyle)?.bg ?? "";
  const discountLabel =
    discountType === "percent"
      ? `${discountValue || 0}% off`
      : `₹${Number(discountValue || 0).toLocaleString("en-IN")} off`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-3xs uppercase tracking-wider font-semibold text-amber-ink mb-1">
            Online sale · new promo
          </p>
          <h2 className="font-serif text-2xl text-ink">Launch promo</h2>
          <p className="text-xs text-ink-3 mt-1">
            Auto-applied to every visitor on the public buy page. No code required — banner shows the offer prominently.
          </p>
        </header>

        {/* Live preview banner — exactly what visitors see */}
        <div className="mb-4">
          <p className="text-3xs uppercase tracking-wider text-ink-3 font-semibold mb-2">
            Live preview · how it will look
          </p>
          <div className={cn("rounded-lg px-4 py-3 text-paper shadow-lg", previewBg)}>
            <div className="flex items-center gap-3 flex-wrap">
              {badgeText && (
                <span className="text-3xs uppercase tracking-wider font-semibold bg-paper/20 backdrop-blur px-2 py-1 rounded-full">
                  {badgeText}
                </span>
              )}
              <div className="flex-1 min-w-0">
                <div className="font-serif text-base sm:text-lg leading-tight">
                  {headline || "Your headline will appear here"}
                </div>
                {subheadline && (
                  <div className="text-xs sm:text-xs opacity-90 mt-0.5">{subheadline}</div>
                )}
              </div>
              <span className="font-mono text-xs bg-paper text-ink px-2 py-1 rounded font-semibold whitespace-nowrap">
                {discountLabel}
              </span>
            </div>
          </div>
        </div>

        {/* Quick-pick preset headlines */}
        <div className="mb-3">
          <p id="create-promo-quick-start" className="text-xs font-medium leading-none text-ink-2">Quick start</p>
          <div role="group" aria-labelledby="create-promo-quick-start" className="grid grid-cols-2 gap-1.5 mt-1">
            {PRESET_HEADLINES.map((p) => (
              <button
                key={p.h}
                type="button"
                onClick={() => { setHeadline(p.h); setSubheadline(p.d); }}
                className="text-left text-xs border border-hairline bg-paper hover:border-amber hover:bg-amber-soft/30 rounded p-2 transition-colors"
              >
                <div className="font-medium text-ink truncate">{p.h}</div>
                <div className="text-xs text-ink-3 truncate">{p.d}</div>
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 mb-3">
          <div>
            <Label htmlFor="create-promo-headline">Headline *</Label>
            <Input id="create-promo-headline" value={headline} onChange={(e) => setHeadline(e.target.value)}
              maxLength={120} placeholder="Diwali Sale — extra 15% off" />
          </div>
          <div>
            <Label htmlFor="create-promo-subheadline-optional">Subheadline (optional)</Label>
            <Input id="create-promo-subheadline-optional" value={subheadline} onChange={(e) => setSubheadline(e.target.value)}
              maxLength={140} placeholder="Limited time · stacks on top of Google promo" />
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-4">
          <div>
            <p id="create-promo-type" className="text-xs font-medium leading-none text-ink-2">Type</p>
            <div role="group" aria-labelledby="create-promo-type" className="grid grid-cols-2 gap-1 mt-1">
              <button
                type="button"
                aria-label="Percent"
                aria-pressed={discountType === "percent"}
                onClick={() => setDiscountType("percent")}
                className={cn(
                  "border rounded py-2 text-xs font-medium",
                  discountType === "percent" ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-3",
                )}
              >%</button>
              <button
                type="button"
                aria-label="Flat rupees"
                aria-pressed={discountType === "flat"}
                onClick={() => setDiscountType("flat")}
                className={cn(
                  "border rounded py-2 text-xs font-medium",
                  discountType === "flat" ? "border-amber bg-amber-soft text-amber-ink" : "border-hairline bg-paper text-ink-3",
                )}
              >₹</button>
            </div>
          </div>
          <div>
            <Label htmlFor="create-promo-off">{discountType === "percent" ? "Percent" : "Rupees"} off</Label>
            <Input id="create-promo-off" type="number" min={1}
              max={discountType === "percent" ? 100 : undefined}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              className="font-mono" />
          </div>
          <div>
            <Label htmlFor="create-promo-badge-pill-optional">Badge pill (optional)</Label>
            <Input id="create-promo-badge-pill-optional" value={badgeText} onChange={(e) => setBadgeText(e.target.value)}
              maxLength={20} placeholder="Limited time" />
          </div>
        </div>

        <div className="mb-4">
          <p id="create-promo-banner-colour" className="text-xs font-medium leading-none text-ink-2">Banner colour</p>
          <div role="group" aria-labelledby="create-promo-banner-colour" className="grid grid-cols-5 gap-1.5 mt-1.5">
            {BANNER_STYLES.map((s) => (
              <button
                key={s.id}
                type="button"
                aria-label={s.label}
                aria-pressed={bannerStyle === s.id}
                onClick={() => setBannerStyle(s.id)}
                className={cn(
                  "h-9 rounded-md transition-all",
                  s.bg,
                  bannerStyle === s.id ? `ring-2 ring-offset-2 ${s.ring}` : "opacity-70 hover:opacity-100",
                )}
                title={s.label}
              />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
          <div>
            <Label htmlFor="create-promo-tier">Tier</Label>
            <select id="create-promo-tier" value={tier} onChange={(e) => setTier(e.target.value as Tier)}
              className="w-full text-sm bg-paper border border-hairline rounded px-2 h-10">
              <option value="">All tiers</option>
              <option value="starter">Starter</option>
              <option value="standard">Standard</option>
              <option value="plus">Plus</option>
              <option value="enterprise">Enterprise</option>
            </select>
          </div>
          <div>
            <Label htmlFor="create-promo-min-seats">Min seats</Label>
            <Input id="create-promo-min-seats" type="number" min={1} value={minSeats}
              onChange={(e) => setMinSeats(e.target.value)} className="font-mono" />
          </div>
          <div>
            <Label htmlFor="create-promo-max-seats">Max seats</Label>
            <Input id="create-promo-max-seats" type="number" min={1} value={maxSeats}
              onChange={(e) => setMaxSeats(e.target.value)}
              placeholder="—" className="font-mono" />
          </div>
          <div>
            <Label htmlFor="create-promo-ends-on">Ends on</Label>
            <Input id="create-promo-ends-on" type="date" value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)} className="font-mono" />
          </div>
        </div>

        <div className="bg-paper-2 rounded-md p-3 mb-4 text-xs text-ink-3 leading-relaxed">
          <p className="font-medium text-ink-2 mb-1 inline-flex items-center gap-1.5">
            <Icon name="info" size={11} /> Stacking order
          </p>
          <ol className="list-decimal list-inside space-y-0.5">
            <li>Google promo (catalog item)</li>
            <li><b className="text-amber-ink">This online sale</b> (auto-applied on top)</li>
            <li>Coupon code (if visitor types one)</li>
          </ol>
          <p className="mt-1.5">GST 18% is recomputed on the final discounted subtotal.</p>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" icon="zap" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Launching…" : "Launch promo"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
