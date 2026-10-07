/**
 * R-337 — read/save the tenant's aggregate turnover bracket (tenants.aggregate_turnover).
 *
 * Same shape as profile.ts: an untyped client because the column is newer than
 * database.types.ts, and a "column does not exist" answer reads as "not sure" (no banner)
 * instead of an error, so the app behaves exactly as before the migration is applied.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import { isMissingTurnoverColumn, turnoverFromRow, type TurnoverBracket, type TurnoverState } from "./einvoice";

const untyped = () => createClient() as unknown as SupabaseClient;

export function useTurnoverBracket() {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: ["tenant_turnover", tenantId],
    enabled: Boolean(tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<TurnoverState> => {
      const { data, error } = await untyped()
        .from("tenants")
        .select("aggregate_turnover")
        .eq("id", tenantId as string)
        .maybeSingle();
      return turnoverFromRow(data as { aggregate_turnover?: unknown } | null, error);
    },
  });
}

export function useSaveTurnoverBracket() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useMutation({
    mutationFn: async (bracket: TurnoverBracket | null) => {
      if (!tenantId) throw new Error("Not signed in to a workspace");
      const { data, error } = await untyped()
        .from("tenants")
        .update({ aggregate_turnover: bracket })
        .eq("id", tenantId)
        .select("id");
      if (isMissingTurnoverColumn(error)) {
        throw new Error("This option is not switched on yet — it needs a database update first.");
      }
      if (error) throw new Error(error.message);
      // RLS lets only the owner update the tenant row; anyone else gets zero rows, not an error.
      if (!data || data.length === 0) throw new Error("Only the workspace owner can change this.");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant_turnover"] });
      toast.success("Turnover saved");
    },
    onError: (err) => toast.error(`Could not save: ${(err as Error).message}`),
  });
}
