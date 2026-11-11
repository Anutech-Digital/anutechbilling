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

export const zohoMatchKeys = {
  matches: ["bank_transactions", "zoho-expense-matches"] as const,
};

export function useZohoExpenseMatches(enabled: boolean) {
  return useQuery({
    queryKey: zohoMatchKeys.matches,
    enabled,
    queryFn: async (): Promise<ZohoMatchRow[]> => {
      const { data, error } = await untyped().rpc("zoho_expense_bank_matches", {});
      if (error) throw new Error(error.message);
      return (data ?? []) as ZohoMatchRow[];   // the server orders: clean first, then by paid date
    },
    staleTime: 10_000,
  });
}
