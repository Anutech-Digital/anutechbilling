"use client";
/**
 * R-1979 (26 Oct 2026, G-ADS): the Meta Pixel in the browser.
 *
 *   - NO pixel id → renders nothing, loads nothing.
 *   - Loads only for a visitor who chose "Accept all" on the site's cookie banner
 *     (localStorage "anutech.consent.v1" = "all"); "Essential only" or no choice → nothing.
 *   - PageView on load; trackMeta() sends ViewContent / InitiateCheckout / AddPaymentInfo /
 *     Purchase with an eventID, so the server's Conversions API event of the same action is
 *     deduplicated by Meta (lib/meta/pixel-ids.ts purchaseEventId).
 *   - R-2010: follows the choice LIVE (site/lib/consent.ts): "Accept all" in the banner loads it
 *     at once; "Only necessary" from Cookie settings tells Meta to revoke and sends nothing more.
 */
import * as React from "react";
import { cleanPixelId, type MetaEventName } from "@/lib/meta/pixel-ids";
import { CONSENT_KEY, onConsentChange } from "@/site/lib/consent";

export { CONSENT_KEY };
const SCRIPT_SRC = "https://connect.facebook.net/en_US/fbevents.js";

type Fbq = ((...args: unknown[]) => void) & { queue?: unknown[][]; loaded?: boolean; version?: string; push?: unknown; callMethod?: (...a: unknown[]) => void };
declare global { interface Window { fbq?: Fbq; _fbq?: Fbq } }

/** Did the visitor accept analytics cookies? Unreadable storage counts as no. */
export function metaConsent(): boolean {
  try { return typeof window !== "undefined" && window.localStorage.getItem(CONSENT_KEY) === "all"; } catch { return false; }
}

/** The _fbp cookie Meta's script sets (for the server event's user_data), or null. */
export function fbpCookie(): string | null {
  if (typeof document === "undefined") return null;
  const m = /(?:^|;\s*)_fbp=([^;]+)/.exec(document.cookie);
  return m ? decodeURIComponent(m[1]) : null;
}

/** R-2010: on withdrawal, remove the _fbp cookie Meta's script set on this site. */
function dropFbpCookie(): void {
  try {
    const host = window.location.hostname;
    const parts = host.split(".");
    const domains = ["", host, "." + (parts.length > 2 ? parts.slice(-2).join(".") : host)];
    for (const d of domains) document.cookie = `_fbp=; Max-Age=0; path=/${d ? `; domain=${d}` : ""}`;
  } catch { /* ignore */ }
}

/** Install the fbq queue + script once (Meta's base code, without inline script). */
function installFbq(pixelId: string): void {
  if (window.fbq) return;
  const fbq: Fbq = function (...args: unknown[]) {
    if (fbq.callMethod) fbq.callMethod(...args); else (fbq.queue as unknown[][]).push(args);
  } as Fbq;
  fbq.queue = [];
  fbq.loaded = true;
  fbq.version = "2.0";
  fbq.push = fbq;
  window.fbq = fbq;
  window._fbq = fbq;
  const s = document.createElement("script");
  s.async = true;
  s.src = SCRIPT_SRC;
  document.head.appendChild(s);
  fbq("init", pixelId);
}

/** Send a browser event — nothing when the pixel is not loaded (no id, no consent). */
export function trackMeta(event: MetaEventName, params?: Record<string, unknown>, eventId?: string): void {
  /* R-2010: a visitor who withdrew keeps Meta's script in memory until the next page — so the
     choice is checked on EVERY event, not only when the script loads. */
  if (typeof window === "undefined" || !window.fbq || !metaConsent()) return;
  try {
    window.fbq("track", event, params ?? {}, eventId ? { eventID: eventId } : undefined);
  } catch { /* an ad script must never break the page */ }
}

export function MetaPixel({ pixelId }: { pixelId: string | null | undefined }) {
  const id = cleanPixelId(pixelId);
  React.useEffect(() => {
    if (!id) return;
    if (metaConsent()) { installFbq(id); trackMeta("PageView"); }
    return onConsentChange((choice) => {
      if (choice === "all") {
        if (window.fbq) { try { window.fbq("consent", "grant"); } catch { /* ignore */ } }
        else installFbq(id);
        trackMeta("PageView");
      } else if (window.fbq) {
        try { window.fbq("consent", "revoke"); } catch { /* ignore */ }
        dropFbpCookie();
      }
    });
  }, [id]);
  return null;
}
