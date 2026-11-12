/**
 * R-2655 (11 Nov 2026, G-RECON N6) — "Match Zoho expenses" on Banking: the preview RPC
 * zoho_expense_bank_matches (migration 20261111161638_r2655_zoho_expense_bank_match; read only,
 * owner / accountant only, own company only). Untyped client: the RPC is newer than
 * database.types.ts (as lib/queries/bank-pairs). The key starts with "bank_transactions", so any
 * reconcile anywhere refreshes the preview too.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/client";
import type { ZohoMatchRow } from "@/lib/banking/zoho-expense-match";

const untyped = () => createClient() as unknown as SupabaseClient;

/** Rows per request, and where the reading stops (20 pages). */
export const ZOHO_MATCH_PAGE = 1000;
export const ZOHO_MATCH_MAX_ROWS = 20_000;

const rowKey = (r: ZohoMatchRow) => `${r.zoho_doc_id}:${r.txn_id ?? ""}`;

export const zohoMatchKeys = {
  matches: ["bank_transactions", "zoho-expense-matches"] as const,
};

export function useZohoExpenseMatches(enabled: boolean) {
  return useQuery({
    queryKey: zohoMatchKeys.matches,
    enabled,
    queryFn: async (): Promise<ZohoMatchRow[]> => {
      /* Read in pages: PostgREST and the data gateway cap one answer at 1,000 rows (R-265), and a full
         FY import can list more. The server’s order is total (status, paid date, document, line), so
         pages do not overlap. */
      const out: ZohoMatchRow[] = [];
      for (let from = 0; from < ZOHO_MATCH_MAX_ROWS; from += ZOHO_MATCH_PAGE) {
        const { data, error } = await untyped().rpc("zoho_expense_bank_matches", {}).range(from, from + ZOHO_MATCH_PAGE - 1);
        if (error) throw new Error(error.message);
        const page = (data ?? []) as ZohoMatchRow[];
        /* A server that ignores the range sends the first page again — stop, never list a row twice. */
        if (from > 0 && page[0] && rowKey(page[0]) === rowKey(out[0])) break;
        out.push(...page);
        if (page.length < ZOHO_MATCH_PAGE) break;
      }
      return out;   // the server orders: clean first, then by paid date
    },
    staleTime: 10_000,
  });
}
