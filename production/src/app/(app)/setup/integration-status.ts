/**
 * R-260 — integration status for the setup wizard, read from the SAME GETs and
 * query keys the Settings → Integrations cards use, so both screens always agree
 * (and share one cache). A failed GET resolves to null ("unknown"), never "not set up".
 */
"use client";

import { useQuery } from "@tanstack/react-query";
import type { GoogleResellerProbe, RazorpayProbe, WhatsAppProbe } from "./done-checklist";

async function getJsonOrNull<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export function useRazorpayStatus() {
  return useQuery({
    queryKey: ["integrations", "razorpay"],
    queryFn: () => getJsonOrNull<RazorpayProbe>("/api/integrations/razorpay"),
  });
}

export function useWhatsAppStatus() {
  return useQuery({
    queryKey: ["integrations", "whatsapp"],
    queryFn: () => getJsonOrNull<WhatsAppProbe>("/api/integrations/whatsapp"),
  });
}

/** Same shape as Settings' GoogleResellerIntegrationCard: a 403 still carries a useful `code`. */
export function useGoogleResellerStatus() {
  return useQuery({
    queryKey: ["integrations", "google-reseller"],
    queryFn: async (): Promise<GoogleResellerProbe & { ok: boolean }> => {
      const res = await fetch("/api/integrations/google-reseller/subscriptions?probe=1");
      const body = await res.json().catch(() => ({}));
      return { ok: res.ok, code: body?.code as string | undefined, connected: Boolean(body?.connected) };
    },
    staleTime: 60_000,
  });
}
