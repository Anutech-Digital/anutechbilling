/**
 * R-1763 — which PRODUCT a plan name is, so one product sold under two item names is one
 * subscription.
 *
 * Measured 22 Oct 2026 (local Zoho import with the owner): Zoho Books renamed its items
 * ("Google Workspace - Business Starter ( Email Solutions )" → "Google Workspace Business
 * Starter - User License (Resale)"), and the import, keyed on domain + item name, made two
 * subscriptions for one domain: 3 + 3 seats where the customer has 3, 49 + 10 where one
 * Microsoft 365 Basic subscription has 59.
 *
 * The key is vendor + edition (+ the Teams variant). Words that only describe HOW we sell it
 * ("User License", "Resale", "Email Solutions", "Annual", "Flexible") are not part of it.
 * Different editions, and "with Teams" vs "without Teams" vs neither, stay different — those
 * are different Microsoft SKUs at different prices. A name with no known vendor + edition
 * falls back to its words minus the selling words, so unknown products only merge when their
 * names say the same thing.
 */
import { planKey } from "./plan-match";

/** Words that describe the sale, not the product. */
const SELLING_WORDS = new Set([
  "user", "users", "license", "licence", "licenses", "licences", "resale", "email", "solution", "solutions",
  "subscription", "annual", "yearly", "monthly", "commitment", "flexible", "seat", "seats", "per", "plan",
]);

function teamsVariant(k: string): "" | "teams" | "noteams" {
  if (/\b(without|no|excl|excluding|exclude) teams\b/.test(k)) return "noteams";
  if (/\b(with|incl|including|include) teams\b/.test(k)) return "teams";
  return "";
}

function vendorOf(k: string): "google" | "microsoft" | "zoho" | null {
  if (/\b(google|workspace|g suite|gsuite)\b/.test(k)) return "google";
  if (/\b(microsoft|office 365|m365|o365|ms 365|microsoft 365)\b/.test(k)) return "microsoft";
  if (/\bzoho\b/.test(k)) return "zoho";
  return null;
}

function editionOf(vendor: "google" | "microsoft" | "zoho", k: string): string | null {
  const has = (w: string) => new RegExp(`\\b${w}\\b`).test(k);
  if (vendor === "google") {
    if (has("enterprise")) {
      const sub = ["essentials", "starter", "standard", "plus"].find(has);
      return sub ? `enterprise ${sub}` : "enterprise";
    }
    if (has("frontline")) return "frontline";
    if (has("essentials")) return has("starter") ? "essentials starter" : "essentials";
    return ["starter", "standard", "plus"].find(has) ?? null;
  }
  if (vendor === "microsoft") {
    const e = ["e1", "e3", "e5", "f1", "f3"].find(has);
    if (e) return e;
    if (has("apps")) return has("enterprise") ? "apps enterprise" : "apps";
    return ["basic", "standard", "premium"].find(has) ?? null;
  }
  return null;
}

/** The product a plan name is: "google|starter|", "microsoft|basic|noteams", or "?|<words>". */
export function productKey(name: string | null | undefined): string {
  const k = planKey(name);
  if (!k) return "";
  const teams = teamsVariant(k);
  const vendor = vendorOf(k);
  const edition = vendor ? editionOf(vendor, k) : null;
  if (vendor && edition) return `${vendor}|${edition}|${teams}`;
  const words = k.split(" ").filter((w) => !SELLING_WORDS.has(w)).join(" ");
  return `?|${words || k}`;
}
