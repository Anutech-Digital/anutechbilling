/**
 * Tenant — TanStack Query mutation hook for updating the current
 * reseller's identity (GSTIN, address, contact details, etc.).
 *
 * RLS policy `tenants_self_update` already restricts UPDATE to the
 * authenticated user's own tenant AND requires role='owner'. The
 * client just needs to call .update() — the policy enforces both.
 */
"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { createClient } from "@/lib/supabase/client";
import { shrinkLogo } from "@/lib/images/shrink-logo";
import type { Database } from "@/lib/supabase/database.types";
import { companyGstinStateConflict } from "@/lib/gst/gstin-state";

type TenantUpdate = Database["public"]["Tables"]["tenants"]["Update"];

export function useUpdateTenant() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (patch: TenantUpdate) => {
      /* R-1128: last line before the write, for every screen that uses this hook (Settings and
         the setup wizard check first and show the fix; this catches any caller that does not). */
      const conflict = companyGstinStateConflict(patch.state_code, patch.gstin);
      if (conflict) throw new Error(conflict.message);

      const supabase = createClient();

      // Resolve current tenant_id (RLS will further enforce ownership)
      const { data: authData } = await supabase.auth.getUser();
      if (!authData?.user) throw new Error("Not authenticated");

      const { data: me, error: meErr } = await supabase
        .from("users")
        .select("tenant_id")
        .eq("id", authData.user.id)
        .single();
      if (meErr || !me) throw new Error("User not linked to a tenant");

      const { data, error } = await supabase
        .from("tenants")
        .update(patch)
        .eq("id", me.tenant_id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      // useCurrentUser caches tenant — refresh it so the new values appear in
      // Sidebar / TopBar / PDFs / dashboard greeting immediately.
      qc.invalidateQueries({ queryKey: ["current-user"] });
      toast.success("Company info updated");
    },
    onError: (err) => toast.error(`Update failed: ${(err as Error).message}`),
  });
}

/**
 * Upload / change the company logo. Puts the image in the PUBLIC `logos`
 * bucket (tenant-foldered), then saves its public URL on the tenant row.
 * Pass null to remove the logo.
 */
export function useSetTenantLogo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (file: File | null) => {
      // Server-side upload (admin client) — avoids browser→storage RLS quirks.
      const form = new FormData();
      /* Shrink BEFORE upload, not after. Two reasons, both measured 31 Aug 2026: a 940 KB
         logo made every emailed quote PDF 938 KB against 4.5 KB without one, and the upload
         route accepts webp/svg which the PDF renderer cannot draw at all — so an SVG logo
         silently produced a monogram forever, with nothing on screen to say why. Re-encoding
         to PNG fixes both, and shrinkLogo returns the ORIGINAL file on any failure, so it can
         never turn a working upload into a broken one. */
      const sent = file ? await shrinkLogo(file) : null;
      if (sent) form.append("file", sent);
      const res = await fetch("/api/settings/logo", { method: "POST", body: form });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json?.error ?? "Upload failed");
      /* Returned so the toast can SAY it happened. Resizing a file somebody chose is the kind
         of silent helpfulness that reads as a bug the day it goes wrong — and the owner is
         the one person who would notice their logo looking soft. */
      return file && sent && sent.size < file.size
        ? { from: file.size, to: sent.size }
        : null;
    },
    onSuccess: (shrunk, file) => {
      qc.invalidateQueries({ queryKey: ["current-user"] });
      const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
      toast.success(
        !file ? "Logo removed"
          : shrunk ? `Logo updated — resized ${kb(shrunk.from)} → ${kb(shrunk.to)}`
          : "Logo updated",
      );
    },
    onError: (err) => toast.error(`Logo update failed: ${(err as Error).message}`),
  });
}
