/**
 * Does this customer have support for the product they are asking about?
 *
 * ─── THREE ANSWERS, NOT TWO ─────────────────────────────────────────────────
 * covered / uncovered / UNKNOWN. The third one is the reason this module exists.
 *
 * A support SKU whose `covered_product` was never filled in is not "covers
 * everything" and it is not "covers nothing". It is a question nobody answered, and
 * collapsing it either way is a mistake with a victim:
 *
 *   · read as `all`  → a customer is told they are entitled to support for a product
 *     nobody sold them, and finds out when they need it
 *   · read as none   → a paying customer is refused support they did buy, and the
 *     upsell button appears in front of someone who already paid
 *
 * So `unknown` says which SKU is unclassified and asks for it to be fixed, which is
 * the only action that actually resolves it.
 *
 * ─── THE COMPARISON IS DIRECT, BY DESIGN ────────────────────────────────────
 * `items.covered_product` uses the same spellings as `public.vendor`, so a licence's
 * vendor is compared to a support plan's coverage without a mapping table in between.
 * A mapping table is a third thing to keep in step with two enums.
 */
import type { SupportTierId } from "./tiers";

export type CoveredProduct =
  | "google" | "microsoft" | "zoho" | "hosting" | "domain" | "other" | "all";

/** A support subscription the customer actually holds. */
export interface SupportCoverage {
  /** The subscription id, so the UI can link to it. */
  subscriptionId: string;
  planName: string;
  tier: SupportTierId;
  /** From items.covered_product. Null = nobody classified this SKU. */
  covered: CoveredProduct | null;
}

/** A product licence the customer holds. */
export interface LicenceHolding {
  subscriptionId: string;
  plan: string;
  /** public.vendor value. */
  vendor: string;
  seats: number;
}

export type CoverageVerdict =
  | { state: "covered";   by: SupportCoverage }
  | { state: "uncovered"; reason: string; nextStep: string }
  | { state: "unknown";   reason: string; nextStep: string };

/** Display name for a vendor value. */
export function productLabel(vendor: string | null | undefined): string {
  switch (vendor) {
    case "google":    return "Google Workspace";
    case "microsoft": return "Microsoft 365";
    case "zoho":      return "Zoho";
    case "hosting":   return "Hosting";
    case "domain":    return "Domains";
    case "support":   return "Support";
    case "all":       return "All products";
    default:          return "Other";
  }
}

/**
 * Is this product covered by any of the customer's support plans?
 *
 * When several plans could cover it, the FIRST match wins in the order given — the
 * caller sorts by tier so a customer holding both Standard and Enterprise is reported
 * under the better one. Reporting the weaker plan would understate what they bought.
 */
export function coverageFor(
  vendor: string | null | undefined,
  supports: readonly SupportCoverage[],
): CoverageVerdict {
  if (supports.length === 0) {
    return {
      state: "uncovered",
      reason: "No support plan on this account.",
      nextStep: "Add a support plan to the next quote — Standard covers priority email and WhatsApp.",
    };
  }

  const match = supports.find((s) => s.covered === "all" || (vendor != null && s.covered === vendor));
  if (match) return { state: "covered", by: match };

  /* Anything unclassified is reported as unknown rather than being counted against
     the customer — they may well have bought exactly this. */
  const unclassified = supports.filter((s) => s.covered == null);
  if (unclassified.length > 0) {
    return {
      state: "unknown",
      reason: `${unclassified.map((s) => s.planName).join(", ")} does not say which product it covers.`,
      nextStep: "Set the covered product on that plan in Products, then this will answer properly.",
    };
  }

  const held = supports.map((s) => productLabel(s.covered)).join(", ");
  return {
    state: "uncovered",
    reason: `Their support plan covers ${held}, not ${productLabel(vendor)}.`,
    nextStep: `Quote a support plan that covers ${productLabel(vendor)}, or move them to one covering all products.`,
  };
}

/**
 * Which product a ticket is about, read from its own words.
 *
 * ─── MATCHED AGAINST WHAT THIS CUSTOMER ACTUALLY HOLDS ──────────────────────
 * `support_tickets` has no product column, so this is inference — but it is inference
 * against a short, known list: the customer's own licences. That is a very different
 * thing from guessing a product out of the whole catalogue, and it is why a mention
 * of "Google" only counts when they actually have a Google licence.
 *
 * Returns null when nothing matches, and the card then shows the general entitlement
 * without claiming to know what the ticket is about. Guessing here would put a
 * "Not covered — upsell" banner in front of a rep over a product the customer never
 * mentioned.
 *
 * Longest plan name first, so "Google Workspace Business Standard" wins over a bare
 * vendor word.
 */
export function detectTicketProduct(
  text: string | null | undefined,
  licences: readonly LicenceHolding[],
): string | null {
  const hay = (text ?? "").toLowerCase();
  if (!hay.trim()) return null;

  const byPlanLength = [...licences].sort((a, b) => b.plan.length - a.plan.length);
  for (const l of byPlanLength) {
    if (l.plan.trim().length >= 4 && hay.includes(l.plan.trim().toLowerCase())) return l.vendor;
  }

  /* Vendor words, but only for vendors this customer HAS. "We use Google" from a
     customer with no Google licence is not a product this ticket is about. */
  const VENDOR_WORDS: Record<string, string[]> = {
    google:    ["google workspace", "gsuite", "g suite", "google"],
    microsoft: ["microsoft 365", "office 365", "m365", "o365", "outlook", "microsoft"],
    zoho:      ["zoho"],
    hosting:   ["hosting", "cpanel"],
    domain:    ["domain", "dns"],
  };
  const held = new Set(licences.map((l) => l.vendor));
  for (const [vendor, words] of Object.entries(VENDOR_WORDS)) {
    if (!held.has(vendor)) continue;
    if (words.some((w) => hay.includes(w))) return vendor;
  }
  return null;
}

export interface EntitlementRow {
  licence: LicenceHolding;
  verdict: CoverageVerdict;
}

/**
 * Every licence the customer holds, and whether support covers it.
 *
 * Support subscriptions are excluded from the licence list — a support plan covering
 * itself is not a fact anybody needs, and it would show up as a row claiming the
 * customer has support for their support.
 *
 * R-526: a domain registration is not a licence either. Q-FBB9-27-0019's support card counted
 * the yearly .in registration as a covered licence next to Workspace and M365 — a domain has
 * no seats and no product to support. Left out by vendor "domain" or by its name.
 */
export function isDomainRegistration(l: Pick<LicenceHolding, "vendor" | "plan">): boolean {
  if (l.vendor === "domain") return true;
  return /\bdomain\b.*\b(registration|renewal|transfer)\b|\b(registration|renewal)\b.*\bdomain\b/i.test(l.plan ?? "");
}

export function entitlementRows(
  licences: readonly LicenceHolding[],
  supports: readonly SupportCoverage[],
): EntitlementRow[] {
  return licences
    .filter((l) => l.vendor !== "support" && !isDomainRegistration(l))
    .map((licence) => ({ licence, verdict: coverageFor(licence.vendor, supports) }));
}

/** Counts for the card header. */
export function entitlementSummary(rows: readonly EntitlementRow[]): {
  covered: number; uncovered: number; unknown: number; total: number;
} {
  return {
    covered:   rows.filter((r) => r.verdict.state === "covered").length,
    uncovered: rows.filter((r) => r.verdict.state === "uncovered").length,
    unknown:   rows.filter((r) => r.verdict.state === "unknown").length,
    total:     rows.length,
  };
}
