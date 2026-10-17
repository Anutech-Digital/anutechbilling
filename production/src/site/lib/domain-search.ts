/**
 * The site's domain availability lookup — ONE implementation.
 *
 * It used to live inside the hero's DomainSearch card. The always-on search
 * dock (2 Sep 2026, Pardeep: "domain search home page par ek tool ki tarah
 * hamesha visible ho") needs exactly the same lookup, and two copies of a
 * money-and-availability call is precisely how the two drift — one gets fixed,
 * the other keeps lying. So both call this.
 *
 * It asks the site's own proxy (/api/domains/availability), which forwards to
 * the platform. It NEVER invents a result: an unreachable platform returns an
 * error the UI must show, not a guess (the hero used to decide TAKEN with a
 * string hash — see domain-search.real.test.ts, which pins that regression).
 */

import { WHATSAPP_URL } from "@/site/lib/config";

/** Default TLDs to check — the platform prices whatever it recognises. */
export const DEFAULT_TLDS = ["in", "com", "co.in", "org", "net"];

export interface DomainResult {
  domain: string;
  available: boolean;
  price: number;
  currency: string;
  years: number;
  priceKnown: boolean;
  /** R-156: total ₹ per offered term ("1", "2", "3", "5"); see lib/domains/live-lookup. */
  prices?: Record<string, number>;
}

export type SearchOutcome =
  | { ok: true; base: string; domains: DomainResult[] }
  | { ok: false; message: string };

/** The one message shown when the platform can't answer. Honest, and offers a way on. */
export const UNREACHABLE = "Couldn't check right now — please try again, or WhatsApp us.";

/**
 * R-1494: where a visitor goes when the check fails — ONE place, so the /domains page and
 * the always-on dock offer the same way on (CLAUDE.md §24: a block names the next step).
 * Staging answered 502 on every search (no registrar configured there) and the /domains
 * page showed only red text — a dead end in the buying flow.
 */
export function domainHelpLinks(name: string): { quoteHref: string; whatsappHref: string } {
  return {
    quoteHref: "/quote",
    whatsappHref: `${WHATSAPP_URL}?text=${encodeURIComponent(`Hi — is ${name} available? What would it cost?`)}`,
  };
}

/** Strip a typed name down to what a domain label may contain. */
export function normaliseName(raw: string): string {
  return raw.trim().toLowerCase().replace(/[^a-z0-9-]/g, "");
}

export async function searchDomains(base: string, tlds: readonly string[] = DEFAULT_TLDS): Promise<SearchOutcome> {
  try {
    const res = await fetch(
      `/api/domains/availability?name=${encodeURIComponent(base)}&tlds=${tlds.join(",")}`,
      { cache: "no-store" },
    );
    if (!res.ok) return { ok: false, message: UNREACHABLE };
    const body = (await res.json()) as { base?: string; domains?: DomainResult[] };
    return { ok: true, base: body.base ?? base, domains: body.domains ?? [] };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}
