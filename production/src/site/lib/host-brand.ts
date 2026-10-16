/**
 * R-1458 (16 Oct 2026): which brand a host-neutral screen wears — the sign-in pages
 * ((auth)/layout: login, signup, forgot-password …) and the root 404.
 *
 * anutech.in (site-split's "company" host) → Anutech Digital, with a "Back to anutech.in" link.
 * Every other host — reselleros.anutech.in, staging, local — → ResellerOS, exactly as before.
 *
 * Display only: the host decides a logo and a title, never a redirect, a cookie or a link
 * origin (those stay on trustedOrigin, R-723).
 */
import { siteKindForHost } from "./site-split";
import { COMPANY } from "./config";

export interface HostBrand {
  site: "company" | "product";
  name: string;
  /** Image logo with the wordmark in it; null → the "R" monogram. */
  logoSrc: string | null;
  /** Way back to the public site; null on the product (the logo already goes home). */
  back: { href: string; label: string } | null;
  titleDefault: string;
  titleTemplate: string;
  footer: string;
}

const COMPANY_BRAND: HostBrand = {
  site: "company",
  name: COMPANY.short,
  logoSrc: "/lp/anutech-logo.png",
  back: { href: "/", label: "Back to anutech.in" },
  titleDefault: `Sign in · ${COMPANY.short}`,
  titleTemplate: `%s · ${COMPANY.short}`,
  footer: COMPANY.name,
};

const PRODUCT_BRAND: HostBrand = {
  site: "product",
  name: "ResellerOS",
  logoSrc: null,
  back: null,
  titleDefault: "ResellerOS — Reseller business, operated.",
  titleTemplate: "%s · ResellerOS",
  footer: "ResellerOS · DPDP Act compliant",
};

export function brandForHost(host: string | null | undefined): HostBrand {
  return siteKindForHost(host) === "company" ? COMPANY_BRAND : PRODUCT_BRAND;
}

/** Same header order as site-split's callers (marketing home). */
export function hostFromHeaders(h: { get(name: string): string | null }): string | null {
  return h.get("x-forwarded-host") ?? h.get("host");
}
