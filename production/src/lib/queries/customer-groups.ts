/**
 * Customer Groups / Parent Accounts — TanStack Query hooks.
 *
 * A group is an umbrella that links several customer companies routed by one
 * common reseller/coordinator (X). Reporting layer only — each member company
 * keeps its own GSTIN + invoices + payments. See migration 0168.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { CustomerGroup, Database } from "@/lib/supabase/database.types";

type GroupInsert = Database["public"]["Tables"]["customer_groups"]["Insert"];
type GroupUpdate = Database["public"]["Tables"]["customer_groups"]["Update"];

// ── List ──────────────────────────────────────────────────────────────────
export function useCustomerGroups() {
  return useQuery({
    queryKey: ["customer_groups"],
    queryFn: async (): Promise<CustomerGroup[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_groups")
        .select("*")
        .order("name", { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });
}

// ── Single ────────────────────────────────────────────────────────────────
export function useCustomerGroup(id: string | undefined) {
  return useQuery({
    queryKey: ["customer_groups", id],
    enabled: !!id,
    queryFn: async (): Promise<CustomerGroup | null> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_groups")
        .select("*")
        .eq("id", id!)
        .maybeSingle();
      if (error) throw error;
      return data;
    },
  });
}

// ── Create (fetches tenant_id automatically) ────────────────────────────────
export function useCreateCustomerGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<GroupInsert, "tenant_id">): Promise<CustomerGroup> => {
      const supabase = createClient();
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");
      const { data: me, error: meErr } = await supabase
        .from("users").select("tenant_id").eq("id", authData.user.id).single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { data, error } = await supabase
        .from("customer_groups")
        .insert({ ...input, tenant_id: me.tenant_id, created_by: authData.user.id })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer_groups"] });
    },
    onError: (e) => toastError(e, { fallback: "Could not create the group." }),
  });
}

// ── Update ──────────────────────────────────────────────────────────────────
export function useUpdateCustomerGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: GroupUpdate }): Promise<CustomerGroup> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("customer_groups")
        .update(patch)
        .eq("id", id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: (_d, { id }) => {
      qc.invalidateQueries({ queryKey: ["customer_groups"] });
      qc.invalidateQueries({ queryKey: ["customer_groups", id] });
    },
    onError: (e) => toastError(e, { fallback: "Could not save the group." }),
  });
}

// ── Delete (un-links member customers via ON DELETE SET NULL) ────────────────
export function useDeleteCustomerGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const supabase = createClient();
      const { error } = await supabase.from("customer_groups").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customer_groups"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
    },
    onError: (e) => toastError(e, { fallback: "Could not delete the group." }),
  });
}

// ── Assign / unassign a single customer to a group (customers.group_id) ──────
export function useSetCustomerGroup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ customerId, groupId }: { customerId: string; groupId: string | null }): Promise<void> => {
      const supabase = createClient();
      const { error } = await supabase
        .from("customers")
        .update({ group_id: groupId })
        .eq("id", customerId);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["customers"] });
      qc.invalidateQueries({ queryKey: ["customer_groups"] });
    },
    onError: (e) => toastError(e, { fallback: "Could not change this company's group." }),
  });
}
