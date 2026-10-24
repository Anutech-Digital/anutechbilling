/**
 * S28 — WhatsApp renewal / invoice reminders settings (/marketing/whatsapp/reminders).
 * Everything goes through /api/marketing/whatsapp/reminders (owner / manager only); rules
 * are in lib/marketing/whatsapp-reminders(-settings).ts.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import type { AutonomyMode } from "@/lib/ai/autonomy";
import type { ReminderKind, ReminderParamField, ReminderSubject } from "@/lib/marketing/whatsapp-reminders";
import type { KindReadiness, KnownTemplate } from "@/lib/marketing/whatsapp-reminders-settings";

const KEY = ["wa-reminders"] as const;
const ENDPOINT = "/api/marketing/whatsapp/reminders";

export interface ReminderKindView {
  kind: ReminderKind;
  label: string;
  subject: ReminderSubject;
  dialMode: AutonomyMode;
  mapping: { template_name: string; language: string; param_map: ReminderParamField[]; enabled: boolean; updated_at: string } | null;
  templateStatus: string | null;
  readiness: KindReadiness;
}

export interface ReminderLogView {
  id: string; kind: string; subject_type: string; subject_id: string; step: string;
  phone: string | null; template_name: string | null; status: string;
  skip_reason: string | null; error_message: string | null;
  sent_at: string | null; delivered_at: string | null; read_at: string | null; failed_at: string | null;
  created_at: string;
}

export interface WaRemindersView {
  enabled: boolean;
  updatedAt: string | null;
  connected: boolean;
  dial: { killSwitch: boolean; renewal: AutonomyMode; dunning: AutonomyMode };
  kinds: ReminderKindView[];
  templates: KnownTemplate[];
  log: ReminderLogView[];
}

async function call<T>(method: string, body?: unknown): Promise<T> {
  const res = await fetch(ENDPOINT, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error ?? "WhatsApp reminders action failed — refresh the page and try again.");
  return j as T;
}

export function useWaReminders() {
  return useQuery({ queryKey: KEY, queryFn: () => call<WaRemindersView>("GET") });
}

export function useSetWaRemindersEnabled() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => call<{ enabled: boolean }>("PATCH", { enabled }),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: KEY });
      toast.success(r.enabled ? "WhatsApp reminders ON" : "WhatsApp reminders OFF — no reminder will go on WhatsApp now");
    },
    onError: (err) => toastError(err),
  });
}

export interface ReminderMappingInput {
  kind: ReminderKind; template_name: string; language: string; param_map: ReminderParamField[]; enabled: boolean;
}

export function useSaveReminderMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (m: ReminderMappingInput) => call<{ kind: string }>("PUT", m),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("Template set"); },
    onError: (err) => toastError(err),
  });
}

export function useDeleteReminderMapping() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: ReminderKind) => call<{ kind: string }>("DELETE", { kind }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: KEY }); toast.success("Template removed — no WhatsApp will go for this kind"); },
    onError: (err) => toastError(err),
  });
}
