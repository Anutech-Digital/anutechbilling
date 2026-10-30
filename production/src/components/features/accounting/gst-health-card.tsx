/**
 * GST health — invoices whose tax head cannot be justified.
 *
 * ─── WHY A CARD AND NOT A BADGE ─────────────────────────────────────────────
 * The findings are not "3 problems". They are a rupee figure and a list of names, and
 * both are needed to decide whether to act today. A count alone ("3 GST issues") gets
 * postponed; "Rs 3,10,207 of GST resting on a place of supply nobody established, across
 * these nine customers" does not.
 *
 * ─── WHEN IT IS CLEAN IT SAYS SO ────────────────────────────────────────────
 * It does not disappear. An absent card and a card that has not loaded look identical,
 * and on this screen the difference is "your books are fine" versus "you have not been
 * told yet" — the exact bug fixed on the subscription card on 21 Aug, where a paid
 * subscription rendered nothing and blank space was left to mean "Paid".
 *
 * ─── IT NEVER OFFERS TO FIX ANYTHING ────────────────────────────────────────
 * Every action links to the CUSTOMER, because that is where the cause lives and one edit
 * clears all of their findings. Nothing here edits an invoice: a tax head cannot be
 * corrected by changing an issued document, that needs a credit note (CGST s.34), and a
 * one-click "fix" would produce books that disagree with the paper the customer holds.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { Card } from "@/components/ui/card";
import { Icon } from "@/components/ui/icon";
import { Skeleton } from "@/components/ui/skeleton";
import { rupee } from "@/lib/utils";
import { useGstHealth } from "@/lib/queries/gst-health";

export function GstHealthCard() {
  const { data, isLoading, error } = useGstHealth();
  /* Collapsed by default: the headline (rupee figure + counts) stays visible, so the
     finding is never hidden — only the per-customer detail folds away. */
  const [open, setOpen] = React.useState(false);
  const listId = React.useId();

  if (isLoading) {
    return (
      <Card className="p-4 mb-4">
        <Skeleton className="h-4 w-40 mb-2" />
        <Skeleton className="h-3 w-64" />
      </Card>
    );
  }

  /* An error must not read as "all clear" — the whole point of this card is that silence
     is never good news. */
  if (error) {
    return (
      <Card className="p-4 mb-4 border-hairline">
        <p className="text-[13px] text-ink-2">
          <b className="text-ink">GST check could not run.</b>{" "}
          {error instanceof Error ? error.message : "Unknown error"}. This is not the same as
          having nothing to report — reload to try again.
        </p>
      </Card>
    );
  }

  if (!data) return null;

  if (data.customers.length === 0) {
    return (
      <Card className="p-4 mb-4">
        <div className="flex items-center gap-2.5">
          <Icon name="check_circle" size={16} className="text-emerald shrink-0" />
          <p className="text-[13px] text-ink-2">
            <b className="text-ink">GST looks right on all {data.invoicesChecked} invoices.</b>{" "}
            Every one has a place of supply that was determined rather than assumed, and the
            tax adds up.
          </p>
        </div>
      </Card>
    );
  }

  const one = data.customers.length === 1;

  return (
    <Card className="mb-4 p-0 overflow-hidden border-rose/40">
      <div className={`px-4 py-3 bg-rose-soft/50 ${open ? "border-b border-rose/25" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <p className="text-[13px] text-rose-ink">
            <b>{rupee(data.totalAtRisk)} of GST</b> is resting on something that was never
            established, across {data.customers.length} customer{one ? "" : "s"} and{" "}
            {data.invoicesWithIssues} invoice{data.invoicesWithIssues === 1 ? "" : "s"}.
          </p>
          <span className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-ink-3 tabular-nums">
              {data.invoicesChecked} checked
            </span>
            <button
              type="button"
              onClick={() => setOpen((o) => !o)}
              aria-expanded={open}
              aria-controls={listId}
              className="inline-flex items-center gap-1 rounded-md border border-rose/30 bg-paper px-2 py-1 text-xs font-medium text-ink-2 hover:text-ink hover:border-rose/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber"
            >
              {open ? "Collapse" : "Expand"}
              <Icon name={open ? "chevron_up" : "chevron_down"} size={13} />
            </button>
          </span>
        </div>
        {/* The amount is not a shortfall, and saying so prevents the wrong panic. */}
        {open && (
          <p className="mt-1 text-xs leading-snug text-ink-3">
            This is the tax whose <b>head</b> may be wrong (CGST + SGST vs IGST), not money
            missing. The customer paid the right total; it may have gone into the wrong pots,
            and they may be unable to claim the credit.
          </p>
        )}
      </div>

      <ul id={listId} hidden={!open} className="divide-y divide-hairline">
        {data.customers.map((c, idx) => (
          /* R-2058: rows without a customer all share one name, so the index keeps them apart. */
          <li key={c.customerId ?? `no-customer-${idx}`} className="px-4 py-2.5">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="text-[13px] font-medium text-ink">
                {c.customerName}
                <span className="ml-1.5 text-xs font-normal text-ink-3">
                  {c.invoiceCount} invoice{c.invoiceCount === 1 ? "" : "s"}
                </span>
              </span>
              <span className="flex items-center gap-3 shrink-0">
                <span className="text-[12px] tabular-nums text-rose">{rupee(c.atRisk)}</span>
                {c.customerId && (
                  /* Links to the CUSTOMER, not the invoice: the cause is the missing or
                     wrong state, and one edit there clears every finding below. */
                  <Link
                    href={`/customers/${c.customerId}` as never}
                    className="text-[12px] font-medium text-amber-ink hover:underline inline-flex items-center gap-0.5"
                  >
                    Fix <Icon name="arrow_right" size={12} />
                  </Link>
                )}
              </span>
            </div>
            <ul className="mt-1 space-y-0.5">
              {c.issues.map((i) => (
                <li key={i.code} className="text-xs leading-snug text-ink-3">
                  <span className={i.severity === "critical" ? "text-rose-ink" : "text-amber-ink"}>
                    {i.severity === "critical" ? "●" : "○"}
                  </span>{" "}
                  {i.headline}
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
    </Card>
  );
}
