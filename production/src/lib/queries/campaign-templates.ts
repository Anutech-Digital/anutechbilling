/**
 * Email campaign templates — the list behind the composer's "Start from a template" and the
 * management page (/marketing/templates).
 *
 * System templates (is_system, tenant_id NULL — seeded by migration 20260926200000) are
 * read-only for everyone; RLS (ctmpl_update / ctmpl_delete) enforces it. A company edits one
 * by copying it into its own templates.
 */
"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";

import { createClient } from "@/lib/supabase/client";
import { requireTenantId } from "@/lib/queries/require-tenant";
import { useCurrentUser } from "@/lib/hooks/useCurrentUser";
import type { CampaignTemplateRow, CampaignTemplateCategory } from "@/lib/supabase/database.types";

export const TEMPLATES_KEY = ["campaign_templates"] as const;

export const TEMPLATE_CATEGORIES: { value: CampaignTemplateCategory; label: string }[] = [
  { value: "onboarding", label: "Introduction / onboarding" },
  { value: "offer",      label: "Offer / discount" },
  { value: "winback",    label: "Win-back" },
  { value: "newsletter", label: "Newsletter" },
  { value: "custom",     label: "Other" },
];

export function useCampaignTemplates() {
  return useQuery({
    queryKey: TEMPLATES_KEY,
    queryFn: async (): Promise<CampaignTemplateRow[]> => {
      const { data, error } = await createClient()
        .from("campaign_templates")
        .select("*")
        .order("is_system", { ascending: false })
        .order("name");
      if (error) throw error;
      return (data ?? []) as CampaignTemplateRow[];
    },
  });
}

export interface TemplateInput {
  name: string;
  category: CampaignTemplateCategory;
  subject: string;
  body_html: string;
  body_text: string | null;
  description: string | null;
}

function newId(): string {
  return `TPL-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/** Create (no id) or update (id) one of this company's templates. */
export function useSaveTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: TemplateInput & { id?: string }) => {
      const supabase = createClient();
      if (id) {
        const { error } = await supabase.from("campaign_templates")
          .update({ ...input, updated_at: new Date().toISOString() } as never)
          .eq("id", id);
        if (error) throw error;
        return id;
      }
      const tenantId = await requireTenantId(supabase);
      const { data: auth } = await supabase.auth.getUser();
      const nid = newId();
      const { error } = await supabase.from("campaign_templates").insert({
        id: nid, tenant_id: tenantId, is_system: false, created_by: auth?.user?.id ?? null, ...input,
      });
      if (error) throw error;
      return nid;
    },
    onSuccess: (_id, v) => {
      qc.invalidateQueries({ queryKey: TEMPLATES_KEY });
      toast.success(v.id ? "Template updated" : "Template saved");
    },
    onError: (err) => toastError(err),
  });
}

export function useDeleteTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await createClient().from("campaign_templates").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: TEMPLATES_KEY }); toast.success("Template deleted"); },
    onError: (err) => toastError(err),
  });
}

/**
 * The `{{sender}}` a preview shows: the logged-in company's own name (R-1924), the same
 * tenants.name /api/campaigns/send signs with. Never another company's name.
 */
export function usePreviewSender(): string {
  const { data: me } = useCurrentUser();
  return me?.tenantName?.trim() || "Your company";
}

/** Fill the variables with sample values, the same set /api/campaigns/send fills. */
export function previewTemplate(html: string, sender: string): string {
  return html
    .replace(/\{\{name\}\}/g, "Ramesh")
    .replace(/\{\{company\}\}/g, "Acme Pvt Ltd")
    .replace(/\{\{sender\}\}/g, sender)
    .replace(/\{\{offer_code\}\}/g, "DIWALI20")
    .replace(/\{\{discount\}\}/g, "20")
    .replace(/\{\{expires\}\}/g, "31 Oct 2026");
}

/** Variables used in a template that the send route will NOT fill — they would go out raw. */
export function unknownVariables(...parts: (string | null | undefined)[]): string[] {
  const known = new Set(["name", "company", "sender", "offer_code", "discount", "expires", "pitch"]);
  const found = new Set<string>();
  for (const p of parts) for (const m of (p ?? "").matchAll(/\{\{(\w+)\}\}/g)) if (!known.has(m[1])) found.add(m[1]);
  return [...found];
}
