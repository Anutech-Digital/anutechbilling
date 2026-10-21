/**
 * R-1697 — "Record payment" on Payments → Subscription dues (owner: not "Pay", not "Payment aaya").
 *
 * Pardeep (20 Oct): the row button read "Pay", which sounds like WE pay — it records money
 * RECEIVED from the customer. And it only appeared when the customer had a partial/invoiced
 * quote, so subscriptions made by import, by "Correct details", or activated on credit (quote
 * still unpaid) had no way to record the money at all — only Remind / Suspend.
 *
 * No new money rule here. The only path that lowers subscriptions.outstanding_amount is
 * record_payment on the subscription's quote (it rewrites the balance of subscriptions with
 * quote_id = that quote, and a paid renewal quote clears its subscription). Instalment and
 * multi-invoice payments also go through the subscription's quote. So a row routes to:
 *   1. its open renewal quote, else 2. its own open quote, else 3. the quote the dues list
 *   found for THIS subscription (R-1701: the same rule, read with the dues rows — it used to be
 *   the customer's "latest" quote, which sent a two-subscription customer's rows to one bill), else
 *   4. blocked — disabled, with the reason and a link to Subscriptions to fix the link.
 * "Open" = the quote's payment_status is not "received" (fully paid). Recording on a fully
 * received quote would only become advance credit and leave this balance where it is.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

export const DUES_PAY_LABEL = "Record payment";
export const DUES_PAY_HINT = "Customer ne paisa diya — yahan darj karo";

/** The subscription's own quote links, read straight from the subscription row. */
export interface DuesQuoteLinks {
  quoteId: string | null;
  quoteStatus: string | null;
  renewalQuoteId: string | null;
  renewalQuoteStatus: string | null;
}

export type DuesPaymentRoute =
  | { kind: "quote"; quoteId: string }
  | { kind: "loading" }
  | { kind: "blocked"; reason: string; fixHref: string; fixLabel: string };

const isOpen = (status: string | null) => status !== "received";

export function duesPaymentRoute(
  row: { subscription_id: string; customer_name: string; quote_id: string | null },
  links: DuesQuoteLinks | undefined,
): DuesPaymentRoute {
  /* R-1718: the dues list's own pick first (buildDuesRows — the quote this row's Balance due is
     owed on), so the button and the Record payment dialog read the same bill as the row. */
  if (row.quote_id) return { kind: "quote", quoteId: row.quote_id };
  if (links?.renewalQuoteId && isOpen(links.renewalQuoteStatus)) return { kind: "quote", quoteId: links.renewalQuoteId };
  if (links?.quoteId && isOpen(links.quoteStatus)) return { kind: "quote", quoteId: links.quoteId };
  if (!links) return { kind: "loading" };
  const fixHref = `/subscriptions?q=${encodeURIComponent(row.customer_name)}`;
  if (links.quoteId) {
    return {
      kind: "blocked",
      reason: `Its quote ${links.quoteId} is already fully paid, yet a balance shows — money recorded here would only become advance credit. Check the balance in Subscriptions first.`,
      fixHref,
      fixLabel: "Open in Subscriptions",
    };
  }
  return {
    kind: "blocked",
    reason: "This subscription has no quote (it was imported or made with Correct details), so there is no bill to record the money against. Link it to its quote in Subscriptions.",
    fixHref,
    fixLabel: "Open in Subscriptions",
  };
}

/** Reads quote_id / renewal_quote_id of the dues subscriptions and those quotes' payment status. */
export function useDuesQuoteLinks(subscriptionIds: string[]) {
  const key = [...subscriptionIds].sort();
  return useQuery({
    queryKey: ["outstanding-receivables", "quote-links", key],
    enabled: key.length > 0,
    queryFn: async (): Promise<Map<string, DuesQuoteLinks>> => {
      const supabase = createClient();
      const subs: Array<{ id: string; quote_id: string | null; renewal_quote_id: string | null }> = [];
      for (let i = 0; i < key.length; i += 200) {
        const { data, error } = await supabase
          .from("subscriptions")
          .select("id, quote_id, renewal_quote_id")
          .in("id", key.slice(i, i + 200));
        if (error) throw error;
        subs.push(...(data ?? []));
      }
      const quoteIds = [...new Set(subs.flatMap((s) => [s.quote_id, s.renewal_quote_id]).filter((q): q is string => !!q))];
      const status = new Map<string, string | null>();
      for (let i = 0; i < quoteIds.length; i += 200) {
        const { data, error } = await supabase
          .from("quotes")
          .select("id, payment_status")
          .in("id", quoteIds.slice(i, i + 200));
        if (error) throw error;
        for (const q of data ?? []) status.set(q.id, q.payment_status ?? null);
      }
      /* A quote id the reader cannot see (deleted / other tenant) counts as no quote. */
      const seen = (id: string | null) => (id && status.has(id) ? id : null);
      return new Map(subs.map((s) => [s.id, {
        quoteId: seen(s.quote_id),
        quoteStatus: s.quote_id ? status.get(s.quote_id) ?? null : null,
        renewalQuoteId: seen(s.renewal_quote_id),
        renewalQuoteStatus: s.renewal_quote_id ? status.get(s.renewal_quote_id) ?? null : null,
      }]));
    },
  });
}

export function DuesPayButton({
  route,
  onRecord,
  className,
}: {
  route: DuesPaymentRoute;
  onRecord: (quoteId: string) => void;
  className?: string;
}) {
  if (route.kind === "blocked") {
    return (
      <span className={className ? `${className} inline-flex flex-col items-end gap-0.5 max-w-[16rem]` : "inline-flex flex-col items-end gap-0.5 max-w-[16rem]"}>
        <Button size="sm" variant="primary" icon="wallet" disabled title={route.reason} aria-label={`${DUES_PAY_LABEL} — ${route.reason}`}>
          {DUES_PAY_LABEL}
        </Button>
        <span className="text-3xs text-ink-3 text-right leading-snug">
          {route.reason}{" "}
          <Link href={route.fixHref as never} className="text-amber-ink hover:underline">{route.fixLabel}</Link>
        </span>
      </span>
    );
  }
  return (
    <Button
      size="sm"
      variant="primary"
      icon="wallet"
      className={className}
      title={DUES_PAY_HINT}
      aria-label={`${DUES_PAY_LABEL} — ${DUES_PAY_HINT}`}
      disabled={route.kind === "loading"}
      onClick={route.kind === "quote" ? () => onRecord(route.quoteId) : undefined}
    >
      {DUES_PAY_LABEL}
    </Button>
  );
}
