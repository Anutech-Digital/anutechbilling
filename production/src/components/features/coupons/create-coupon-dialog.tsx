/**
 * CreateCouponDialog — admin form for adding a new coupon code.
 *
 * Used from /coupons page. Inserts via useCreateCoupon mutation, which
 * scopes by current user's tenant_id. The PUBLIC validation route reads
 * back via the BUY_PAGE_TENANT_ID env, so coupons created here only work
 * on the buy page when this tenant matches that env.
 */

"use client";

import * as React from "react";
import { toast } from "sonner";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useCreateCoupon } from "@/lib/queries/coupons";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}

type Tier = "" | "starter" | "standard" | "plus" | "enterprise";

export default function CreateCouponDialog({ open, onOpenChange }: Props) {
  const create = useCreateCoupon();

  const [code,            setCode]            = React.useState("");
  const [description,     setDescription]     = React.useState("");
  const [discountType,    setDiscountType]    = React.useState<"percent" | "flat">("percent");
  const [discountValue,   setDiscountValue]   = React.useState("10");
  const [tier,            setTier]            = React.useState<Tier>("");
  const [minSeats,        setMinSeats]        = React.useState("1");
  const [maxSeats,        setMaxSeats]        = React.useState("");
  const [maxRedemptions,  setMaxRedemptions]  = React.useState("");
  const [validUntil,      setValidUntil]      = React.useState("");

  const reset = () => {
    setCode(""); setDescription("");
    setDiscountType("percent"); setDiscountValue("10");
    setTier(""); setMinSeats("1"); setMaxSeats("");
    setMaxRedemptions(""); setValidUntil("");
  };

  const submitting = create.isPending;

  const onSubmit = async () => {
    const cleanCode = code.trim().toUpperCase().replace(/\s+/g, "");
    if (cleanCode.length < 3) {
      toast.error("Code must be at least 3 characters");
      return;
    }
    const dv = Number(discountValue);
    if (!Number.isFinite(dv) || dv <= 0) {
      toast.error("Discount value must be greater than 0");
      return;
    }
    if (discountType === "percent" && dv > 100) {
      toast.error("Percent discount cannot exceed 100");
      return;
    }

    try {
      await create.mutateAsync({
        code:             cleanCode,
        description:      description.trim() || null,
        discount_type:    discountType,
        discount_value:   dv,
        applies_to_tier:  tier || null,
        min_seats:        Number(minSeats) || 1,
        max_seats:        maxSeats        ? Number(maxSeats)        : null,
        max_redemptions:  maxRedemptions  ? Number(maxRedemptions)  : null,
        valid_until:      validUntil      || null,
      });
      toast.success(`Coupon ${cleanCode} created`);
      reset();
      onOpenChange(false);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Could not create coupon";
      // Friendlier message for the common "code already exists" duplicate-PK case.
      if (/duplicate|already exists|coupons_pkey/i.test(msg)) {
        toast.error(`Code "${cleanCode}" already exists. Pick another.`);
      } else {
        toast.error(msg);
      }
    }
  };

  // Live preview helpers
  const previewLine =
    discountType === "percent"
      ? `${discountValue || 0}% off`
      : `₹${Number(discountValue || 0).toLocaleString("en-IN")} off`;

  const TIERS: { id: Tier; label: string }[] = [
    { id: "",            label: "Any tier"  },
    { id: "starter",     label: "Starter"   },
    { id: "standard",    label: "Standard"  },
    { id: "plus",        label: "Plus"      },
    { id: "enterprise",  label: "Enterprise" },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <header className="border-b border-hairline pb-3 mb-4">
          <p className="text-[10px] uppercase tracking-wider font-semibold text-amber-ink mb-1">
            New coupon code
          </p>
          <h2 className="font-serif text-2xl text-ink">Create coupon</h2>
          <p className="text-xs text-ink-3 mt-1">
            Visitors on the public buy page can type this code to claim a discount.
            Live preview: <Badge size="sm" kind="warning">{code.trim().toUpperCase() || "NEWCODE"}</Badge>
            <span className="ml-1.5">→ {previewLine}</span>
          </p>
        </header>

        <div className="grid grid-cols-2 gap-3 mb-3">
          <div>
            <Label>Code *</Label>
            <Input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="e.g. SAVE10"
              className="font-mono uppercase"
              maxLength={50}
            />
            <p className="text-[10px] text-ink-3 mt-1">A-Z, 0-9. Auto-uppercased.</p>
          </div>
          <div>
            <Label>Description (internal)</Label>
            <Input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="e.g. Diwali Sale 2026"
              maxLength={120}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <Label>Discount type</Label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                type="button"
                onClick={() => setDiscountType("percent")}
                className={cn(
                  "border rounded-md py-2 text-sm transition-colors",
                  discountType === "percent"
                    ? "border-amber bg-amber-soft text-amber-ink"
                    : "border-hairline bg-paper text-ink-2 hover:border-hairline-strong",
                )}
              >
                % Percent
              </button>
              <button
                type="button"
                onClick={() => setDiscountType("flat")}
                className={cn(
                  "border rounded-md py-2 text-sm transition-colors",
                  discountType === "flat"
                    ? "border-amber bg-amber-soft text-amber-ink"
                    : "border-hairline bg-paper text-ink-2 hover:border-hairline-strong",
                )}
              >
                ₹ Flat
              </button>
            </div>
          </div>
          <div>
            <Label>{discountType === "percent" ? "Percent off" : "Rupees off"}</Label>
            <Input
              type="number"
              min={1}
              max={discountType === "percent" ? 100 : undefined}
              value={discountValue}
              onChange={(e) => setDiscountValue(e.target.value)}
              className="font-mono"
            />
            <p className="text-[10px] text-ink-3 mt-1">
              {discountType === "percent" ? "0-100" : "Flat ₹ off pre-GST gross"}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3 mb-3">
          <div>
            <Label>Min seats</Label>
            <Input
              type="number"
              min={1}
              value={minSeats}
              onChange={(e) => setMinSeats(e.target.value)}
              className="font-mono"
            />
          </div>
          <div>
            <Label>Max seats (optional)</Label>
            <Input
              type="number"
              min={1}
              value={maxSeats}
              onChange={(e) => setMaxSeats(e.target.value)}
              placeholder="unlimited"
              className="font-mono"
            />
          </div>
          <div>
            <Label>Max uses (optional)</Label>
            <Input
              type="number"
              min={1}
              value={maxRedemptions}
              onChange={(e) => setMaxRedemptions(e.target.value)}
              placeholder="unlimited"
              className="font-mono"
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mb-4">
          <div>
            <Label>Applies to tier</Label>
            <select
              value={tier}
              onChange={(e) => setTier(e.target.value as Tier)}
              className="w-full text-sm bg-paper border border-hairline rounded px-3 h-10 focus:outline-none focus:ring-1 focus:ring-amber"
            >
              {TIERS.map((t) => (
                <option key={t.id || "any"} value={t.id}>{t.label}</option>
              ))}
            </select>
          </div>
          <div>
            <Label>Valid until (optional)</Label>
            <Input
              type="date"
              value={validUntil}
              onChange={(e) => setValidUntil(e.target.value)}
              className="font-mono"
            />
            <p className="text-[10px] text-ink-3 mt-1">Leave blank for no expiry</p>
          </div>
        </div>

        <div className="bg-paper-2 rounded-md p-3 mb-4 text-xs text-ink-3 leading-relaxed">
          <p className="font-medium text-ink-2 mb-1">Where it works:</p>
          <ul className="list-disc list-inside space-y-0.5">
            <li>Public buy page (/buy/workspace) — coupon input field</li>
            <li>Validated on apply, redeemed atomically at checkout</li>
            <li>Discount applied <b>pre-GST</b>, then 18% GST recalculated on the discounted base</li>
            <li>Each visitor can redeem once per code</li>
          </ul>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button variant="primary" icon="check_circle" onClick={onSubmit} disabled={submitting}>
            {submitting ? "Creating…" : "Create coupon"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
