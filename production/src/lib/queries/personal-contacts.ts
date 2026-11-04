/**
 * R-2392 — Private Vault → People (table personal_contacts, migration
 * 20261103003100_r2392_personal_contacts.sql). Same owner-only RLS as every vault table;
 * every insert stamps owner/tenant from the session (requireIdentity), never a prop.
 *
 * Never the company's customers / contacts: this module reads personal_contacts and the
 * personal_* rows linked to it, nothing else.
 *
 * Its own module so a screen test can mock it in one line. The table is newer than the
 * generated DB types, so the row shape is written here and the client is used untyped.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { requireIdentity, invalidateAll } from "@/lib/queries/personal-vault";
import type { ContactRelation } from "@/lib/vault/personal/contacts";

export interface PersonalContact {
  id: string;
  tenant_id: string;
  owner_user_id: string;
  name: string;
  relation: ContactRelation;
  phone: string | null;
  email: string | null;
  pan: string | null;
  note: string | null;
  archived: boolean;
  created_at: string;
  updated_at: string;
}

export type PersonalContactInput = Pick<PersonalContact, "name" | "relation" | "phone" | "email" | "pan" | "note"> & { id?: string };

/** A personal_transactions row as the People page shows it. */
export interface PersonalContactTx {
  id: string;
  kind: string;
  income_source: string | null;
  category: string | null;
  amount: number;
  occurred_on: string;
  note: string | null;
}

const CONTACTS = "personal_contacts";
const db = () => createClient() as unknown as SupabaseClient;

/** Every contact of the signed-in owner (archived too — the picker and the list filter them). */
export function usePersonalContacts() {
  return useQuery({
    queryKey: ["personal-vault", "contacts"],
    queryFn: async (): Promise<PersonalContact[]> => {
      const { data, error } = await db().from(CONTACTS).select("*").order("name");
      if (error) throw error;
      return (data ?? []) as PersonalContact[];
    },
    staleTime: 30_000,
  });
}

/** Add or edit a contact. Returns the saved row (the picker selects a new one at once). */
export function useSavePersonalContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: PersonalContactInput): Promise<PersonalContact> => {
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;
      if (id) {
        const { data, error } = await db().from(CONTACTS)
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", id).select("*").single();
        if (error) throw error;
        return data as PersonalContact;
      }
      const { data, error } = await db().from(CONTACTS)
        .insert({ ...fields, tenant_id: tenantId, owner_user_id: userId })
        .select("*").single();
      if (error) throw error;
      return data as PersonalContact;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the person." }),
  });
}

/** Archive (hide from the picker) or bring back. Linked rows keep their link. */
export function useArchivePersonalContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { id: string; archived: boolean }) => {
      await requireIdentity();
      const { error } = await db().from(CONTACTS)
        .update({ archived: input.archived, updated_at: new Date().toISOString() })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not change the person." }),
  });
}

/** Income / expense rows linked to one person (all of them, not only the latest 200). */
export function usePersonalContactTransactions(contactId: string | null) {
  return useQuery({
    queryKey: ["personal-vault", "contact-transactions", contactId],
    enabled: Boolean(contactId),
    queryFn: async (): Promise<PersonalContactTx[]> => {
      const { data, error } = await db()
        .from("personal_transactions")
        .select("id, kind, income_source, category, amount, occurred_on, note")
        .eq("contact_id", contactId)
        .order("occurred_on", { ascending: false });
      if (error) throw error;
      return (data ?? []).map((r) => ({ ...(r as PersonalContactTx), amount: Number((r as { amount: unknown }).amount) }));
    },
    staleTime: 30_000,
  });
}
