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

export type PersonalImportBatch = Database["public"]["Tables"]["personal_import_batches"]["Row"];
export type PersonalCategory = Database["public"]["Tables"]["personal_categories"]["Row"];
export type PersonalCategoryInsert = Database["public"]["Tables"]["personal_categories"]["Insert"];
export type PersonalCategoryRule = Database["public"]["Tables"]["personal_category_rules"]["Row"];
export type PersonalCategoryRuleInsert = Database["public"]["Tables"]["personal_category_rules"]["Insert"];

/** Who is writing. Resolved from the session on every mutation — never cached in a prop. */
async function requireIdentity(): Promise<{ userId: string; tenantId: string }> {
  const supabase = createClient();
  const { data: auth } = await supabase.auth.getUser();
  if (!auth.user) throw new Error("You are not signed in — please sign in again.");

  const { data: me, error } = await supabase
    .from("users")
    .select("tenant_id")
    .eq("id", auth.user.id)
    .maybeSingle();
  if (error) throw error;
  if (!me?.tenant_id) throw new Error("Your workspace is still loading — wait a moment and try again.");

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

// ─── Statement import (R-2128, migration 20261030074413) ──────────────────────
//
// The commit goes through ONE RPC, personal_import_commit: the batch row and every line
// land together or not at all, and a line already imported (same dedupe_hash in that
// account) is skipped, so uploading an overlapping statement never doubles the money.
// The RPC is SECURITY INVOKER and stamps owner/tenant from the session itself — nothing
// here sends a user id.

/** One statement line as the importer hands it over. Amount is whole rupees, always > 0. */
export interface PersonalImportLine {
  kind: PersonalTransaction["kind"];
  amount: number;
  /** YYYY-MM-DD */
  occurred_on: string;
  dedupe_hash: string;
  category?: string | null;
  note?: string | null;
  reference?: string | null;
  raw_description?: string | null;
  balance_after?: number | null;
}

export interface PersonalImportBatchInput {
  account_id: string;
  file_name?: string | null;
  file_kind?: "csv" | "xlsx" | "other" | null;
  statement_from?: string | null;
  statement_to?: string | null;
  rows: PersonalImportLine[];
}

export interface PersonalImportResult {
  /** null when every line was already imported (no empty upload is kept). */
  batch_id: string | null;
  inserted: number;
  skipped: number;
  rows: number;
}

export function usePersonalImportBatches(limit = 50) {
  return useQuery({
    queryKey: ["personal-vault", "import-batches", limit],
    queryFn: async (): Promise<PersonalImportBatch[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("personal_import_batches")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return (data ?? []) as PersonalImportBatch[];
    },
    staleTime: 30_000,
  });
}

export function useCommitPersonalImport() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (batch: PersonalImportBatchInput): Promise<PersonalImportResult> => {
      const supabase = createClient();
      // Signed-in check only; the RPC takes owner and tenant from the session, not from us.
      await requireIdentity();
      const { data, error } = await supabase.rpc("personal_import_commit", {
        batch: batch as unknown as Database["public"]["Functions"]["personal_import_commit"]["Args"]["batch"],
      });
      if (error) throw error;
      return data as unknown as PersonalImportResult;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not import the statement." }),
  });
}

// ─── Own categories and private auto-category rules (R-2128) ─────────────────

export function usePersonalCategories(includeInactive = false) {
  return useQuery({
    queryKey: ["personal-vault", "categories", includeInactive],
    queryFn: async (): Promise<PersonalCategory[]> => {
      const supabase = createClient();
      let q = supabase.from("personal_categories").select("*").order("direction").order("name");
      if (!includeInactive) q = q.eq("is_active", true);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as PersonalCategory[];
    },
    staleTime: 60_000,
  });
}

export function useSavePersonalCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<PersonalCategoryInsert, "tenant_id" | "owner_user_id"> & { id?: string }) => {
      const supabase = createClient();
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;

      if (id) {
        const { error } = await supabase
          .from("personal_categories")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from("personal_categories")
        .insert({ ...fields, tenant_id: tenantId, owner_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the category." }),
  });
}

export function useDeletePersonalCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("personal_categories").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the category." }),
  });
}

export function usePersonalCategoryRules() {
  return useQuery({
    queryKey: ["personal-vault", "category-rules"],
    queryFn: async (): Promise<PersonalCategoryRule[]> => {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("personal_category_rules")
        .select("*")
        .order("match_text");
      if (error) throw error;
      return (data ?? []) as PersonalCategoryRule[];
    },
    staleTime: 60_000,
  });
}

/** "Always put <match_text> under <category>". One rule per text per person (DB unique). */
export function useSavePersonalCategoryRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: Omit<PersonalCategoryRuleInsert, "tenant_id" | "owner_user_id"> & { id?: string }) => {
      const supabase = createClient();
      const { userId, tenantId } = await requireIdentity();
      const { id, ...fields } = input;

      if (id) {
        const { error } = await supabase
          .from("personal_category_rules")
          .update({ ...fields, updated_at: new Date().toISOString() })
          .eq("id", id);
        if (error) throw error;
        return;
      }

      const { error } = await supabase
        .from("personal_category_rules")
        .insert({ ...fields, tenant_id: tenantId, owner_user_id: userId });
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not save the rule." }),
  });
}

export function useDeletePersonalCategoryRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const supabase = createClient();
      const { error } = await supabase.from("personal_category_rules").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => invalidateAll(qc),
    onError: (e: unknown) => toastError(e, { fallback: "Could not delete the rule." }),
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
      if (!res.ok) throw new Error("Could not load PIN status");
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
      if (!res.ok) throw new Error(body.error || "Could not set the PIN");
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
      if (!res.ok) throw new Error(body.error || "Could not remove the PIN");
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
      if (!res.ok) throw new Error(body.error || "Wrong PIN");
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["personal-vault", "pin-status"] }),
  });
}
