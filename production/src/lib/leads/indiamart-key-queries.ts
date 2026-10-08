/**
 * S34 — browser side of /api/leads/indiamart, for /marketing/indiamart.
 *
 * Lives beside the rest of the IndiaMART code (lib/leads) rather than in the shared
 * lib/queries folder. The key goes out in exactly one request body (POST) and is never put
 * in a query key, a URL, a toast or a console line; nothing here reads it back.
 */
"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { toastError } from "@/lib/errors/toast-error";
import { saveKeyFailure, type IndiamartKeyStatus } from "./indiamart-key";

export const INDIAMART_KEY_QUERY = ["leads", "indiamart-key"] as const;

/** Error carrying the HTTP status, so the page can tell "not the owner" from "server broke". */
export class IndiamartApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function call<T>(method: "GET" | "POST" | "DELETE", body?: unknown): Promise<T> {
  const res = await fetch("/api/leads/indiamart", {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json?.ok === false) {
    throw new IndiamartApiError(typeof json?.error === "string" ? json.error : "No response from server — refresh and try again.", res.status);
  }
  return json as T;
}

export function useIndiamartKeyStatus() {
  return useQuery({
    queryKey: INDIAMART_KEY_QUERY,
    queryFn: () => call<IndiamartKeyStatus>("GET"),
    // A 403 (not the owner) will not turn into a 200 by asking again.
    retry: (n, e) => !(e instanceof IndiamartApiError && e.status < 500) && n < 2,
  });
}

export function useSaveIndiamartKey() {
  const qc = useQueryClient();
  return useMutation({
    /* R-399: since R-051 a save is either sealed or refused (503, vault missing) — there is
       no plaintext-save outcome to report. */
    mutationFn: (crmKey: string) => call<{ encrypted: true }>("POST", { crm_key: crmKey }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INDIAMART_KEY_QUERY });
      toast.success("Key saved", { description: "Encrypted before it was stored." });
    },
    onError: (e) => {
      if (e instanceof IndiamartApiError) {
        const f = saveKeyFailure(e.status, e.message);
        if (f.vaultMissing) { toast.error(f.title, { description: f.description }); return; }
      }
      toastError(e, { description: saveKeyFailure(0, "").description });
    },
  });
}

export function useRemoveIndiamartKey() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => call<Record<string, never>>("DELETE"),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: INDIAMART_KEY_QUERY });
      toast.success("Key removed", { description: "No new pulls. Existing leads stay as they are." });
    },
    onError: (e) => toastError(e, { description: "Key is still saved. Refresh and try again." }),
  });
}
