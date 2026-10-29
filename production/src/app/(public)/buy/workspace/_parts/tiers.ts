/**
 * R-2020 (R-2019a, 27 Oct 2026): the catalogue rows → the page's tiers (R-276 floor, R-157 real
 * monthly rate only, R-328 Plus without a price). No typed fallback prices since R-2027.
 * Moved out of buy-workspace-client.tsx unchanged, so the desktop page and the phone flow build
 * their plans from ONE copy — no second price rule.
 */
import { isPublicPriceHiddenTier } from "@/lib/catalog/public-price-policy";
import { tierAnnualPrice } from "../tier-price";

// ──────────────────────────────────────────────────────────────────────
// Pricing tiers
// ──────────────────────────────────────────────────────────────────────
export interface Tier {
  id:           string;
  catalogId:    string | null;   // FK to items.id when the tier came from the catalog
  name:         string;
  monthlyPrice: number | null;
  annualPrice:  number | null;
  promoPrice?:  number | null;
  promoLabel?:  string | null;
  maxUsers:     number | null;
  isPopular?:   boolean;
  cta:          string;
  introHeader:  string;
  features:     string[];
}

/**
 * What the Server Component (page.tsx) passes in. One row per enabled
 * Google Workspace SKU in the reseller's Item Catalog. When empty, the
 * page shows "Loading prices…" (null) or "not available online" (empty) — R-2027.
 */
export interface CatalogItem {
  id:         string;
  name:       string;
  msrp:       number;
  wholesale:  number;
  margin_pct: number | null;
  is_active:  boolean;
  prices: {
    annual?:  { msrp: number; wholesale: number };
    monthly?: { msrp: number; wholesale: number };
  };
}

// Hardcoded feature lists + popularity flag — the Item Catalog doesn't store
// these yet, so we keep a slug-keyed preset and merge it with each item's
// pricing data when building runtime tiers.
type TierSlug = "starter" | "standard" | "plus" | "enterprise";

interface TierPreset {
  slug:        TierSlug;
  introHeader: string;
  features:    string[];
  isPopular?:  boolean;
}

const TIER_PRESETS: Record<TierSlug, TierPreset> = {
  starter: {
    slug: "starter",
    introHeader: "Starter includes:",
    features: [
      "30 GB pooled storage per person",
      "Custom business email @yourcompany",
      "Gemini AI in Gmail",
      "Gemini app access + NotebookLM",
      "100-participant video meetings",
      "Google Vids — AI video creation",
      "Workspace Studio automation",
      "Manage up to 300 users",
    ],
  },
  standard: {
    slug: "standard",
    isPopular: true,
    introHeader: "All of Starter, and:",
    features: [
      "2 TB pooled storage (65× more than Starter)",
      "Gemini in Docs, Meet, Sheets, Slides",
      "Expanded NotebookLM access",
      "150-participant meetings with recording",
      "Noise cancellation + auto-transcripts",
      "Custom email layouts + mail merge",
      "Appointment booking + eSignature in Docs",
      "Google Workspace Migrate tool",
    ],
  },
  plus: {
    slug: "plus",
    introHeader: "All of Standard, and:",
    features: [
      "5 TB pooled storage per person",
      "500-participant meetings with attendance tracking",
      "Enhanced security · S/MIME · DLP",
      "Vault retention + eDiscovery",
      "Advanced endpoint management",
      "Secure LDAP for legacy apps",
    ],
  },
  enterprise: {
    slug: "enterprise",
    introHeader: "All features, with:",
    features: [
      "5 TB pooled storage per person",
      "1,000-participant livestreaming",
      "S/MIME encryption",
      "Data Loss Prevention (DLP)",
      "Context-aware access policies",
      "Enterprise data regions",
      "Cloud Identity Premium",
      "Enhanced support for mission-critical issues",
    ],
  },
};

/** Slug a catalog item name into a known preset key. */
function slugFromName(name: string): TierSlug {
  if (/starter/i.test(name))    return "starter";
  if (/standard/i.test(name))   return "standard";
  if (/\bplus\b/i.test(name))   return "plus";
  if (/enterprise/i.test(name)) return "enterprise";
  return "standard";
}

/** Merge catalog rows with hardcoded presets to produce runtime tiers. */
export function buildTiers(catalog: CatalogItem[]): Tier[] {
  return catalog.map((item) => {
    const slug    = slugFromName(item.name);
    const preset  = TIER_PRESETS[slug];
    /* R-328 (7 Oct 2026, Pardeep): Business Plus has no price on the website — like Google's
       own page. Its card says "Contact us for pricing" and goes to the quote form; the server
       page already sends it with no figures and the checkout route refuses it. */
    const onRequest = slug === "enterprise" || isPublicPriceHiddenTier(slug);
    /* R-276: same floor as the server's order amount, so a stale row is never shown below list. */
    const annual  = tierAnnualPrice(slug, item.prices?.annual?.msrp ?? item.msrp);
    /* R-157: used to multiply the annual rate by 1.25 when no monthly existed — an invented rate. Only a real
       flexible price above the annual one is shown (a lower one is a stale catalogue row). */
    const flex = item.prices?.monthly?.msrp ?? null;
    const monthly = flex != null && flex > annual ? flex : null;
    return {
      id:           slug,
      catalogId:    item.id,
      name:         item.name.replace(/^Google Workspace\s*/i, "") || item.name,
      monthlyPrice: onRequest ? null : monthly,
      annualPrice:  onRequest ? null : annual,
      maxUsers:     slug === "enterprise" ? null : 300,
      isPopular:    preset.isPopular,
      cta:          slug === "enterprise" ? "Contact sales" : "Get a quote",
      introHeader:  preset.introHeader,
      features:     preset.features,
    };
  });
}

// NOTE: Business Base (₹99/user) is excluded — it's vendor-direct only,
// resellers cannot sell it. Customers wanting Base must buy from Google directly.
// R-2027 (27 Oct 2026): there are no typed fallback tiers any more. They priced the page
// when the catalogue read failed on a cold start — prices that go wrong the day the catalogue
// changes. The page now shows "Loading prices…" and fetches the catalogue (use-buy-catalog.ts),
// or says prices are not available online — never a price that is not the catalogue's.
