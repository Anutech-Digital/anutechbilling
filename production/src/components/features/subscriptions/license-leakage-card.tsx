"use client";

/**
 * License leakage — seats we pay for but do not bill.
 *
 * ─── UNDER- AND OVER-BILLING ARE SHOWN SEPARATELY, NEVER NETTED ─────────────
 * ₹5,000 leaking on one customer and ₹5,000 over-charged on another is not "no
 * problem". It is two problems, and one of them is a refund the customer has not
 * asked for yet. A net figure of zero would hide both.
 *
 * ─── AND "NOT CHECKED" IS SHOWN AS NOT CHECKED ──────────────────────────────
 * A subscription never reconciled against the vendor has no vendor seat count.
 * Rendering it as ₹0 leakage would put a clean tick on exactly the rows nobody has
 * looked at. It gets its own count, with the way to fix it.
 */
import * as React from "react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { cn, rupee, formatDate } from "@/lib/utils";
import type { Item, Subscription } from "@/lib/supabase/database.types";
import { assessLeakage, leakageTotals, leakageSortKey, type LeakageResult } from "@/lib/vendor/leakage";
import { subscriptionCogs } from "@/lib/vendor/cogs";

/** Active subscriptions with their leakage verdict, worst first. Shared by this card and
 *  the closed Insights strip on /subscriptions (R-1727), so both count the same rows. */
export function leakageRows(subscriptions: Subscription[], catalog: Item[]): { sub: Subscription; result: LeakageResult }[] {
  return subscriptions
    .filter((s) => s.status === "active")
    .map((s) => {
      const cogs = subscriptionCogs(s, catalog);
      const result = assessLeakage({
        vendorSeats: s.vendor_seats,
        billedSeats: s.seats,
        assignedSeats: s.used,
        costPerSeatMonth: cogs.perSeatMonth,
        /* What the customer pays per seat, derived from MRR rather than the
           catalogue: a negotiated subscription is not on list price, and a refund
           is owed at what was actually charged. */
        pricePerSeatMonth: s.seats > 0 ? Math.round(s.mrr / s.seats) : null,
      });
      return { sub: s, result };
    })
    .sort((a, b) => leakageSortKey(a.result) - leakageSortKey(b.result));
}

