/**
 * WhatsApp marketing — templates, opt-outs, broadcasts (migration 20260926230000).
 * Rules (slots, STOP, phone shape) are in lib/marketing/whatsapp-broadcast.ts; sending is
 * server-side in /api/marketing/whatsapp/broadcast.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { createClient } from "@/lib/supabase/client";
import { requireTenantId } from "@/lib/queries/require-tenant";

/* Tables newer than the generated types (database.types.ts is shared, kept minimal). */
const db = () => createClient() as unknown as { from: (t: string) => any };  // eslint-disable-line @typescript-eslint/no-explicit-any

const TPL = ["wa-templates"] as const;
const OPT = ["wa-opt-outs"] as const;
const BC = ["wa-broadcasts"] as const;

export type WaStatus = "draft" | "submitted" | "approved" | "rejected" | "paused";
export interface WaTemplate {
  id: string; name: string; language: string; category: "MARKETING" | "UTILITY";
  body: string; param_map: string[]; status: WaStatus; notes: string | null; updated_at: string;
}

export function useWaTemplates() {
  return useQuery({
    queryKey: TPL,
    queryFn: async (): Promise<WaTemplate[]> => {
      const { data, error } = await db().from("whatsapp_templates")
        .select("id, name, language, category, body, param_map, status, notes, updated_at").order("name");
      if (error) throw error;
      return (data ?? []) as WaTemplate[];
    },
  });
}

export function useSaveWaTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...t }: Omit<WaTemplate, "id" | "updated_at" | "notes"> & { id?: string; notes?: string | null }) => {
      if (id) {
        const { error } = await db().from("whatsapp_templates").update({ ...t, updated_at: new Date().toISOString() }).eq("id", id);
        if (error) throw error;
        return;
      }
      const supabase = createClient();
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const { error } = await db().from("whatsapp_templates").insert({ ...t, tenant_id: tenantId, created_by: auth?.user?.id ?? null });
      if (error) throw error;
    },
    onSuccess: (_d, v) => { qc.invalidateQueries({ queryKey: TPL }); toast.success(v.id ? "Template updated" : "Template saved"); },
    onError: (err) => toastError(err),
  });
}

export function useDeleteWaTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await db().from("whatsapp_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: TPL }); toast.success("Template deleted"); },
    onError: (err) => toastError(err),
  });
}

export function useSyncWaTemplates() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const res = await fetch("/api/marketing/whatsapp/templates/sync", { method: "POST" });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(j.error ?? "Sync failed");
      return j as { found: number; updated: number; added: number };
    },
    onSuccess: (j) => { qc.invalidateQueries({ queryKey: TPL }); toast.success(`Meta se ${j.found} templates — ${j.updated} update, ${j.added} naye`); },
    onError: (err) => toastError(err),
  });
}

export interface WaOptOut { phone: string; reason: "stop" | "manual"; created_at: string }

export function useWaOptOuts() {
  return useQuery({
    queryKey: OPT,
    queryFn: async (): Promise<WaOptOut[]> => {
      const { data, error } = await db().from("whatsapp_opt_outs").select("phone, reason, created_at").order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as WaOptOut[];
    },
  });
}

export function useAddWaOptOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phone: string) => {
      const tenantId = await requireTenantId(createClient());
      const { error } = await db().from("whatsapp_opt_outs").upsert(
        { tenant_id: tenantId, phone, reason: "manual" }, { onConflict: "tenant_id,phone", ignoreDuplicates: true });
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: OPT }); toast.success("Number added to the opt-out list"); },
    onError: (err) => toastError(err),
  });
}

export function useRemoveWaOptOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phone: string) => {
      const { error } = await db().from("whatsapp_opt_outs").delete().eq("phone", phone);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: OPT }); toast.success("Opt-out removed"); },
    onError: (err) => toastError(err),
  });
}

export interface WaBroadcast {
  id: string; template_name: string; recipients_count: number; sent_count: number;
  failed_count: number; skipped_count: number; status: string; created_at: string;
}

export function useWaBroadcasts() {
  return useQuery({
    queryKey: BC,
    queryFn: async (): Promise<WaBroadcast[]> => {
      const { data, error } = await db().from("whatsapp_broadcasts")
        .select("id, template_name, recipients_count, sent_count, failed_count, skipped_count, status, created_at")
        .order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return (data ?? []) as WaBroadcast[];
    },
  });
}

export interface BroadcastInput { templateId: string; audience: { stages?: string[]; sources?: string[] } }
export interface BroadcastPreview { recipients: number; overCap: number; skippedOptOut: number; noPhone: number; sample: string | null; connected: boolean }

async function post<T>(body: unknown): Promise<T> {
  const res = await fetch("/api/marketing/whatsapp/broadcast", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? "Broadcast failed");
  return j as T;
}

export function useBroadcastPreview() {
  return useMutation({
    mutationFn: (v: BroadcastInput) => post<BroadcastPreview>({ ...v, dryRun: true }),
    onError: (err) => toastError(err),
  });
}

export function useSendBroadcast() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (v: BroadcastInput) => post<{ sent: number; failed: number; skippedOptOut: number; recipients: number }>(v),
    onSuccess: (j) => {
      qc.invalidateQueries({ queryKey: BC });
      toast.success(`${j.sent}/${j.recipients} sent${j.failed ? ` · ${j.failed} failed` : ""}${j.skippedOptOut ? ` · ${j.skippedOptOut} opted-out skipped` : ""}`);
    },
    onError: (err) => toastError(err),
  });
}
