/**
 * R-2449 — React Query edge for Purchases → Inbox "From network". The calls themselves are
 * lib/network/documents.ts (R-2434) — this file only caches them and refreshes what an answer
 * changes (the inbox, bills, vendors).
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";
import {
  listNetworkInbox, acceptNetworkDocument, rejectNetworkDocument, undoNetworkAccept,
} from "@/lib/network/documents";

export const NETWORK_INBOX_KEY = ["network-inbox"] as const;

/** Every copy my connected sellers sent me (the database scopes it to my company and role). */
export function useNetworkInbox(enabled: boolean) {
  return useQuery({ queryKey: NETWORK_INBOX_KEY, queryFn: () => listNetworkInbox(), enabled });
}

function useAfterAnswer() {
  const qc = useQueryClient();
  return () => Promise.all([
    qc.invalidateQueries({ queryKey: NETWORK_INBOX_KEY }),
    qc.invalidateQueries({ queryKey: ["vendor_bills"] }),
    qc.invalidateQueries({ queryKey: ["vendors"] }),
  ]);
}

export function useAcceptNetworkDocument() {
  const after = useAfterAnswer();
  return useMutation({
    mutationFn: (v: { id: string; category: string | null }) => acceptNetworkDocument(v.id, v.category),
    onSuccess: after,
  });
}

export function useRejectNetworkDocument() {
  const after = useAfterAnswer();
  return useMutation({
    mutationFn: (v: { id: string; reason: string }) => rejectNetworkDocument(v.id, v.reason),
    onSuccess: after,
  });
}

export function useUndoNetworkAccept() {
  const after = useAfterAnswer();
  return useMutation({ mutationFn: (id: string) => undoNetworkAccept(id), onSuccess: after });
}

/** The default category of my vendor with this GSTIN (the one Accept would use), or null.
 *  Case-insensitive like ensureVendor's findByGstin (the database matches upper(btrim(gstin))). */
export function useVendorDefaultCategory(gstin: string | null) {
  return useQuery({
    queryKey: ["vendors", "default-category", gstin],
    enabled: !!gstin,
    queryFn: async (): Promise<string | null> => {
      const { data, error } = await createClient()
        .from("vendors").select("default_category").ilike("gstin", gstin!.trim()).order("created_at").limit(1);
      if (error) throw error;
      return (data?.[0]?.default_category as string | null | undefined) ?? null;
    },
  });
}
