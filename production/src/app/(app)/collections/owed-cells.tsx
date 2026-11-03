"use client";
/**
 * R-2408 — the cells of a Payment Follow-up row, moved out of page.tsx. The "What's owed" cell
 * is compact: the oldest line only, "+N more" opens the rest (with the renewal buttons), so a
 * row stays one line high and ≥12 customers fit a 1280 screen.
 */
import * as React from "react";
import Link from "next/link";
import type { Route } from "next";

import { Badge } from "@/components/ui/badge";
import { Icon } from "@/components/ui/icon";
import { rupee, formatDate } from "@/lib/utils";
import { tdsShortfallLine } from "@/lib/accounting/tds-match";
import { RenewalActions } from "@/components/features/renewals/renewal-actions";
import type { CollectionRow, OwedItem, RenewalItem } from "@/lib/queries/collections";
import { amountCell } from "./worklist";
import { STAGE_HINT, STAGE_LABEL, STAGE_TONE, type CollectionStage } from "@/lib/collections/priority";

export type CanOpen = (href: string) => boolean;

export function MaybeLink({ href, canOpen, children, className }: { href: string | null; canOpen: CanOpen; children: React.ReactNode; className?: string }) {
  if (!href || !canOpen(href)) return <span className={className}>{children}</span>;
  // Typed routes (Next build, not tsc): a computed href is cast, as in kpi.tsx / academy.
  return <Link href={href as Route} className={`${className ?? ""} text-ink hover:underline underline-offset-2`}>{children}</Link>;
}

export function CustomerName({ r, canOpen }: { r: CollectionRow; canOpen: CanOpen }) {
  return <MaybeLink href={r.customerHref} canOpen={canOpen}>{r.customerName}</MaybeLink>;
}

/**
 * Real dues; a renewal-only row shows its renewal amount (R-2408 — it showed "—"), marked
 * "renewal" so it is never read as money already owed (R-2401).
 */
export function AmountCell({ r, className }: { r: CollectionRow; className?: string }) {
  const a = amountCell(r);
  if (a.kind === "renewal") {
    return (
      <div className={`text-ink-2 tabular-nums whitespace-nowrap ${className ?? ""}`} title="Renewal not invoiced yet — not counted in the amount due">
        {rupee(a.main)}
        <span className="block text-3xs uppercase tracking-wider text-ink-3 font-sans font-normal">renewal</span>
      </div>
    );
  }
  return (
    <>
      <div className={`text-ink tabular-nums whitespace-nowrap ${className ?? ""}`}>{rupee(a.main)}</div>
      {a.extraRenewal > 0 && (
        <div className="text-2xs text-ink-3 tabular-nums whitespace-nowrap" title="Renewal not invoiced yet — not counted in the amount due">
          + {rupee(a.extraRenewal)} renewal
        </div>
      )}
    </>
  );
}

/**
 * Oldest line on one row; "+N more" shows every line (and the renewal buttons). `open` is
 * owned by the page so the table and the phone card share it.
 */
export function OwedCell({ r, canOpen, open, onToggle }: { r: CollectionRow; canOpen: CanOpen; open: boolean; onToggle: () => void }) {
  const lines = r.items.length + r.renewals.length;
  if (open) {
    return (
      <div>
        <ul className="space-y-1">
          {r.items.map((i) => <li key={`${i.kind}:${i.id}`}><OwedLine item={i} canOpen={canOpen} /></li>)}
          {r.renewals.map((i) => <li key={`renewal:${i.id}`}><RenewalLine item={i} canOpen={canOpen} /></li>)}
        </ul>
        <button type="button" onClick={onToggle} aria-expanded className="mt-1 text-2xs text-ink-3 underline underline-offset-2 hover:text-ink">
          Show less
        </button>
      </div>
    );
  }
  const first = r.items[0];
  const firstRenewal = r.renewals[0];
  const hint = r.items.find((i) => i.tdsHint);
  return (
    <div className="min-w-0">
      <div className="flex items-baseline gap-1.5 min-w-0">
        {first ? (
          <>
            <span className="text-3xs uppercase tracking-wider text-ink-3 shrink-0">{first.kind === "invoice" ? "Inv" : "Sub"}</span>
            <MaybeLink href={first.href} canOpen={canOpen} className="font-mono text-xs truncate">{first.label}</MaybeLink>
          </>
        ) : firstRenewal ? (
          <>
            <span className="text-3xs uppercase tracking-wider text-ink-3 shrink-0">Renewal</span>
            <MaybeLink href={firstRenewal.href} canOpen={canOpen} className="font-mono text-xs truncate">{firstRenewal.label}</MaybeLink>
          </>
        ) : null}
        {lines > 1 || firstRenewal || hint ? (
          <button
            type="button"
            onClick={onToggle}
            aria-expanded={false}
            aria-label={`Show all ${lines} lines for ${r.customerName}`}
            className="shrink-0 text-2xs text-ink-3 underline underline-offset-2 hover:text-ink whitespace-nowrap"
          >
            {lines > 1 ? `+${lines - 1} more` : "Details"}
          </button>
        ) : null}
      </div>
      {hint && <p className="text-2xs text-amber-ink truncate" title={hint.tdsHint ? tdsShortfallLine(hint.tdsHint) : undefined}>Looks like TDS — open details</p>}
    </div>
  );
}

