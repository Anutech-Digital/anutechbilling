/**
 * The home page edition card → the Razorpay buy page, with the edition and seats already
 * chosen (R-120, 2 Oct 2026). Until then "Buy now" opened WhatsApp to ask for a payment link,
 * while /buy/workspace already took the payment, raised the invoice and recorded the order.
 *
 * Google Workspace only: the checkout route sells starter | standard | plus (annual). M365 and
 * Zoho have no online buy yet, so their cards keep the WhatsApp request.
 */
export const BUY_TIERS = ["starter", "standard", "plus"] as const;
export type BuyTier = (typeof BUY_TIERS)[number];

const EDITION_TO_TIER: Record<string, BuyTier> = {
  "GW Business Starter": "starter",
  "GW Business Standard": "standard",
  "GW Business Plus": "plus",
};

export function tierForEdition(edition: string): BuyTier | null {
  return EDITION_TO_TIER[edition] ?? null;
}

export const MAX_ONLINE_SEATS = 300; // Business editions cap at 300 users

/** /buy/workspace?tier=standard&seats=12&buy=1, or null when this edition has no online buy. */
export function buyWorkspaceHref(edition: string, seats: number): string | null {
  const tier = tierForEdition(edition);
  if (!tier) return null;
  const n = Math.max(1, Math.min(MAX_ONLINE_SEATS, Math.round(seats) || 1));
  return `/buy/workspace?tier=${tier}&seats=${n}&buy=1`;
}

/** Read the page's search params back; anything unexpected is ignored, never trusted. */
export function parseBuyParams(sp: Record<string, string | string[] | undefined>): {
  tier: BuyTier | null; seats: number | null; openBuy: boolean;
  /** R-1978: ?coupon=CODE from an ad or a mail — only a clean code (A–Z, 0–9, - _), upper-cased. */
  coupon: string | null;
} {
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const t = one(sp.tier);
  const tier = (BUY_TIERS as readonly string[]).includes(t) ? (t as BuyTier) : null;
  const s = Number.parseInt(one(sp.seats), 10);
  const seats = Number.isFinite(s) && s >= 1 ? Math.min(MAX_ONLINE_SEATS, s) : null;
  const c = one(sp.coupon).trim().toUpperCase();
  const coupon = /^[A-Z0-9_-]{2,40}$/.test(c) ? c : null;
  return { tier, seats, openBuy: one(sp.buy) === "1" && tier !== null, coupon };
}
