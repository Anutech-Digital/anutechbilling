/**
 * R-2386 — Private Vault "Money I owe / hold for others" (table personal_owe_hold,
 * migration 20261102183751_r2386_personal_owe_hold.sql). Same owner-only RLS as every vault
 * table; every write stamps owner/tenant from the session (requireIdentity), never a prop.
 *
 * Its own module (not personal-vault.ts) so a screen test can mock it in one line.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { requireIdentity, invalidateAll } from "@/lib/queries/personal-vault";
import type { OweHoldKind, OweHoldSettledHow, OweHoldStatus } from "@/lib/vault/personal/owe-hold";

// ─── Money I owe / hold for others (R-2386, migration 20261102183751) ─────────
//
// personal_owe_hold: an advance (byana) received for a sale, or money held on behalf of
// someone. Same owner-only RLS as every vault table. The table is newer than the generated
// DB types (another card holds database.generated.ts), so the row shape is written here and
// the client is used untyped for this one table.

export interface PersonalOweHold {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  kind: OweHoldKind;
  party: string;
  /** YYYY-MM-DD */
  occurred_on: string;
  /** Whole rupees, > 0. */
  amount: number;
  note: string | null;
  /** Where the cash sits — one of the owner's personal accounts. */
  account_id: string | null;
  status: OweHoldStatus;
  settled_on: string | null;
  settled_how: OweHoldSettledHow | null;
  settle_note: string | null;
  created_at: string;
  updated_at: string;
}

export type PersonalOweHoldInput = Pick<PersonalOweHold, "kind" | "party" | "occurred_on" | "amount" | "note" | "account_id"> & { id?: string };

const OWE_HOLD = "personal_owe_hold";
const oweHoldDb = () => createClient() as unknown as SupabaseClient;

export function usePersonalOweHold() {
  return useQuery({
    queryKey: ["personal-vault", "owe-hold"],
    queryFn: async (): Promise<PersonalOweHold[]> => {
      const { data, error } = await oweHoldDb()
        .from(OWE_HOLD)
        .select("*")
        .order("status")
        .order("occurred_on", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PersonalOweHold[];
    },
    staleTime: 30_000,
  });
}

export function useSavePersonalOweHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PersonalOweHoldInput) => {
      const db = oweHoldDb();
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;
      if (id) {
        const { error } = await db.from(OWE_HOLD).update({ ...fields, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        return;
      }
      const { error } = await db.from(OWE_HOLD).insert({ ...fields, tenant_id: tenantId, owner_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the entry." }),
  });
}

/** Close an open entry: refunded / handed over / converted into the sale price. */
export function useSettlePersonalOweHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; settled_how: OweHoldSettledHow; settled_on: string; settle_note: string | null }) => {
      await requireIdentity();
      const { id, ...fields } = input;
      const { error } = await oweHoldDb()
        .from(OWE_HOLD)
        .update({ ...fields, status: "settled", updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "open");
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not settle the entry." }),
  });
}

export function useDeletePersonalOweHold() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await oweHoldDb().from(OWE_HOLD).delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the entry." }),
  });
}
