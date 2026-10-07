"use client";

/**
 * The three support plans, with a Monthly / Yearly switch.
 *
 * ─── THE TOGGLE SWAPS THE SKU, IT DOES NOT DO ARITHMETIC ────────────────────
 * Monthly and Yearly are two different catalogue rows with two different prices,
 * because the yearly price is a DISCOUNT and not twelve monthlies (₹9,990, not
 * ₹11,988 — and ₹9,990 ÷ 12 is not a whole rupee, see lib/support/tiers.ts).
 *
 * So this component never computes a price. It picks the row the tenant's catalogue
 * actually holds and hands its rate to the quote. A component that multiplied or
 * divided here would be a second pricing rule sitting next to the real one.
 *
 * ─── AND THE SAVING IS DERIVED, NOT WRITTEN ON THE BADGE ────────────────────
 * "Save 17% · 2 months free" comes out of annualSaving(), from the two prices. A
 * hardcoded 17% becomes wrong the first time someone edits a price — and it is the
 * kind of wrong that prints on a customer's quote.
 */
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/label";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { cn, rupee } from "@/lib/utils";
import { useCreateItem } from "@/lib/queries/items";
import {
  isValidSupportPrice, knownSupportPrice, supportCatalogName, supportCatalogRow,
  supportLineRate, supportRowPrice,
} from "@/lib/support/catalog-row";
import {
  SUPPORT_TIERS, annualSaving, findSupportSku, supportPrice,
  type SupportTier,
} from "@/lib/support/tiers";
import type { QuoteLineItem, Item } from "@/lib/supabase/database.types";

type Cycle = "monthly" | "yearly";

export interface SupportPlanPickerProps {
  /** The tenant's catalogue, already loaded by the builder. */
  items: readonly Item[];
  /** Add a line to the quote. The builder owns merging and list-price freezing. */
  onAdd: (line: QuoteLineItem) => void;
  /**
   * The support line already on the quote, if any.
   *
   * ─── WHY THE PICKER COLLAPSES INSTEAD OF DISAPPEARING ──────────────────────
   * Pardeep: once a plan is added, the three big cards should stop taking the screen.
   * Right — three cards for a decision already made is the largest block on the page
   * arguing for something the operator has already agreed to.
   *
   * But removing the section outright breaks three things, and all three are worse than
   * the wasted space:
   *   • Nothing on screen says WHICH plan was added without scrolling to the line items.
   *   • Changing your mind — Standard to Enterprise — has nowhere to happen.
   *   • Re-opening a saved draft would show no support section at all, so a plan added by
   *     mistake could never be removed from here.
   *
   * So it collapses to one line that states the plan, the price, and keeps Change and
   * Remove a single click away. The screen space comes back and nothing becomes
   * unreachable.
   */
  selected?: { name: string; annualRate: number; cycleLabel: string } | null;
  /** Take the support line off the quote. */
  onRemove?: () => void;
  /**
   * R-364: set only when the signed-in role may edit the catalogue
   * (canEditSupportCatalog). A missing plan then gets an "Add to catalog" button
   * instead of only a red line. Absent = no button: the catalogue is not theirs to change.
   */
  catalogAccess?: { tenantId: string; tenantName: string | null } | null;
}

