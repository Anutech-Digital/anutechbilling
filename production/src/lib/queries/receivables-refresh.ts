/**
 * R-1634 — one refresh for every screen that shows what a customer owes.
 *
 * Payment Follow-up (/collections) reads ["collections"]; no money save refreshed it, so after
 * a payment (even one recorded on /collections' own sheet) the row kept the old balance until
 * a reload. Each save had its own hand-written list, and each list forgot a different screen
 * (R-1589 found the same for Aging). Every save that changes a balance — a payment recorded,
 * edited, refunded or deleted, a credit note, an invoice raised, a write-off — calls this
 * instead, so the next screen that shows a balance is added HERE, once.
 *
 * Keys are prefixes: ["payments"] also refreshes ["payments", "by-quote", id], and
 * ["collections"] the customer page's ["collections", "customer", id].
 * receivables-refresh.test.ts fails on a save that refreshes these keys by hand.
 */
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { queryKeys } from "./keys";

export const RECEIVABLE_KEYS: readonly (readonly string[])[] = [
  ["payments"],
  ["invoices"],
  ["quotes"],
  ["subscriptions"],
  ["customers"],
  ["outstanding-receivables"],
  queryKeys.collections(),
  ["nav-badges"],
  ["tds_receivable"],
  queryKeys.customerCredits(),
  queryKeys.aging(),
  /* R-1680: the customer page's Statement and money tiles also read credit notes and project
     money; after a payment they kept old figures ("Lifetime paid —") until a reload. */
  ["credit-notes"],
  ["project_sales"],
  ["project_payments"],
];

/** Mark every balance screen stale; a mounted one re-reads at once. */
export function invalidateReceivables(qc: QueryClient): void {
  for (const key of RECEIVABLE_KEYS) void qc.invalidateQueries({ queryKey: key as unknown as QueryKey });
}
