/**
 * R-1707 (21 Oct 2026) — what is really still owed on each quote in the /quotes list.
 *
 * The list computed amount − quotes.payment_amount. That ignores credit notes, refunds and what
 * the invoice itself says is still payable: #0020 (T-L5) — invoiced ₹38,232, refunded and
 * credit-noted, invoice net ₹0 — showed "₹38,232 due" and sat in Awaiting payment.
 *
 * quote_open_balance() (R-1686) is the one rule. quote_open_balances() returns it for every
 * quote of the caller's company in ONE call (paged past PostgREST's 1000-row cap) — never one
 * request per row.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import { fetchAllRows, type PageQuery } from "@/lib/ops/fetch-all";

export interface QuoteOpenBalanceRow {
  quote_id: string;
  open_balance: number | null;
}

type OpenBalancesRpc = (fn: "quote_open_balances") => {
  order: (column: "quote_id", opts: { ascending: boolean }) => {
    range: (from: number, to: number) => PageQuery<QuoteOpenBalanceRow>;
  };
};

/** quote id → ₹ still owed (whole rupees, never negative). */
export type OpenBalanceMap = ReadonlyMap<string, number>;

export function toOpenBalanceMap(rows: readonly QuoteOpenBalanceRow[]): OpenBalanceMap {
  const m = new Map<string, number>();
  for (const r of rows) if (typeof r.open_balance === "number") m.set(r.quote_id, r.open_balance);
  return m;
}

/**
 * Each quote with `open_balance` set from the map. A quote missing from the map (balances not
 * loaded yet, or the read failed) gets `open_balance: null` — which the list rules read as
 * "not known", and they fall back to amount − payment_amount as before (never to 0).
 */
export function withOpenBalances<Q extends { id: string }>(
  quotes: readonly Q[] | undefined,
  balances: OpenBalanceMap | undefined,
): (Q & { open_balance: number | null })[] | undefined {
  if (!quotes) return undefined;
  return quotes.map((q) => ({ ...q, open_balance: balances?.get(q.id) ?? null }));
}

export function useQuoteOpenBalances() {
  return useQuery({
    queryKey: ["quotes", "open-balances"],
    queryFn: async (): Promise<OpenBalanceMap> => {
      const supabase = createClient();
      const rpc = supabase.rpc as unknown as OpenBalancesRpc;
      const rows = await fetchAllRows<QuoteOpenBalanceRow>((from, to) =>
        rpc.call(supabase, "quote_open_balances").order("quote_id", { ascending: true }).range(from, to),
      );
      return toOpenBalanceMap(rows);
    },
  });
}
