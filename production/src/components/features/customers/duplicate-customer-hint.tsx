/**
 * R-2715 — "Looks like <existing customer> — open it", one click. The SAME box on the Onboard
 * dialog (action = use that customer) and /customers/new (action = open its page). The rule
 * that finds the matches is lib/customers/duplicate-match.ts.
 */
"use client";

import * as React from "react";
import Link from "next/link";
import type { Route } from "next";
import { matchReasonText, type CustomerMatch, type MatchableCustomer } from "@/lib/customers/duplicate-match";

export function DuplicateCustomerHint<T extends MatchableCustomer>({
  matches,
  actionLabel,
  onPick,
  hrefFor,
}: {
  matches: readonly CustomerMatch<T>[];
  /** "Use it" (Onboard dialog) or "Open it" (/customers/new). */
  actionLabel: string;
  /** Onboard dialog: pick the existing customer. */
  onPick?: (c: T) => void;
  /** /customers/new: the existing customer's page. */
  hrefFor?: (c: T) => string;
}) {
  if (matches.length === 0) return null;
  return (
    <ul
      className="mt-1 rounded-lg border border-amber/60 bg-paper shadow-sm overflow-hidden"
      aria-label="Existing customers that look the same"
      data-testid="duplicate-customer-hint"
    >
      {matches.map(({ customer: c, reason }) => {
        const why = matchReasonText(reason);
        const action = "font-semibold text-amber-ink underline underline-offset-2 whitespace-nowrap focus:outline-none focus-visible:ring-2 focus-visible:ring-amber rounded";
        return (
          <li key={c.id} className="px-2.5 py-1.5 text-xs flex items-center justify-between gap-2 odd:bg-amber-soft/40">
            <span className="min-w-0 truncate text-ink">
              Looks like <span className="font-semibold">{c.name}</span>
              {why ? <span className="text-ink-2"> ({why})</span> : null}
              {c.domain ? <span className="font-mono text-2xs text-ink-3"> · {c.domain}</span> : null}
            </span>
            {hrefFor ? (
              <Link href={hrefFor(c) as Route} className={action} aria-label={`${actionLabel}: ${c.name}`}>
                {actionLabel}
              </Link>
            ) : (
              <button type="button" onClick={() => onPick?.(c)} className={action} aria-label={`${actionLabel}: ${c.name}`}>
                {actionLabel}
              </button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