export function LicenseLeakageCard({ subscriptions, catalog, onReconcile, onBillGap, defaultOpen = false }: {
  subscriptions: Subscription[];
  catalog: Item[];
  onReconcile?: () => void;
  /**
   * Bill the missing seats on a LEAKING subscription — opens Manage seats with the gap
   * already filled in.
   *
   * Only offered for under-billed. Over-billing is usually deliberate (a customer buying
   * ahead of new staff), so a button here would push the operator toward undoing
   * something they meant to do.
   */
  onBillGap?: (sub: Subscription, seats: number) => void;
  /** R-1727: open when shown inside the Insights strip, which is itself the collapse. */
  defaultOpen?: boolean;
}) {
  const rows = React.useMemo(() => leakageRows(subscriptions, catalog), [subscriptions, catalog]);

  const totals = React.useMemo(() => leakageTotals(rows.map((r) => r.result)), [rows]);
  const [open, setOpen] = React.useState(defaultOpen);
  /* Stable id so aria-controls points at something real — useId, not a hand-rolled
     counter, because the card can appear more than once on a page. */
  const bodyId = React.useId();
  /* Leaking only — see the note on the tiles. Over-billed rows are shown in the Seats
     column of the table instead, where the action is per customer. */
  const actionable = rows.filter((r) => r.result.kind === "under_billed");

  if (rows.length === 0) return null;

  return (
    <Card
      title="License leakage"
      sub="Seats the vendor bills us for vs seats we bill the customer"
      /* Collapsible, like the Revenue Analytics card above it — same words, same
         chevrons, same open-by-default, because two collapsibles on one page that
         behave differently is a small tax paid on every visit.

         Starts CLOSED (Abhishek, 12 Sep 2026) — this page is opened to act on a
         subscription, not to read analytics, and two tall panels pushed the list itself
         below the fold. Safe to close ONLY because the collapsed header still states the
         leak: see the summary line below. A panel that shut with nothing but its title
         would hide the very number it exists to surface. */
      actions={
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={bodyId}
          className="flex items-center gap-1 text-xs font-semibold text-amber-ink hover:opacity-80 transition-opacity cursor-pointer"
        >
          <span>{open ? "Collapse" : "Expand"}</span>
          <Icon name={open ? "chevron_up" : "chevron_down"} size={14} />
        </button>
      }
    >
      {/* Collapsed, the card still has to say whether there is anything to come back
          for. A bare title tells the operator nothing, and "nothing to see" and "₹12,000
          leaking, hidden" would look identical. */}
      {!open && (
        <p className="text-xs text-ink-2">
          {totals.underBilledCount > 0
            ? `${rupee(totals.underBilledMonthly)}/mo leaking`
            : totals.unknownCount > 0
              ? `${totals.unknownCount} ${totals.unknownCount === 1 ? "subscription" : "subscriptions"} never checked against the vendor`
              : "Nothing leaking"}
        </p>
      )}

      <div id={bodyId} hidden={!open}>
      {/* ── THIS CARD IS ABOUT LEAKAGE, IN ONE DIRECTION ──────────────────────
          A third tile used to sit here — "Billed ahead of vendor", the cases where the
          customer is charged for more seats than the vendor has provisioned. Abhishek
          removed it on 23 Sep 2026: "showing overbilled in leakage is not right".

          He is right twice over. The card is named for seats WE PAY FOR AND DO NOT BILL,
          and the other direction is not that — it is the opposite sign, so a reader
          scanning two rupee figures has to work out which is which before either means
          anything. And the common cause is deliberate: customers buy two or four seats
          ahead of staff who have not joined, which he had already corrected the wording
          for. A card that reports normal business alongside lost margin teaches the
          owner to skim both.

          The finding is NOT lost. Every over-billed subscription still carries an amber
          "OVER-BILLED" badge in the Seats column of the table below, which is where it is
          acted on anyway — per customer, not as a total. `leakageTotals` still computes
          overBilledMonthly for any caller that wants it. */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Figure
          label="Leaking (we pay, not billed)"
          value={rupee(totals.underBilledMonthly)}
          suffix="/mo"
          count={totals.underBilledCount}
          tone={totals.underBilledCount > 0 ? "bad" : undefined}
        />
        <Figure
          label="Never reconciled"
          value={String(totals.unknownCount)}
          suffix={totals.unknownCount === 1 ? " subscription" : " subscriptions"}
          tone={totals.unknownCount > 0 ? "warn" : undefined}
        />
      </div>

      {totals.unpricedCount > 0 && (
        <p className="mt-2 text-2xs leading-snug text-amber-ink">
          {totals.unpricedCount} {totals.unpricedCount === 1 ? "gap has" : "gaps have"} no catalogue cost, so the
          seats are counted above but the money is not.
        </p>
      )}

      {totals.unknownCount > 0 && onReconcile && (
        <div className="mt-3 rounded-lg border border-hairline bg-paper-2/50 p-3">
          <p className="text-[12px] leading-snug text-ink-2">
            Nothing here is guessed. {totals.unknownCount} {totals.unknownCount === 1 ? "subscription has" : "subscriptions have"} never
            been checked against the vendor, so we cannot say whether they are leaking.
          </p>
          <Button size="sm" variant="default" className="mt-2" onClick={onReconcile}>
            Match Google&apos;s bill
          </Button>
        </div>
      )}

      {actionable.length > 0 && (
        <ul className="mt-4 divide-y divide-hairline border-t border-hairline">
          {actionable.map(({ sub, result }) => (
            <li key={sub.id} className="py-2.5">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-ink">
                    {sub.customer_name}
                    {sub.domain && <span className="ml-1.5 font-mono text-2xs text-ink-3">{sub.domain}</span>}
                  </p>
                  <p className="mt-0.5 text-2xs leading-snug text-ink-2">{result.message}</p>
                  {sub.vendor_synced_at && (
                    <p className="mt-0.5 text-3xs text-ink-3">
                      Vendor count from {formatDate(sub.vendor_synced_at)}
                    </p>
                  )}
                </div>
                <div className="shrink-0 text-right">
                  <Badge kind={result.kind === "under_billed" ? "danger" : "warning"} size="sm">
                    {result.seatGap! > 0 ? `+${result.seatGap}` : result.seatGap} seats
                  </Badge>
                  {result.monthlyImpact != null && (
                    <p className={cn(
                      "mt-1 text-sm font-medium tabular-nums",
                      result.kind === "under_billed" ? "text-rose" : "text-amber-ink",
                    )}>
                      {rupee(result.monthlyImpact)}<span className="text-3xs font-normal text-ink-3">/mo</span>
                    </p>
                  )}
                  {/* §24: a finding with no way to act on it is a nag. The seat count is
                      known exactly, so the button carries it rather than asking for it
                      again. */}
                  {result.kind === "under_billed" && result.seatGap != null && onBillGap && (
                    <Button
                      size="sm"
                      variant="primary"
                      icon="plus"
                      className="mt-1.5"
                      onClick={() => onBillGap(sub, result.seatGap!)}
                    >
                      Bill {result.seatGap} seat{result.seatGap === 1 ? "" : "s"}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* ── SAYS ONLY WHAT THIS CARD CHECKED ──────────────────────────────────
          This read "Every active subscription matches the vendor", which was true while
          the card reported BOTH directions. Since over-billed moved out (23 Sep 2026) it
          would be a false all-clear: a customer billed for two seats the vendor never
          provisioned does not match, and the card would have said they did. The claim is
          now exactly as wide as the check behind it. */}
      {actionable.length === 0 && totals.unknownCount === 0 && (
        <p className="mt-3 flex items-center gap-1.5 text-sm text-emerald">
          <Icon name="check_circle" size={14} /> No active subscription is leaking.
        </p>
      )}
      </div>
    </Card>
  );
}

function Figure({ label, value, suffix, count, tone }: {
  label: string; value: string; suffix?: string; count?: number; tone?: "bad" | "warn";
}) {
  return (
    <div className="rounded-lg border border-hairline bg-paper-2/40 p-3">
      <p className="text-3xs uppercase tracking-wider font-semibold text-ink-3">{label}</p>
      <p className={cn(
        "mt-0.5 font-serif text-lg font-bold tabular-nums",
        tone === "bad" ? "text-rose" : tone === "warn" ? "text-amber-ink" : "text-ink",
      )}>
        {value}{suffix && <span className="text-xs font-normal text-ink-3">{suffix}</span>}
      </p>
      {count != null && count > 0 && (
        <p className="mt-0.5 text-3xs text-ink-3">
          across {count} {count === 1 ? "subscription" : "subscriptions"}
        </p>
      )}
    </div>
  );
}

export type { LeakageResult };
