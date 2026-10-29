/**
 * R-2027 (27 Oct 2026): the buy page's price list as it travels — from the server page as props,
 * and from GET /api/public/catalog/buy-workspace when the server's read failed on a cold start.
 *
 *   publicBuyRow   — what of a catalogue row may reach the visitor's browser (moved from page.tsx
 *                    unchanged): R-328 Business Plus carries NO price; wholesale and margin are our
 *                    cost and never leave (0 / null).
 *   toWire         — the endpoint's answer: only id, name, msrp, prices.{annual,monthly}.msrp.
 *   fromWire       — the client's check of that answer: a malformed list is "no prices", never
 *                    shown, and never replaced by typed prices.
 *
 * No server imports — the client hook (use-buy-catalog.ts) uses fromWire.
 */
import { isPublicPriceHidden } from "@/lib/catalog/public-price-policy";
import type { CatalogItem } from "./tiers";

export function publicBuyRow(row: CatalogItem): CatalogItem {
  const hidden = isPublicPriceHidden(row.name);
  const strip = (t?: { msrp: number; wholesale: number }) => (t ? { msrp: hidden ? 0 : t.msrp, wholesale: 0 } : undefined);
  return {
    ...row,
    msrp: hidden ? 0 : row.msrp,
    wholesale: 0,
    margin_pct: null,
    prices: hidden ? {} : { ...(row.prices?.annual ? { annual: strip(row.prices.annual) } : {}), ...(row.prices?.monthly ? { monthly: strip(row.prices.monthly) } : {}) },
  };
}

export interface WireItem {
  id: string;
  name: string;
  msrp: number;
  prices: { annual?: { msrp: number }; monthly?: { msrp: number } };
}

export function toWire(items: readonly CatalogItem[]): WireItem[] {
  return items.map((i) => ({
    id: i.id,
    name: i.name,
    msrp: i.msrp,
    prices: {
      ...(i.prices?.annual ? { annual: { msrp: i.prices.annual.msrp } } : {}),
      ...(i.prices?.monthly ? { monthly: { msrp: i.prices.monthly.msrp } } : {}),
    },
  }));
}

const money = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;

function tierOf(v: unknown): { msrp: number; wholesale: number } | undefined | false {
  if (v === undefined) return undefined;
  if (!v || typeof v !== "object" || !money((v as { msrp?: unknown }).msrp)) return false;
  return { msrp: (v as { msrp: number }).msrp, wholesale: 0 };
}

/** The endpoint's items back into the page's rows — null when anything in it is not well formed. */
export function fromWire(v: unknown): CatalogItem[] | null {
  if (!Array.isArray(v)) return null;
  const out: CatalogItem[] = [];
  for (const raw of v) {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.name !== "string" || !r.name.trim() || !money(r.msrp)) return null;
    const p = (r.prices ?? {}) as Record<string, unknown>;
    if (typeof p !== "object") return null;
    const annual = tierOf(p.annual);
    const monthly = tierOf(p.monthly);
    if (annual === false || monthly === false) return null;
    out.push({
      id: r.id, name: r.name, msrp: r.msrp, wholesale: 0, margin_pct: null, is_active: true,
      prices: { ...(annual ? { annual } : {}), ...(monthly ? { monthly } : {}) },
    });
  }
  return out;
}
