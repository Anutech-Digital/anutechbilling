/**
 * R-1979 (26 Oct 2026, G-ADS): Meta Pixel + Conversions API — the pure rules, shared by the
 * browser pixel (site/lib/meta-pixel.tsx) and the server (capi.server.ts).
 *
 *   - Events: PageView, ViewContent, InitiateCheckout, AddPaymentInfo, Purchase.
 *   - Deduplication: the browser event and the server event of one action carry the SAME
 *     event_id (Purchase: "purchase-<quote id>"), so Meta counts it once.
 *   - user_data is hashed (SHA-256 of the normalised value) before it leaves our server —
 *     email lower-cased and trimmed, phone as digits with the 91 country code.
 *   - value is BEFORE GST, currency INR, content_ids = the plan.
 * Nothing here talks to the network.
 */
import { createHash } from "node:crypto";
import type { MetaEventName } from "./pixel-ids";
export { cleanPixelId, purchaseEventId, contentIdForPlan, type MetaEventName } from "./pixel-ids";

export function sha256(v: string): string {
  return createHash("sha256").update(v, "utf8").digest("hex");
}

/** Meta's normalisation for email: trimmed, lower case. Empty → null. */
export function normEmail(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim().toLowerCase();
  return s.includes("@") ? s : null;
}

/** Meta's normalisation for phone: digits only, with the country code (India 91 when 10 digits). */
export function normPhone(raw: string | null | undefined): string | null {
  let d = (raw ?? "").replace(/\D/g, "");
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = `91${d}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/** The fbc cookie value Meta expects, built from a click id when the browser cookie is absent. */
export function fbcFromFbclid(fbclid: string | null | undefined, clickTimeMs: number): string | null {
  const id = (fbclid ?? "").trim();
  return id ? `fb.1.${Math.floor(clickTimeMs)}.${id}` : null;
}

export interface CapiEventInput {
  eventName: MetaEventName;
  eventId: string;
  eventTimeMs: number;
  sourceUrl?: string | null;
  /** Before GST, rupees. */
  value?: number | null;
  contentIds?: string[];
  email?: string | null;
  phone?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  clientIp?: string | null;
  userAgent?: string | null;
}

/** One Conversions API request body (POST /{pixel-id}/events). */
export function buildCapiBody(e: CapiEventInput, testEventCode?: string | null) {
  const email = normEmail(e.email);
  const phone = normPhone(e.phone);
  const user_data: Record<string, unknown> = {};
  if (email) user_data.em = [sha256(email)];
  if (phone) user_data.ph = [sha256(phone)];
  if (e.fbp) user_data.fbp = e.fbp;
  if (e.fbc) user_data.fbc = e.fbc;
  if (e.clientIp) user_data.client_ip_address = e.clientIp;
  if (e.userAgent) user_data.client_user_agent = e.userAgent;
  const custom_data: Record<string, unknown> = {};
  if (e.value != null) { custom_data.value = Math.round(e.value * 100) / 100; custom_data.currency = "INR"; }
  if (e.contentIds?.length) { custom_data.content_ids = e.contentIds; custom_data.content_type = "product"; }
  return {
    data: [{
      event_name: e.eventName,
      event_time: Math.floor(e.eventTimeMs / 1000),
      event_id: e.eventId,
      action_source: "website",
      ...(e.sourceUrl ? { event_source_url: e.sourceUrl } : {}),
      user_data,
      ...(Object.keys(custom_data).length ? { custom_data } : {}),
    }],
    ...(testEventCode ? { test_event_code: testEventCode } : {}),
  };
}
