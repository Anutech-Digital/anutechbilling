/**
 * MarginAlertsCard — the repricing queue.
 *
 * Shows subscriptions that are losing money or nearly losing money at TODAY's vendor
 * cost, worst first, with the annual rupee figure so the operator can see which one
 * to phone about. Silent when everything is healthy — an always-visible card that
 * usually says "all good" gets scrolled past, and then gets scrolled past on the day
 * it doesn't.
 *
 * ─── WHY IT SHOWS THE UNPRICEABLE ROWS TOO ──────────────────────────────────
 * Most plans in this app have no catalog row, so their margin is genuinely unknown
 * (see lib/subscriptions/plan-match.ts — 21 of the 29 products the add-subscription
 * dialog can write have no `items` row at all). Those appear in a separate, quieter
 * section headed by what is actually missing. A margin card that only showed priced
 * rows would let an operator conclude "no alerts, so my margins are fine" when the
 * truth is "I have no cost data for most of what I sell".
 *
 * Per §24 every block/warning names the next step: for a loss, reprice at renewal;
 * for an unpriceable row, add the wholesale price to the catalog.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/ui/button";
import { rupee, cleanDisplayName } from "@/lib/utils";
import { formatBps } from "@/lib/subscriptions/margin";
import { useMarginAlerts, type MarginAlert } from "@/lib/queries/margin-alerts";

/** Paise → the app's rupee formatter, which takes rupees. */
const r = (paise: number | null | undefined) =>
  paise === null || paise === undefined ? "—" : rupee(Math.round(paise / 100));

function AlertRow({ a }: { a: MarginAlert }) {
  const loss = a.status === "loss";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-4 py-3 last:border-0">
      <Icon
        name={loss ? "trending_down" : "alert"}
        size={15}
        className={loss ? "flex-shrink-0 text-rose" : "flex-shrink-0 text-amber-ink"}
      />

      <div className="min-w-0 flex-1">
        <Link
          href={`/subscriptions?q=${encodeURIComponent(a.customerName)}`}
          className="block truncate text-sm font-semibold text-ink hover:underline"
        >
          {cleanDisplayName(a.customerName)}
        </Link>
        <p className="truncate text-xs text-ink-3">
          {a.plan} · {a.seats} seat{a.seats === 1 ? "" : "s"} ·{" "}
          {r(a.sellPerSeatMonthPaise)}/seat sell vs {r(a.costPerSeatMonthPaise)} cost
        </p>
      </div>

      <div className="text-right">
        <div className={loss ? "font-mono text-sm font-bold text-rose" : "font-mono text-sm font-bold text-amber-ink"}>
          {formatBps(a.marginBps)}
        </div>
        {/* The number that decides whether this is worth a phone call today. */}
        <div className="text-2xs text-ink-3">
          {(a.grossAnnualPaise ?? 0) < 0 ? "losing " : ""}
          {r(Math.abs(a.grossAnnualPaise ?? 0))}/yr
        </div>
      </div>

      <Badge kind={loss ? "danger" : "warning"} size="sm">
        {loss ? "Loss" : "Thin"}
      </Badge>
    </li>
  );
}

/**
 * The card itself, taking data as a prop so what the operator READS can be tested
 * without a Supabase mock. `MarginAlertsCard` below is the hook wrapper.
 */
export function MarginAlertsView({ alerts: data }: { alerts: MarginAlert[] }) {
  const bleeding  = data.filter((a) => a.needsRepricing);
  const unpriced  = data.filter((a) => a.unmatched);
  if (bleeding.length === 0 && unpriced.length === 0) return null;

  const annualBleed = bleeding.reduce(
    (sum, a) => sum + Math.min(0, a.grossAnnualPaise ?? 0), 0,
  );

  return (
    <Card
      flush
      title={
        <span className="flex items-center gap-2">
          <Icon name="trending_down" size={15} className="text-rose" />
          Margin at risk
        </span>
      }
      sub={
        bleeding.length > 0
          ? `${bleeding.length} subscription${bleeding.length === 1 ? "" : "s"} at or below the margin floor` +
            (annualBleed < 0 ? ` · ${r(Math.abs(annualBleed))}/yr going out the door` : "")
          : "No priced subscription is at risk — but see below"
      }
      actions={
        <Button variant="default" icon="package" asChild>
          <Link href="/items">Products</Link>
        </Button>
      }
    >
      {bleeding.length > 0 && (
        <ul>{bleeding.map((a) => <AlertRow key={a.subscriptionId} a={a} />)}</ul>
      )}

      {bleeding.length > 0 && (
        <p className="border-b border-hairline bg-paper-2 px-4 py-2.5 text-xs leading-relaxed text-ink-2">
          <b>What to do:</b> these are priced against today&apos;s wholesale cost, so the
          margin is already gone — the customer is locked in until renewal. Reprice at
          renewal (Generate renewal quote on the subscription) rather than mid-term.
        </p>
      )}

      {/* The quieter, more important half: rows we cannot judge at all. */}
      {unpriced.length > 0 && (
        <div className="px-4 py-3">
          <p className="text-xs leading-relaxed text-ink-2">
            <b>{unpriced.length} subscription{unpriced.length === 1 ? "" : "s"} cannot be
            checked</b> — no wholesale price in the catalog for{" "}
            {[...new Set(unpriced.map((a) => a.plan))].slice(0, 4).join(", ")}
            {new Set(unpriced.map((a) => a.plan)).size > 4 ? " and others" : ""}. Their
            margin is unknown, not healthy. Add the vendor cost in{" "}
            <Link href="/items" className="font-semibold text-primary hover:underline">
              Products
            </Link>{" "}
            and they will start being checked.
          </p>
        </div>
      )}
    </Card>
  );
}

export function MarginAlertsCard() {
  const { data, isLoading, error } = useMarginAlerts();
  // Silent while loading. A skeleton for a card that is usually absent is noise.
  if (isLoading || error || !data) return null;
  return <MarginAlertsView alerts={data} />;
}
