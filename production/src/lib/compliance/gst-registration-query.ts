/**
 * R-1529 — read/save the tenant's GST registration (tenants.gst_registration,
 * gst_composition_rate, gst_registered_from).
 *
 * Same shape as turnover.ts: an untyped read so a database without the migration answers
 * "not chosen" (the card says it needs a database update) instead of breaking Settings.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toast } from "sonner";

import { createClient } from "@/lib/supabase/client";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import {
  gstRegistrationFromRow, gstRegistrationPatch, gstRegistrationProblem, isMissingGstRegistrationColumn,
  type GstRegistrationInput, type GstRegistrationState,
} from "./gst-registration";

const untyped = () => createClient() as unknown as SupabaseClient;

export function useGstRegistration() {
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useQuery({
    queryKey: ["tenant_gst_registration", tenantId],
    enabled: Boolean(tenantId),
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<GstRegistrationState> => {
      const { data, error } = await untyped()
        .from("tenants")
        .select("gst_registration, gst_composition_rate, gst_registered_from")
        .eq("id", tenantId as string)
        .maybeSingle();
      return gstRegistrationFromRow(data as Record<string, unknown> | null, error);
    },
  });
}

export function useSaveGstRegistration() {
  const qc = useQueryClient();
  const me = useCurrentUser();
  const tenantId = me.data?.tenantId ?? null;
  return useMutation({
    mutationFn: async (input: GstRegistrationInput) => {
      if (!tenantId) throw new Error("Not signed in to a workspace");
      const problem = gstRegistrationProblem(input);
      if (problem) throw new Error(problem);
      const { data, error } = await untyped()
        .from("tenants")
        .update(gstRegistrationPatch(input))
        .eq("id", tenantId)
        .select("id");
      if (isMissingGstRegistrationColumn(error)) {
        throw new Error("This option is not switched on yet — it needs a database update first.");
      }
      if (error?.message?.includes("tenants_unregistered_no_gstin_check")) {
        throw new Error("A business that is not registered has no GSTIN. Clear the GSTIN in Company information and save it first.");
      }
      if (error) throw new Error(error.message);
      // RLS lets only the owner update the tenant row; anyone else gets zero rows, not an error.
      if (!data || data.length === 0) throw new Error("Only the workspace owner can change this.");
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant_gst_registration"] });
      toast.success("GST registration saved", {
        description: "New invoices follow it from now on. Invoices already issued stay exactly as they are.",
      });
    },
    onError: (err) => toast.error("Could not save the GST registration", {
      description: (err as Error).message,
    }),
  });
}
