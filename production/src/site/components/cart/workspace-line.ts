/**
 * R-1966 (26 Oct 2026, Pardeep on staging /buy/workspace: "buy now ka option hi nahi; cart bhi
 * show ho"): Google Workspace in the website cart.
 *
 * A Workspace line is the visitor's CHOICE (edition + users), kept in the same cart as hosting
 * and domains so the header badge and the drawer show it. It is PAID through the Workspace
 * Buy now dialog on /buy/workspace (api/public/checkout/workspace) — the one place that
 * prices a Workspace order on the server from the catalogue, takes the Google domain and
 * creates the subscription. So every "Checkout" for a Workspace line (drawer, /cart → /checkout)
 * goes to `/buy/workspace?tier=…&seats=…&buy=1`, which opens that dialog prefilled — never a
 * second Workspace checkout, and never a /checkout that refuses the line at Pay.
 *
 * The price on the line is display only (the annual rate × 12 per user); the server never
 * reads it.
 */
import type { CartLine } from "@/site/lib/money";
import { BUY_TIERS, MAX_ONLINE_SEATS, type BuyTier } from "@/lib/checkout/buy-link";

export const WORKSPACE_SKU_PREFIX = "workspace:";

/** The browser storage key CartProvider keeps the cart under (shared so the thanks page can tidy it). */
export const CART_STORAGE_KEY = "anutech.cart.v1";

export function isWorkspaceLine(line: Pick<CartLine, "sku">): boolean {
  return (line.sku ?? "").toLowerCase().startsWith(WORKSPACE_SKU_PREFIX);
}

function tierOf(line: Pick<CartLine, "sku">): BuyTier | null {
  const t = (line.sku ?? "").toLowerCase().slice(WORKSPACE_SKU_PREFIX.length);
  return (BUY_TIERS as readonly string[]).includes(t) ? (t as BuyTier) : null;
}

/**
 * The cart line for `seats` users of a Workspace edition on the annual plan.
 * `ratePerUserMonth` is the annual-plan rate the page shows (₹/user/month, pre-GST).
 */
export function workspaceCartLine(input: {
  tierId: string;
  tierName: string;
  seats: number;
  ratePerUserMonth: number;
}): Omit<CartLine, "key"> {
  const seats = Math.max(1, Math.min(MAX_ONLINE_SEATS, Math.round(input.seats) || 1));
  return {
    label: `Google Workspace ${input.tierName}`,
    detail: `${seats} user${seats === 1 ? "" : "s"} · 1-year plan, billed annually`,
    unitPrice: Math.round(input.ratePerUserMonth * 12),
    qty: seats,
    unit: "user/year",
    cycle: "yearly",
    sku: `${WORKSPACE_SKU_PREFIX}${input.tierId}`,
  };
}

/** The Workspace Buy now dialog for this line, prefilled — or null for an edition not sold online. */
export function workspaceBuyHref(line: Pick<CartLine, "sku" | "qty">): string | null {
  const tier = tierOf(line);
  if (!tier) return null;
  const seats = Math.max(1, Math.min(MAX_ONLINE_SEATS, Math.round(line.qty) || 1));
  return `/buy/workspace?tier=${tier}&seats=${seats}&buy=1`;
}

/**
 * Where "Checkout" goes for this cart: the Workspace dialog while a Workspace line is in it
 * (it is paid on its own step; the other items stay in the cart for /checkout afterwards),
 * else the cart's /checkout.
 */
export function cartCheckoutHref(lines: readonly Pick<CartLine, "sku" | "qty">[]): string {
  for (const l of lines) {
    if (!isWorkspaceLine(l)) continue;
    const href = workspaceBuyHref(l);
    if (href) return href;
  }
  return "/checkout";
}

/**
 * After a Workspace order is paid, take its line out of the stored cart so the badge does not
 * keep offering it. Works outside CartProvider (the thanks page has none). Never throws.
 */
export function dropWorkspaceLinesFromStoredCart(): void {
  try {
    const raw = window.localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return;
    const kept = parsed.filter(
      (l) => !(l && typeof l === "object" && isWorkspaceLine({ sku: typeof (l as { sku?: unknown }).sku === "string" ? (l as { sku: string }).sku : undefined })),
    );
    if (kept.length !== parsed.length) window.localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(kept));
  } catch {
    /* Storage refused — nothing to tidy. */
  }
}
