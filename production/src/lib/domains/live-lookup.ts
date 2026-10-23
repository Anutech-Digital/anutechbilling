/**
 * Live domain availability + 1-year price — ONE server-side implementation.
 *
 * Two callers, and they must never disagree:
 *   - GET /api/domains/availability — what the site's search SHOWS a visitor
 *   - POST /api/public/checkout/cart — what the checkout CHARGES them
 *
 * Until 24 Sep 2026 the checkout charged a fixed table (`TLDS` in
 * site/lib/data/catalog) while the search showed this live figure, so a customer
 * could be shown one price and charged another. Owner decision 19: charge the
 * live price, re-checked at payment, and refuse when it cannot be read — never
 * fall back to a guess. That is why this returns `{ ok: false }` rather than a
 * default, and why the checkout treats `priceKnown: false` as "cannot sell".
 *
 * Two paths, in this order (unchanged from the route this was lifted out of):
 *   1. DIRECT — ResellerClub itself, when its credentials are on this server
 *      (the whitelisted static IP).
 *   2. TEST — R-1769: on a laptop with neither (a simulated payment is allowed and no
 *      platform is configured), a fixed TEST price list; every row says `testPrice`.
 *   3. ENGINE — the domains platform's public API, when they are not.
 */
import { DOMAIN_AVAILABILITY_API } from "@/site/lib/config";
import { rcConfigured, rcAvailability, rcTldPricing } from "@/lib/resellerclub";
import { testDomainPricesActive, testLookup } from "./test-prices";

export interface LiveDomain {
  domain: string;
  available: boolean;
  /** 1-year registration price in whole-or-fractional rupees, before GST. 0 when unknown. */
  price: number;
  currency: string;
  years: number;
  /** False when availability came back but the price did not — never sell such a row. */
  priceKnown: boolean;
  /**
   * R-156: TOTAL registration price (₹, before GST) per offered term, keyed "1", "2", "3",
   * "5" — only the terms the registry actually prices. Absent or {"1"} only → the domain is
   * sold for one year. Never extrapolated from the 1-year price.
   */
  prices?: Record<string, number>;
  /** R-1769: true when the price came from the laptop-only TEST price list (test-prices.ts). */
  testPrice?: boolean;
}

/** The terms a customer can pick (R-156). Ten is the registry's ceiling; these are the common ones. */
export const DOMAIN_TERMS: readonly number[] = [1, 2, 3, 5];

/**
 * Keep only offered terms with a positive whole-rupee total; "1" always mirrors the 1-year
 * price the row is sold at, so the two can never disagree. Exported for tests.
 */
export function cleanTermPrices(raw: unknown, oneYear: number): Record<string, number> {
  const out: Record<string, number> = {};
  if (oneYear > 0) out["1"] = Math.round(oneYear);
  if (!raw || typeof raw !== "object") return out;
  for (const t of DOMAIN_TERMS) {
    if (t === 1) continue;
    const v = Number((raw as Record<string, unknown>)[String(t)]);
    if (Number.isFinite(v) && v > 0) out[String(t)] = Math.round(v);
  }
  return out;
}

export type LiveLookup =
  | { ok: true; base: string; domains: LiveDomain[]; source: "resellerclub" | "engine" | "test" }
  | { ok: false };

export const DEFAULT_TLDS = ["in", "com", "co.in", "org", "net"];

/** Normalise a TLD list: no leading dots, lower case, at most ten. */
export function cleanTlds(raw: readonly string[]): string[] {
  return raw
    .map((t) => t.trim().replace(/^\.+/, "").toLowerCase())
    .filter(Boolean)
    .slice(0, 10);
}

export async function lookupDomains(name: string, tlds: readonly string[]): Promise<LiveLookup> {
  const base = name.trim().toLowerCase();
  const list = cleanTlds(tlds);

  if (rcConfigured()) {
    const [avail, prices] = await Promise.all([rcAvailability(base, list), rcTldPricing(list)]);
    if (!avail) return { ok: false };
    const priceByTld = new Map((prices ?? []).map((p) => [p.tld.replace(/^\./, ""), p]));
    const byDomain = new Map(avail.map((a) => [a.domain, a]));
    const domains = list
      .map((tld): LiveDomain | null => {
        const a = byDomain.get(`${base}.${tld}`);
        if (!a) return null;
        const p = priceByTld.get(tld);
        const register = p?.register ?? null;
        return {
          domain: a.domain,
          available: a.available,
          price: register ?? 0,
          currency: "INR",
          years: 1,
          priceKnown: a.available && register !== null,
          prices: register !== null ? cleanTermPrices(p?.registerTotals, register) : {},
        };
      })
      .filter((d): d is LiveDomain => d !== null);
    return { ok: true, base, domains, source: "resellerclub" };
  }

  /* R-1769: never on a deployment or with a live key — testDomainPricesActive says when. */
  if (testDomainPricesActive({ rcConfigured: false })) return testLookup(base, list);

  const url = new URL(DOMAIN_AVAILABILITY_API);
  url.searchParams.set("name", base);
  url.searchParams.set("tlds", list.join(","));
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(12_000), cache: "no-store" });
    if (!res.ok) return { ok: false };
    const body = (await res.json()) as { base?: string; domains?: LiveDomain[] };
    /* The engine answers per row with its own fields; `prices` is passed through only when
       it is a clean term → total map (an engine without R-156 sends none → 1 year only). */
    const domains = (Array.isArray(body.domains) ? body.domains : []).map((d) => ({
      ...d,
      prices: d.priceKnown && d.price > 0 ? cleanTermPrices(d.prices, d.price) : {},
    }));
    return { ok: true, base: body.base ?? base, domains, source: "engine" };
  } catch (err) {
    console.error("[domains/live-lookup] upstream unreachable:", err);
    return { ok: false };
  }
}

/**
 * Split a full domain into its label and TLD, for a domain the checkout is about
 * to charge for. Refuses anything that is not a single registrable name — no
 * subdomains, no spaces, no scheme — so what is charged is exactly what is
 * registered.
 */
export function splitDomain(raw: string): { name: string; tld: string } | null {
  const d = raw.trim().toLowerCase();
  const m = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.([a-z]{2,}(?:\.[a-z]{2,})?)$/.exec(d);
  if (!m) return null;
  return { name: m[1], tld: m[2] };
}