/** R-2401: a renewal to chase — when it renews / renewed, its amount, and the shared renewal buttons. */
function RenewalLine({ item, canOpen }: { item: RenewalItem; canOpen: CanOpen }) {
  const days = item.daysOverdue;   // >0 = past the renewal date
  const when = days > 0
    ? `Expired ${formatDate(item.renewalDate)} · ${days} ${days === 1 ? "day" : "days"} ago`
    : days === 0 ? "Renews today" : `Renews ${formatDate(item.renewalDate)} · in ${-days} ${days === -1 ? "day" : "days"}`;
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-3xs uppercase tracking-wider text-ink-3">Renewal</span>
        <MaybeLink href={item.href} canOpen={canOpen} className="font-mono text-xs break-all">{item.label}</MaybeLink>
        <span className="font-mono text-xs text-ink-2 tabular-nums" title={item.estimate ? "Term amount before GST — no renewal quote yet" : "Amount of the renewal quote"}>
          {rupee(item.amount)}{item.estimate ? " est." : ""}
        </span>
        {item.quoteHref && item.quoteId && (
          <MaybeLink href={item.quoteHref} canOpen={canOpen} className="text-xs text-ink-3">Quote {item.quoteId}</MaybeLink>
        )}
      </div>
      <p className={`mt-0.5 text-xs ${days > 0 ? "text-rose-600 font-medium" : "text-ink-3"}`}>{when}</p>
      <div className="mt-1">
        <RenewalActions sub={item.sub} daysUntil={-days} layout="table" />
      </div>
    </div>
  );
}

function OwedLine({ item, canOpen }: { item: OwedItem; canOpen: CanOpen }) {
  return (
    <div className="min-w-0">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-3xs uppercase tracking-wider text-ink-3">{item.kind === "invoice" ? "Invoice" : "Subscription"}</span>
        <MaybeLink href={item.href} canOpen={canOpen} className="font-mono text-xs break-all">{item.label}</MaybeLink>
        <span className="font-mono text-xs text-ink-2 tabular-nums">{rupee(item.amountDue)}</span>
        {item.quoteHref && item.quoteId && (
          <MaybeLink href={item.quoteHref} canOpen={canOpen} className="text-xs text-ink-3">Quote {item.quoteId}</MaybeLink>
        )}
        {item.kind === "invoice" && item.subscriptionHref && (
          <MaybeLink href={item.subscriptionHref} canOpen={canOpen} className="text-xs text-ink-3">Subscription</MaybeLink>
        )}
      </div>
      {item.tdsHint && (
        <p className="text-xs text-amber-ink mt-0.5">
          <Icon name="info" size={12} className="inline mr-1 align-text-bottom" />
          {tdsShortfallLine(item.tdsHint)} —{" "}
          <MaybeLink href={item.href} canOpen={canOpen} className="underline">record it as TDS in Record payment</MaybeLink>
        </p>
      )}
    </div>
  );
}

export function OverdueBadge({ days }: { days: number }) {
  if (days <= 0) return <Badge kind="muted">Not due yet</Badge>;
  return <Badge kind={days > 60 ? "danger" : days > 30 ? "warning" : "muted"}>{days} {days === 1 ? "day" : "days"}</Badge>;
}

export function PromiseText({ r }: { r: CollectionRow }) {
  if (!r.promisedOn) return <span className="text-ink-3">—</span>;
  const title = r.promiseBroken ? "Date passed, promised amount not paid" : r.promiseStatus === "kept" ? "Kept — paid" : undefined;
  return (
    <span className={r.promiseBroken ? "text-rose font-medium" : "text-ink-2"} title={title}>
      {formatDate(r.promisedOn)}
      {r.promisedAmount != null && r.promisedAmount > 0 && <span className="block text-2xs tabular-nums">{rupee(r.promisedAmount)}</span>}
      {r.promiseStatus === "kept" && <span className="block text-2xs text-ink-3">Kept — paid</span>}
    </span>
  );
}

/** R-2409: the row's ONE stage (priority.ts rowStage) — small, so it sits beside the note. */
export function StageChip({ stage }: { stage: CollectionStage }) {
  return (
    <Badge kind={STAGE_TONE[stage]} size="sm" className="shrink-0" title={STAGE_HINT[stage]}>
      {STAGE_LABEL[stage]}
    </Badge>
  );
}

export function NextText({ r }: { r: CollectionRow }) {
  if (!r.nextFollowUpOn) return <span className="text-ink-3">Not set</span>;
  return <span className={r.followUpDue ? "text-rose font-medium" : "text-ink-2"}>{formatDate(r.nextFollowUpOn)}</span>;
}
