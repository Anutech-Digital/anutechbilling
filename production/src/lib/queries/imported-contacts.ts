/**
 * Imported contacts (standalone directory) — TanStack Query hooks.
 *
 * These live in the dedicated `contacts` table — separate from leads /
 * customers. Used for Google CSV imports + manual entries that aren't
 * yet engaged enough to be a lead.
 */

"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import type { ContactRow, ContactStatus } from "@/lib/supabase/database.types";

/** All contacts in the standalone table (any status). */
export function useImportedContacts() {
  return useQuery({
    queryKey: ["imported_contacts"],
    queryFn: async (): Promise<ContactRow[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("contacts")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as ContactRow[];
    },
  });
}

/** Mark a contact as engaged / archived (status flip, not promotion). */
export function useUpdateContactStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, status }: { id: string; status: ContactStatus }) => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("contacts")
        .update({ status })
        .eq("id", id)
        .select("*")
        .single();
      if (error) throw error;
      return data as ContactRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["imported_contacts"] });
    },
    onError: (e) => toast.error((e as Error).message || "Status update nahi hua"),
  });
}

/** Delete a contact (only for archived ones). */
export function useDeleteContact() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("contacts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["imported_contacts"] });
      toast.success("Contact deleted");
    },
    onError: (e) => toast.error((e as Error).message || "Delete nahi hua"),
  });
}