export function SupportPlanPicker({ items, onAdd, selected, onRemove, catalogAccess }: SupportPlanPickerProps) {
  const [cycle, setCycle] = React.useState<Cycle>("yearly");
  /* "Change" reopens the cards without removing the line — the operator is choosing, not
     yet deciding, and taking their plan away mid-thought would be its own small betrayal. */
  const [changing, setChanging] = React.useState(false);
  /* R-364: the plan whose "Add to catalog" dialog is open, if any. */
  const [creating, setCreating] = React.useState<{ tier: SupportTier; cycle: Cycle } | null>(null);

  /* One place that puts a plan on the quote — used by "Add to quote" and right after
     "Add to catalog", so both write the same line. A quote line's `rate` is the ANNUAL
     figure whatever the billing frequency (database.types.ts); the catalogue row's own
     price wins over the tier definition (supportLineRate). */
  const addPlan = (tier: SupportTier, planCycle: Cycle, sku: Pick<Item, "id" | "name" | "msrp" | "prices">) => {
    /* Changing plan removes the old line first, so the quote never carries
       two support plans — a quote with both Standard and Enterprise on it
       is not a choice the customer made. */
    if (changing && onRemove) onRemove();
    onAdd({
      id:        `sup-${tier.id}-${planCycle}-${Date.now()}`,
      item_id:   sku.id,
      name:      sku.name,
      qty:       1,
      rate:      supportLineRate(sku, tier, planCycle),
      cost:      0,
      commitment: planCycle === "yearly" ? "annual_yearly" : "monthly",
    });
    setChanging(false);
  };

  /* ── DECIDED: one line, not three cards ─────────────────────────────────── */
  if (selected && !changing) {
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="flex items-center gap-1.5">
          <Icon name="check_circle" size={15} className="shrink-0 text-emerald" />
          <span className="text-[13px] font-medium text-ink">{selected.name}</span>
          <Badge kind="success" size="sm">added to quote</Badge>
        </span>
        <span className="font-mono text-[13px] tabular-nums text-ink-2">
          {rupee(selected.annualRate)} {selected.cycleLabel}
        </span>
        <span className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => setChanging(true)}
            className="text-[12px] font-semibold text-amber-ink hover:underline"
          >
            Change plan
          </button>
          {onRemove && (
            <button
              type="button"
              onClick={onRemove}
              className="text-[12px] font-semibold text-ink-3 hover:text-rose hover:underline"
            >
              Remove
            </button>
          )}
        </span>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <h3 className="text-[13px] font-semibold text-ink">Support plan</h3>
          <p className="text-2xs text-ink-3">Sold alongside the licences, billed on its own cycle.</p>
        </div>

        {/* Two buttons rather than a dropdown: there are exactly two answers and the
            comparison is the point. */}
        <div className="flex rounded-lg border border-hairline p-0.5" role="group" aria-label="Billing cycle">
          {(["monthly", "yearly"] as Cycle[]).map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setCycle(c)}
              aria-pressed={cycle === c}
              className={cn(
                "rounded-md px-3 py-1 text-[12px] font-medium transition-colors",
                cycle === c ? "bg-ink text-paper" : "text-ink-2 hover:bg-paper-2",
              )}
            >
              {c === "monthly" ? "Monthly" : "Yearly"}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
        {SUPPORT_TIERS.map((tier) => {
          const sku    = findSupportSku(items, tier.id, cycle);
          const saving = annualSaving(tier);
          const isFree = tier.monthly === 0 && tier.annualTotal === 0;
          /* The catalogue row's price when there is one, so the card shows what the
             quote line will carry (R-364: a price typed in "Add to catalog" is real). */
          const shownPrice = (sku ? supportRowPrice(sku, cycle) : null) ?? supportPrice(tier, cycle);

          return (
            <div key={tier.id} className="rounded-lg border border-hairline p-3">
              <div className="mb-1 flex items-center gap-1.5">
                <span aria-hidden>{tier.icon}</span>
                <span className="text-[13px] font-semibold text-ink">{tier.label}</span>
                {cycle === "yearly" && saving && (
                  <Badge kind="success" size="sm">
                    Save {saving.percent}%
                  </Badge>
                )}
              </div>

              <p className="mb-1.5 font-serif text-lg tabular-nums text-ink">
                {isFree ? "Free" : rupee(shownPrice)}
                {!isFree && (
                  <span className="ml-1 text-2xs font-sans text-ink-3">
                    {cycle === "yearly" ? "/yr" : "/mo"}
                  </span>
                )}
              </p>

              {cycle === "yearly" && saving && (
                <p className="mb-1.5 text-2xs text-emerald">
                  {saving.monthsFree} months free · {rupee(saving.rupees)} off {rupee(tier.monthly * 12)}
                </p>
              )}

              <p className="mb-2 text-2xs leading-snug text-ink-3">{tier.summary}</p>

              <ul className="mb-2.5 space-y-0.5 text-2xs text-ink-3">
                <li>· First response in {tier.slaHours}h</li>
                <li>
                  ·{" "}
                  {tier.channels.whatsapp === "24x7" ? "WhatsApp, 24/7"
                    : tier.channels.whatsapp === "business_hours" ? "WhatsApp in business hours"
                    : "Email only"}
                </li>
                <li>
                  ·{" "}
                  {tier.channels.meetCallsPerMonth === null ? "Unlimited live calls"
                    : tier.channels.meetCallsPerMonth > 0 ? `${tier.channels.meetCallsPerMonth} live calls a month`
                    : "No live calls"}
                </li>
              </ul>

              {/* A ₹0 plan is not something you put on a quote — there is nothing to
                  invoice, and generate_invoice refuses a zero-value tax invoice. It
                  is what a customer has when they buy nothing. */}
              {isFree ? (
                <p className="text-2xs italic text-ink-3">
                  Included by default — nothing to add to a quote.
                </p>
              ) : !sku ? (
                /* Never quote a plan the catalogue does not hold. If the row is missing the
                   catalogue is what needs fixing — R-364: and for someone who may edit it,
                   fixing it is one click here rather than a trip to another page. */
                catalogAccess ? (
                  <div className="space-y-1.5">
                    <p className="text-2xs leading-snug text-ink-3">Not in your catalogue yet.</p>
                    <Button
                      size="sm"
                      variant="outline"
                      icon="plus"
                      className="w-full justify-center"
                      onClick={() => setCreating({ tier, cycle })}
                    >
                      Add to catalog
                    </Button>
                  </div>
                ) : (
                  <p className="text-2xs leading-snug text-rose">
                    Not in your catalogue yet. Ask an owner or manager to add it under
                    Catalog &amp; Products, then it can go on a quote.
                  </p>
                )
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="w-full justify-center"
                  onClick={() => addPlan(tier, cycle, sku)}
                >
                  {changing ? "Use this plan" : "Add to quote"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {creating && catalogAccess && (
        <AddSupportPlanDialog
          tier={creating.tier}
          cycle={creating.cycle}
          access={catalogAccess}
          onClose={() => setCreating(null)}
          onCreated={(row) => {
            setCreating(null);
            addPlan(creating.tier, creating.cycle, row);
          }}
        />
      )}
    </div>
  );
}

/**
 * R-364 — create a missing support plan in the catalogue, then put it on the quote.
 *
 * Reuses useCreateItem (the catalogue page's own mutation: stamps the caller's tenant,
 * RLS refuses any other, errors go through toastError). Name is prefilled the way the
 * seed names it; the price is prefilled only from SUPPORT_TIERS — the definition the
 * seed itself used — and is required, whole rupees, editable.
 */
function AddSupportPlanDialog({
  tier, cycle, access, onClose, onCreated,
}: {
  tier: SupportTier;
  cycle: Cycle;
  access: { tenantId: string; tenantName: string | null };
  onClose: () => void;
  onCreated: (row: Item) => void;
}) {
  const create = useCreateItem();
  const known  = knownSupportPrice(tier, cycle);
  const [name, setName]   = React.useState(() => supportCatalogName(tier, cycle, access.tenantName));
  const [price, setPrice] = React.useState(() => (known === null ? "" : String(known)));
  const [touched, setTouched] = React.useState(false);

  const priceOk = isValidSupportPrice(price);
  const nameOk  = name.trim().length > 0;
  const per     = cycle === "yearly" ? "per year" : "per month";

  const save = async () => {
    setTouched(true);
    if (!priceOk || !nameOk || create.isPending) return;
    try {
      const row = await create.mutateAsync(
        supportCatalogRow({ tier, cycle, tenantId: access.tenantId, name, price: Number(price.trim()) }),
      );
      onCreated(row);
    } catch {
      /* useCreateItem already showed the reason via toastError; the dialog stays open. */
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="md:!max-w-md">
        <DialogHeader>
          <DialogTitle>Add {tier.label} support ({cycle === "yearly" ? "Yearly" : "Monthly"}) to catalog</DialogTitle>
          <DialogDescription>{tier.summary}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(e) => { e.preventDefault(); void save(); }}
        >
          <FormField label="Name" required>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              error={touched && !nameOk ? "Enter a name." : undefined}
            />
          </FormField>
          <FormField label={`Price (₹ ${per})`} required>
            <Input
              inputMode="numeric"
              prefix="₹"
              value={price}
              onChange={(e) => setPrice(e.target.value)}
              onBlur={() => setTouched(true)}
              placeholder="Whole rupees"
              error={touched && !priceOk ? "Enter a price in whole rupees, above ₹0." : undefined}
              helper={known !== null ? "Your standard price for this plan. Change it if you charge differently." : undefined}
            />
          </FormField>
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
            <Button type="submit" variant="primary" loading={create.isPending} disabled={!priceOk || !nameOk}>
              Add to catalog and quote
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
