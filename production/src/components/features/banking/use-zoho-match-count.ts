/**
 * R-2360 — the Banking "Zoho has a match" set for one bank account.
 *
 * One POST to /api/integrations/zoho-books/payment-matches per account (it reads Zoho ONCE for the
 * account's unmatched money-in window and caches it 30 min on the server); kept here for 30 min
 * too, never refetched on focus. An answer that is not ok (Zoho not connected, not an owner /
 * accountant, Zoho busy) → `available: false` and the page shows no Zoho filter at all.
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { ZohoMatchCount } from "@/lib/integrations/zoho-books/payment-batch";

export const ZOHO_MATCHES_URL = "/api/integrations/zoho-books/payment-matches";
const STALE_MS = 30 * 60_000;

export type ZohoMatchSet = { available: true; ids: ReadonlySet<string>; count: ZohoMatchCount } | { available: false; reason: string | null };

export async function fetchZohoMatchSet(accountId: string, post: typeof fetch = fetch): Promise<ZohoMatchSet> {
  const res = await post(ZOHO_MATCHES_URL, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ accountId }),
  });
  const body = (await res.json().catch(() => null)) as
    | { ok: true; result: ZohoMatchCount }
    | { ok: false; code?: string; error?: string }
    | null;
  if (!body || !body.ok) return { available: false, reason: body && !body.ok ? body.code ?? null : null };
  return { available: true, ids: new Set(body.result.txnIds), count: body.result };
}

/** `enabled`: only for someone who can reconcile, on an account with unmatched money-in lines. */
export function useZohoMatchSet(accountId: string | null, enabled: boolean) {
  return useQuery({
    queryKey: ["zoho_payment_matches", accountId] as const,
    enabled: enabled && Boolean(accountId),
    queryFn: () => fetchZohoMatchSet(accountId!),
    staleTime: STALE_MS,
    gcTime: STALE_MS,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
}
