/**
 * R-1513 (17 Oct 2026, Pardeep): "subscription se direct us subscription ke related quote
 * aur related customer par jaane ka option hona chahiye."
 *
 * Every subscription row (desktop table + phone card) and its drawer carries:
 *   · the customer name as a link → /customers/<customer_id>
 *   · a "Quote" link → /quotes/<quote id> — the NEWEST quote behind it: the renewal quote
 *     when one was raised, else the quote it was created from. No quote → no link (never a
 *     dead one). Only for roles that can open quotes (R-237: middleware throws billing
 *     back to /invoices).
 *
 * The links sit inside a row that opens the drawer on click / Enter, so they stop both the
 * click and the key from reaching the row — otherwise Enter on the link would be
 * preventDefault-ed by the row and open the drawer instead of the page.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { Icon } from "@/components/ui/icon";
import { cleanDisplayName, cn } from "@/lib/utils";

/* Typed routes (CLAUDE.md §25.2): hrefs here are plain strings, cast to Route only where
   they reach <Link> / router.push. A Route-typed ternary (Route | null) makes next build fail
   with "Expression produces a union type that is too complex to represent" — tsc does not. */

export interface SubLinkInput {
  customer_id: string | null;
  quote_id?: string | null;
  renewal_quote_id?: string | null;
}

export function subscriptionLinks(sub: SubLinkInput, opts: { canQuotes: boolean }): {
  customerHref: string | null;
  quoteHref: string | null;
  quoteId: string | null;
} {
  const quoteId = sub.renewal_quote_id?.trim() || sub.quote_id?.trim() || null;
  return {
    customerHref: sub.customer_id ? `/customers/${encodeURIComponent(sub.customer_id)}` : null,
    quoteHref: opts.canQuotes && quoteId ? `/quotes/${encodeURIComponent(quoteId)}` : null,
    quoteId,
  };
}

const stop = (e: React.SyntheticEvent) => e.stopPropagation();
const linkClass =
  "rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber";

/** The customer name — a link when the subscription is tied to a customer. */
export function SubCustomerLink({ sub, name, className }: {
  sub: SubLinkInput; name: string | null | undefined; className?: string;
}) {
  const { customerHref } = subscriptionLinks(sub, { canQuotes: false });
  const label = cleanDisplayName(name ?? "");
  if (!customerHref) return <span className={className}>{label}</span>;
  return (
    <Link
      href={customerHref as Route}
      onClick={stop}
      onKeyDown={stop}
      title={`Open customer ${label}`}
      className={cn(linkClass, "hover:underline underline-offset-2 hover:text-amber-ink", className)}
    >
      {label}
    </Link>
  );
}

/** "Quote" — the quote this subscription came from (newest). Renders nothing without one. */
export function SubQuoteLink({ sub, canQuotes, className }: {
  sub: SubLinkInput; canQuotes: boolean; className?: string;
}) {
  const { quoteHref, quoteId } = subscriptionLinks(sub, { canQuotes });
  if (!quoteHref) return null;
  const renewal = !!sub.renewal_quote_id?.trim();
  return (
    <Link
      href={quoteHref as Route}
      onClick={stop}
      onKeyDown={stop}
      title={renewal ? `Open renewal quote ${quoteId}` : `Open quote ${quoteId}`}
      className={cn(
        linkClass,
        "inline-flex items-center gap-1 text-2xs font-medium text-amber-ink hover:underline underline-offset-2",
        className,
      )}
    >
      <Icon name="file" size={11} className="flex-shrink-0" />
      {renewal ? "Renewal quote" : "Quote"}
    </Link>
  );
}
