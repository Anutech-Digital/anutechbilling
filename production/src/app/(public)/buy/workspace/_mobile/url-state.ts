/**
 * R-2020 (R-2019a, 27 Oct 2026): the phone flow keeps every choice in the address bar —
 * ?step=&intent=&tier=&seats=&billing= — so a refresh, the Back button or an ad's deep link
 * lands on the same screen with the same choices. Every OTHER parameter (utm_*, fbclid, gclid,
 * coupon …, R-1978) is left exactly as it was: only these five keys are ever written.
 * Anything unexpected in a link is ignored, never trusted.
 *
 * R-2021 (R-2019b): the phone checkout's three steps — domain, details, review — are steps too,
 * so a refresh keeps the step. What the buyer TYPED (name, mobile, domain …) never goes in the
 * address bar: it stays in this phone's own storage (form-state.ts).
 */
import { clampSeats, type Billing } from "../_parts/plans";
import { MAX_ONLINE_SEATS } from "@/lib/checkout/buy-link";

/** Plans and Compare, then the checkout: Domain, Details, Review & pay (R-2021). */
export const MOBILE_STEPS = ["plans", "compare", "domain", "details", "review"] as const;
export type MobileStep = (typeof MOBILE_STEPS)[number];
/** The checkout steps, in order — "Step n of 3". */
export const CHECKOUT_STEPS = ["domain", "details", "review"] as const;
export type CheckoutStep = (typeof CHECKOUT_STEPS)[number];
export type Intent = "transfer" | "new";
export type MobileTier = "starter" | "standard";

export interface MobileState {
  step: MobileStep;
  intent: Intent | null;
  tier: MobileTier;
  seats: number;
  billing: Billing;
}

/** Business plans are sold online up to 300 licences (Google's cap); above it → a quote. */
export const MOBILE_MAX_ONLINE = MAX_ONLINE_SEATS;
/** R-2019 goal 2 (Pardeep, 27 Oct): 5 licences when the link names none. */
export const DEFAULT_SEATS = 5;

type Params = URLSearchParams | Record<string, string | string[] | undefined>;

function one(p: Params, k: string): string {
  if (p instanceof URLSearchParams) return p.get(k) ?? "";
  const v = p[k];
  return (Array.isArray(v) ? v[0] : v) ?? "";
}

export function readMobileState(p: Params): MobileState {
  const step = one(p, "step");
  const intent = one(p, "intent");
  const tier = one(p, "tier");
  const n = Number.parseInt(one(p, "seats"), 10);
  return {
    step: (MOBILE_STEPS as readonly string[]).includes(step) ? (step as MobileStep) : "plans",
    intent: intent === "transfer" || intent === "new" ? intent : null,
    tier: tier === "starter" || tier === "standard" ? tier : "standard",
    seats: Number.isFinite(n) ? clampSeats(n) : DEFAULT_SEATS,
    billing: one(p, "billing") === "monthly" ? "monthly" : "annual",
  };
}

/** The search string ("?…") for `s`, keeping every other parameter of `search`. */
export function writeMobileState(search: string, s: MobileState): string {
  const p = new URLSearchParams(search);
  p.set("step", s.step);
  if (s.intent) p.set("intent", s.intent); else p.delete("intent");
  p.set("tier", s.tier);
  p.set("seats", String(s.seats));
  p.set("billing", s.billing);
  const q = p.toString();
  return q ? `?${q}` : "";
}

/** 1-based "Step n of 3" for a checkout step, else 0 (Plans / Compare). */
export function checkoutStepNumber(step: MobileStep): number {
  return (CHECKOUT_STEPS as readonly string[]).indexOf(step) + 1;
}
