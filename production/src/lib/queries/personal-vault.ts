/**
 * The owner's private vault — TanStack Query hooks (migration 20260819170000).
 *
 * ─── EVERY WRITE STAMPS owner_user_id FROM THE SESSION ──────────────────────
 * Never from a prop, never from a picker. RLS refuses a row whose `owner_user_id` is not
 * `auth.uid()`, so a mis-stamped insert fails loudly rather than landing in somebody
 * else's vault — but relying on the database to catch it means the bug exists in the
 * code and is only stopped at the last door. It is stamped here, and the policy is the
 * second lock.
 *
 * ─── NO tenant-WIDE READ EXISTS IN THIS FILE ────────────────────────────────
 * There is deliberately no "all owners" view, no admin listing, and no way to pass a
 * user id in. Every query below returns the caller's own rows because that is the only
 * shape the policies allow, and adding a parameter for whose vault to read would be the
 * first step towards a screen that leaks one director's net worth to another.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/supabase/database.types";

export type PersonalAccount = Database["public"]["Tables"]["personal_accounts"]["Row"];
export type PersonalTransaction = Database["public"]["Tables"]["personal_transactions"]["Row"];
export type PersonalHolding = Database["public"]["Tables"]["personal_holdings"]["Row"];

export type PersonalAccountInsert = Database["public"]["Tables"]["personal_accounts"]["Insert"];
export type PersonalTransactionInsert = Database["public"]["Tables"]["personal_transactions"]["Insert"];
export type PersonalHoldingInsert = Database["public"]["Tables"]["personal_holdings"]["Insert"];

/** Who is writing. Resolved from the session on every mutation — never cached in a prop. */
async function requireIdentity(): Promise<{ userId: string; tenantId: string }> {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("Aap logged in nahi ho — dobara login karo.");

  const { data: me, error } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!me?.tenant_id) throw new Error("Aapka workspace abhi load ho raha hai — ek pal ruk kar dobara try karo.");

  return { userId: auth.user.id, tenantId: me.tenant_id };
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ["personal-vault"] });
}

// ─── Accounts ────────────────────────────────────────────────────────────────

export function usePersonalAccounts(includeInactive = false) {
  return useQuery({
    queryKey: ["personal-vault", "accounts", includeInactive],
    queryFn: async (): Promise<PersonalAccount[]> => {
      const supabase = createClient();
      let q = supabase.from("personal_accounts").select("*").order("kind").order("label");
      if (!includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as PersonalAccount[];
    },
    staleTime: 30_000,
  });
}

export function useSavePersonalAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<PersonalAccountInsert, "tenant_id" | "owner_user_id"> & { id?: string }) => {
      const supabase = createClient();
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;

      if (id) {
        // No owner_user_id in the patch: an update must never be able to move a row
        // into another person's vault, and RLS would refuse it anyway.
        const { error } = await supabase
          .from("personal_accounts")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from("personal_accounts")
        .insert({ ...fields, tenant_id: tenantId, owner_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the account." }),
  });
}

export function useDeletePersonalAccount() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("personal_accounts").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the account." }),
  });
}

// ─── Transactions ────────────────────────────────────────────────────────────

export function usePersonalTransactions(limit = 200) {
  return useQuery({
    queryKey: ["personal-vault", "transactions", limit],
    queryFn: async (): Promise<PersonalTransaction[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("personal_transactions")
        .select("*")
        .order("occurred_on", { ascending: false })
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as PersonalTransaction[];
    },
    staleTime: 30_000,
  });
}

export function useSavePersonalTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<PersonalTransactionInsert, "tenant_id" | "owner_user_id"> & { id?: string }) => {
      const supabase = createClient();
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;

      if (id) {
        const { error } = await supabase
          .from("personal_transactions")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from("personal_transactions")
        .insert({ ...fields, tenant_id: tenantId, owner_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the entry." }),
  });
}

export function useDeletePersonalTransaction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("personal_transactions").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the entry." }),
  });
}

// ─── Holdings ────────────────────────────────────────────────────────────────

export function usePersonalHoldings() {
  return useQuery({
    queryKey: ["personal-vault", "holdings"],
    queryFn: async (): Promise<PersonalHolding[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("personal_holdings")
        .select("*")
        .order("current_value", { ascending: false });
      if (error) throw error;
      return (data ?? []) as PersonalHolding[];
    },
    staleTime: 30_000,
  });
}

export function useSavePersonalHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<PersonalHoldingInsert, "tenant_id" | "owner_user_id"> & { id?: string }) => {
      const supabase = createClient();
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;

      if (id) {
        const { error } = await supabase
          .from("personal_holdings")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from("personal_holdings")
        .insert({ ...fields, tenant_id: tenantId, owner_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the holding." }),
  });
}

export function useDeletePersonalHolding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("personal_holdings").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the holding." }),
  });
}

// ─── The PIN ─────────────────────────────────────────────────────────────────
//
// All of it goes through the API route: the hash and salt must never reach the browser,
// and the attempt counter is only meaningful if the server owns it. The client learns
// three things — whether a PIN is set, whether it is currently locked out, and whether
// the last guess was right.

export interface PinStatus {
  configured: boolean;
  locked: boolean;
  retryAfterSec: number;
  attemptsLeft: number;
}

export function usePinStatus() {
  return useQuery({
    queryKey: ["personal-vault", "pin-status"],
    queryFn: async (): Promise<PinStatus> => {
      const res = await fetch("/api/vault/personal/pin");
      if (!res.ok) throw new Error("PIN status load nahi hua");
      return (await res.json()) as PinStatus;
    },
    staleTime: 10_000,
  });
}

export function useSetPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { pin: string; currentPin?: string }) => {
      const res = await fetch("/api/vault/personal/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "set", ...args }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "PIN set nahi hua");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["personal-vault", "pin-status"] }),
  });
}

export function useRemovePin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (currentPin: string) => {
      const res = await fetch("/api/vault/personal/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "remove", currentPin }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "PIN hataya nahi ja saka");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["personal-vault", "pin-status"] }),
  });
}

export function useVerifyPin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pin: string): Promise<void> => {
      const res = await fetch("/api/vault/personal/pin", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "verify", pin }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(body.error || "PIN galat hai");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["personal-vault", "pin-status"] }),
  });
}
