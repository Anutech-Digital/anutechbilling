/**
 * Inbound emails — the Enquiries Inbox data layer.
 *
 * Fetches tenant-scoped inbound emails via server endpoint /api/inbound-emails
 * and handles atomic lead conversion.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import type { InboundEmailRow } from "@/lib/supabase/database.types";

export function useInboundEmails() {
  return useQuery({
    queryKey: ["inbound-emails"],
    queryFn: async (): Promise<InboundEmailRow[]> => {
      const res = await fetch("/api/inbound-emails");
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not fetch inbound emails");
      }
      return res.json();
    },
  });
}

export function useConvertInboundToLead() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (id: string): Promise<string> => {
      const res = await fetch(`/api/inbound-emails/${id}/convert`, { method: "POST" });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Could not convert email to lead");
      }
      const data = await res.json();
      return data.leadId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["inbound-emails"] });
      qc.invalidateQueries({ queryKey: ["leads"] });
      qc.invalidateQueries({ queryKey: ["nav-badges"] });
      toast.success("Lead created from email");
    },
    onError: (err) => toast.error((err as Error).message),
  });
}
