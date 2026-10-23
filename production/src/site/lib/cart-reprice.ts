/**
 * R-1797 — the cart's lines re-priced from the price book, so the cart page and checkout show
 * what the server charges after a price change on the Items page (CATALOG_FROM_DB on).
 *
 * A cart lives in the browser (CartProvider, localStorage), with each line's price fixed when
 * it was added. The checkout API re-prices every line from the book (lib/checkout/cart-checkout
 * repriceLine) and never trusts that price — so a cart saved before an edit showed ₹600 while
 * ₹610 was charged. The cart page and checkout now read GET /api/public/catalog (the same book,
 * 60 s cache) when they open and re-price the lines the book prices:
 *
 *   hosting:<tier>   → HOST-<TIER>-YR / -MO by the line's cycle
 *   mailbox:anutech  → MAIL-ANUTECH-YR
 *
 * Domains are priced live per name (not by the book); trials are free. The R-1595 bundle (free
 * domain + mailbox with yearly hosting) is still applied on render by priceCart — this only
 * moves each line's full price.
 *
 * Flag off: the API says `source: "code"` and nothing is touched — exactly today's cart.
 * Never ₹0: a missing, zero or junk price leaves the line's own price as it is.
 */
import type { HostingTier } from "@/site/lib/data/hosting-landing-v2";
import { rupee, type CartLine } from "./money";

export interface CartPrices {
  /** tier (lower case) → ₹ ex-GST per cycle; a cycle the book did not price is absent. */
  hosting: Readonly<Record<string, { yearly?: number; monthly?: number }>>;
  /** ₹ ex-GST for one mailbox, one year; null when the book did not price it. */
  mailboxYearly: number | null;
}

export interface PriceChange {
  key: string;
  label: string;
  from: number;
  to: number;
  unit: string;
}

const positive = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.round(v) : null;

/**
 * The prices a cart needs, from the body of GET /api/public/catalog. Null when the catalogue
 * is not the source (flag off → today's behaviour) or the body is not what we expect.
 */
export function cartPricesFromCatalog(body: unknown): CartPrices | null {
  if (!body || typeof body !== "object") return null;
  const { source, items } = body as { source?: unknown; items?: unknown };
  if (source !== "catalog" || !Array.isArray(items)) return null;
  const hosting: Record<string, { yearly?: number; monthly?: number }> = {};
  let mailboxYearly: number | null = null;
  for (const it of items) {
    if (!it || typeof it !== "object") continue;
    const { sku, exGst } = it as { sku?: unknown; exGst?: unknown };
    const price = positive(exGst);
    if (typeof sku !== "string" || price === null) continue;
    const h = /^HOST-([A-Z]+)-(YR|MO)$/.exec(sku);
    if (h) {
      const tier = h[1].toLowerCase();
      hosting[tier] = { ...hosting[tier], [h[2] === "YR" ? "yearly" : "monthly"]: price };
    } else if (sku === "MAIL-ANUTECH-YR") {
      mailboxYearly = price;
    }
  }
  return { hosting, mailboxYearly };
}

/** The book's price for one cart line, or null when the book does not price it. */
function bookPrice(line: CartLine, prices: CartPrices): number | null {
  const sku = (line.sku ?? "").toLowerCase();
  const h = /^hosting:([a-z]+)$/.exec(sku);
  if (h) return prices.hosting[h[1]]?.[line.cycle === "monthly" ? "monthly" : "yearly"] ?? null;
  if (sku === "mailbox:anutech") return prices.mailboxYearly;
  return null;
}

/**
 * Each line the book prices, at the book's price. Returns the SAME array when nothing changed
 * (so a caller can set state only on a real change), and what changed for the notice.
 */
export function repriceCartLines(lines: readonly CartLine[], prices: CartPrices): { lines: CartLine[]; changes: PriceChange[] } {
  const changes: PriceChange[] = [];
  const next = lines.map((l) => {
    const p = bookPrice(l, prices);
    if (p === null || p <= 0 || p === l.unitPrice) return l;
    changes.push({ key: l.key, label: l.label, from: l.unitPrice, to: p, unit: l.unit });
    return { ...l, unitPrice: p };
  });
  return { lines: changes.length ? next : (lines as CartLine[]), changes };
}

/** The one-line notice for the cart page and checkout, or null when nothing changed. */
export function priceChangeNotice(changes: readonly PriceChange[]): string | null {
  if (!changes.length) return null;
  const what = changes.map((c) => `${c.label} ${rupee(c.from)} → ${rupee(c.to)}`).join(", ");
  return `${changes.length === 1 ? "Price" : "Prices"} changed: ${what}. The total below is what you will pay.`;
}

/**
 * A hosting tier at the book's prices (checkout's "Buy Starter instead" builds its line from
 * this). No book, or a cycle it does not price → the code figure for that cycle.
 */
export function tierWithPrices(tier: HostingTier, prices: CartPrices | null): HostingTier {
  const p = prices?.hosting[tier.name.toLowerCase()];
  if (!p) return tier;
  const yr = p.yearly && p.yearly !== Math.round(tier.yearlyTotal) ? p.yearly : null;
  const mo = p.monthly && p.monthly !== Math.round(tier.monthly) ? p.monthly : null;
  if (yr === null && mo === null) return tier;
  return {
    ...tier,
    ...(yr === null ? {} : { yearlyTotal: yr, yearlyMo: Math.round((yr / 12) * 100) / 100 }),
    ...(mo === null ? {} : { monthly: mo }),
  };
}
