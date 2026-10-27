/**
 * R-2020 (R-2019 goal 9, Pardeep 27 Oct): the phone buy funnel — intent_selected → plan_selected →
 * step_viewed(step) → checkout_started (→ payment_success / payment_failed, R-2021) — so drop-off
 * per step can be seen later. Consent-gated like the Meta events: nothing is recorded unless the
 * visitor chose "Accept all" on the consent banner. Events go to window.dataLayer (the page's own
 * array; no third-party script is loaded here). No personal data — plan, licences, billing, step.
 */
import { readConsent } from "@/site/lib/consent";

export type FunnelEvent = "intent_selected" | "plan_selected" | "step_viewed" | "checkout_started" | "payment_success" | "payment_failed";

declare global { interface Window { dataLayer?: unknown[] } }

export function trackFunnel(event: FunnelEvent, props: Record<string, string | number> = {}): boolean {
  if (typeof window === "undefined" || readConsent() !== "all") return false;
  window.dataLayer = window.dataLayer ?? [];
  window.dataLayer.push({ event: `buy_ws_${event}`, ...props });
  return true;
}
