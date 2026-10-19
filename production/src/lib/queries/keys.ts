/**
 * R-1589 — one place for the TanStack Query keys that were invalidated under a name no
 * screen used.
 *
 * WHY: Aging read under ["accounting", "aging"] while nine save paths (payment, credit note,
 * debit note, bank match, late fee, credit activation, project receipt…) invalidated
 * ["aging"]; Purchase Orders read under "purchase_orders" while a payment delete invalidated
 * "purchase-orders"; P&L read under ["accounting", "pnl", …] while a commission payment
 * invalidated ["pnl"]. Nothing errors — the screen just shows the old number until a reload.
 *
 * The query and every invalidation of it take the key from here, so the two cannot drift.
 * Each function returns the PREFIX: a query appends its own parts (range, filters), and
 * invalidating the prefix refreshes every variant. `query-key-orphans.test.ts` fails on any
 * invalidation whose key no query uses.
 */
export const queryKeys = {
  /** Accounting → Aging (receivables by age bucket). */
  aging: () => ["accounting", "aging"] as const,
  /** Accounting → P&L — every range, the trend and the comparison period. */
  pnl: () => ["accounting", "pnl"] as const,
  /** Customer advance credits — open total per customer, and per-customer totals on the list. */
  customerCredits: () => ["customer_credits"] as const,
  /** Purchase Orders — the list, a subscription's POs and the summary. */
  purchaseOrders: () => ["purchase_orders"] as const,
  /** Bank accounts (balances) — the accounts list and one account. */
  bankAccounts: () => ["bank_accounts"] as const,
  /** Bank statement lines — every account's lines, matched and unmatched. */
  bankTransactions: () => ["bank_transactions"] as const,
} as const;
