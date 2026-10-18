/**
 * Live TLD rate card — the ONE price source every public domain price is read from:
 * /domains (rate table, result card, JSON-LD), /rates, the homepage and header teaser.
 *
 * ─── WHY (R-1599, 18 Oct 2026) ──────────────────────────────────────────────
 * catalog.ts TLDS carries placeholder register/renew/transfer figures that had drifted
 * from what the shop charges, and until today every page printed them: /rates said .com
 * ₹899 while the checkout charged the live registry price. This module existed to fix
 * that, but nothing called it. Now the pages call `getSiteTldPrices()` and nothing on a
 * public page reads a TLDS price (guarded by live-tld-parity.test.ts).
 *
 * ─── THE SAME NUMBER THE CHECKOUT CHARGES ───────────────────────────────────
 * The checkout prices a domain line through lookupDomains (lib/domains/live-lookup.ts),
 * which on a server with the ResellerClub credentials reads rcTldPricing → `register`,
 * whole rupees (Math.round), from our customer price list (customer-price.json — markup
 * included). This reads the very same rcTldPricing, so for one price list the table and
 * the charge are the same rupee. Without the credentials (local dev) both sides fall back
 * to the engine's public API, rounded the same way.
 *
 * ─── CACHE AND FALLBACK — NEVER A MADE-UP NUMBER ────────────────────────────
 *   1. The pages are ISR (revalidate 600). The read is wrapped in unstable_cache
 *      (10 min), so the registry's no-store fetch does not turn a static page dynamic.
 *   2. A failed read THROWS inside the cache — Next then keeps serving the last good
 *      cached prices instead of replacing them with nothing.
 *   3. This server also remembers the last good live price per TLD (`lastGood`), for a
 *      cache miss while the registry is down.
 *   4. Nothing live at all → the price is null and the page says "Price at search",
 *      never the placeholder.
 */
import { unstable_cache } from "next/cache";
import { TLD_PRICING_API } from "./config";
import { TLDS, type Tld } from "./data/catalog";
/* Plan B (2 Sep 2026): the one deliberate site→app import. This runs server-side
   only (the pages that call it are server components), and the app's ResellerClub
   client is where the credentials live — duplicating that here would be a second
   copy of a money-facing integration. */
import { rcConfigured, rcTldPricing } from "@/lib/resellerclub";

export interface LiveTldPrice {
  tld: string; // ".in"
  register: number | null;
  renew: number | null;
  transfer: number | null;
  currency: string;
}

/** Whole rupees, exactly as the checkout rounds a domain line (cleanTermPrices → Math.round). */
function rupees(n: unknown): number | null {
  const v = typeof n === "string" ? Number(n) : typeof n === "number" ? n : NaN;
  return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
}

const dotted = (t: string) => `.${t.replace(/^\.+/, "").toLowerCase()}`;

export async function fetchLiveTldPricing(tlds: readonly string[]): Promise<LiveTldPrice[] | null> {
  /* Direct from ResellerClub when this server holds the credentials — the same call the
     checkout's lookupDomains prices with. Null on failure, never a guess. */
  if (rcConfigured()) {
    const rows = await rcTldPricing(tlds.map((t) => t.replace(/^\.+/, "")));
    return rows?.map((r) => ({
      tld: dotted(r.tld),
      register: rupees(r.register),
      renew: rupees(r.renew),
      transfer: rupees(r.transfer),
      currency: r.currency,
    })) ?? null;
  }
  try {
    // API wants dot-less, comma-separated ("in,com,co.in").
    const q = tlds.map((t) => t.replace(/^\.+/, "")).join(",");
    const res = await fetch(`${TLD_PRICING_API}?tlds=${encodeURIComponent(q)}`, {
      next: { revalidate: 600 },
      signal: AbortSignal.timeout(6_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { tlds?: unknown };
    if (!Array.isArray(body.tlds)) return null;
    const rows = body.tlds
      .filter((r): r is Record<string, unknown> => !!r && typeof r === "object" && typeof (r as { tld?: unknown }).tld === "string")
      .map((r) => ({
        tld: dotted(String(r.tld)),
        register: rupees(r.register),
        renew: rupees(r.renew),
        transfer: rupees(r.transfer),
        currency: typeof r.currency === "string" ? r.currency : "INR",
      }));
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

/** A rate-card row as the public site shows it: a null price is "not known right now". */
export interface SiteTld extends Omit<Tld, "reg" | "renew" | "transfer"> {
  reg: number | null;
  renew: number | null;
  transfer: number | null;
  /** True only when `reg` is a real live (or last-known live) price. */
  live: boolean;
}

/**
 * TLDS' names/notes/groups with ONLY live prices. A TLD the registry did not price gets
 * nulls — never the placeholder from catalog.ts.
 */
export function mergeTlds(live: readonly LiveTldPrice[] | null): SiteTld[] {
  const byTld = new Map((live ?? []).map((r) => [dotted(r.tld), r]));
  return TLDS.map(({ tld, use, group }) => {
    const r = byTld.get(tld.toLowerCase());
    if (!r || r.register == null) return { tld, use, group, reg: null, renew: null, transfer: null, live: false };
    return { tld, use, group, reg: r.register, renew: r.renew, transfer: r.transfer, live: true };
  });
}

/* Last good live row per TLD, on this server. A cache, not a source of truth. */
const lastGood = new Map<string, LiveTldPrice>();

/** Fill TLDs the registry did not answer from the last good live answer. Exported for tests. */
export function withLastGood(rows: readonly LiveTldPrice[] | null): LiveTldPrice[] {
  const fresh = new Map<string, LiveTldPrice>();
  for (const r of rows ?? []) {
    if (r.register == null) continue;
    const row = { ...r, tld: dotted(r.tld) };
    lastGood.set(row.tld, row);
    fresh.set(row.tld, row);
  }
  for (const [tld, r] of lastGood) if (!fresh.has(tld)) fresh.set(tld, r);
  return [...fresh.values()];
}

/** Tests only. */
export function _resetLastGood(): void {
  lastGood.clear();
}

const ALL_TLDS = TLDS.map((t) => t.tld);

/* Throws when nothing live came back, so unstable_cache keeps its last good entry. */
const cachedLive = unstable_cache(
  async (): Promise<LiveTldPrice[]> => {
    const rows = await fetchLiveTldPricing(ALL_TLDS);
    if (!rows || !rows.some((r) => r.register != null)) throw new Error("live TLD prices unavailable");
    return rows;
  },
  ["site-live-tld-pricing-v1"],
  { revalidate: 600 },
);

/** Every public domain price comes from here. Never throws. */
export async function getSiteTldPrices(): Promise<SiteTld[]> {
  let rows: LiveTldPrice[] | null = null;
  try {
    rows = await cachedLive();
  } catch {
    rows = null;
  }
  return mergeTlds(withLastGood(rows));
}
