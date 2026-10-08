/**
 * One Google Ads landing page per Google Workspace plan (Pardeep, 4 Oct 2026: "google
 * workspace ke har product ka ek ek page banao"). Facts per plan (storage, Meet size) live
 * here; prices come from the live catalogue at request time.
 *
 * Only Business Starter carries the first-year offer — it is the only plan with a known
 * lower new-account cost (lib/workspace-offer.ts). The others lead with free setup,
 * migration and the 14-day trial, never an invented discount. Base is not here: resellers
 * cannot sell it.
 *
 * The page's WORDS per plan (hero, benefits, includes, user limit, Free Gmail comparison)
 * moved to components/lp/lp-copy.ts in R-396, in English and Hinglish. Facts stay here.
 */

export type LpPlanKey = "starter" | "standard" | "plus" | "enterprise";

export interface LpPlan {
  key: LpPlanKey;
  /** "Business Starter" */
  name: string;
  /** Edition name in the website catalogue (null = no list price: talk to us). */
  edition: string | null;
  /** Whether the Starter first-year offer applies (30+ users, new account). */
  offer: boolean;
  storage: string;
  meetPeople: string;
  /** Landing path (variant 1) and its page title in the app's list. */
  path: string;
  /** The all-plans category page: leads say "google-workspace", not one plan. */
  category?: boolean;
}

export const LP_PLANS: Record<LpPlanKey, LpPlan> = {
  starter: {
    key: "starter", name: "Business Starter", edition: "GW Business Starter", offer: true,
    storage: "30 GB per user", meetPeople: "Up to 100 people",
    path: "/lp/google-workspace-business-starter-1",
  },
  standard: {
    key: "standard", name: "Business Standard", edition: "GW Business Standard", offer: false,
    storage: "2 TB per user", meetPeople: "Up to 150 people + recordings",
    path: "/lp/google-workspace-business-standard-1",
  },
  plus: {
    key: "plus", name: "Business Plus", edition: "GW Business Plus", offer: false,
    storage: "5 TB per user", meetPeople: "Up to 500 people",
    path: "/lp/google-workspace-business-plus-1",
  },
  enterprise: {
    key: "enterprise", name: "Enterprise", edition: null, offer: false,
    storage: "5 TB per user, more on request", meetPeople: "Up to 1,000 people",
    path: "/lp/google-workspace-enterprise-1",
  },
};

/**
 * The Google Workspace category page (R-154, 5 Oct 2026): broad "google workspace" ads land
 * here. It leads with the Starter offer (the plan most small businesses buy) and lists every
 * plan below, so it borrows Starter's facts for the price card (hero words: lp-copy.ts
 * categoryHero).
 */
export const LP_CATEGORY: LpPlan = {
  ...LP_PLANS.starter,
  category: true,
  path: "/lp/google-workspace-1",
};

/** Plan order on the category page. */
export const LP_PLAN_ORDER: readonly LpPlanKey[] = ["starter", "standard", "plus", "enterprise"];
