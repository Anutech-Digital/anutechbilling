/**
 * R-1970 (26 Oct 2026, Pardeep's design v2) — what the /buy/workspace page shows per plan, and
 * its sums. Prices come from the catalogue (page.tsx → buildTiers in buy-workspace-client.tsx);
 * this file only adds the plan copy and the maths the cards, the price card and the checkout
 * summary share, so they can never disagree.
 *
 * Money: the annual sum IS annualTotals() (R-276, the server's sum — Starter 1 user =
 * 3,240 + 583 = 3,823). Monthly is users × the monthly rate for ONE month, GST 18% on top.
 * Display only — the checkout route prices every order again from the catalogue.
 */
import { annualTotals } from "../tier-price";
import { SLA } from "@/site/lib/config";

export type Billing = "annual" | "monthly";
export type PlanId = "starter" | "standard" | "plus" | "enterprise";

/** Business plans stop at 300 users (Google's cap); above that it is Enterprise. */
export const BUSINESS_MAX_USERS = 300;
export const SEAT_PRESETS = [5, 10, 25, 50] as const;
export const MAX_SEATS = 10_000;

/** One plan as the page sees it. A null rate = not sold online at that billing. */
export interface BuyPlan {
  id: PlanId;
  name: string;           // "Business Starter" — PLAN_COPY.name (R-1986), display only
  short: string;          // "Starter"
  blurb: string;
  features: string[];
  popular: boolean;
  annual: number | null;  // ₹/user/month on the annual plan, before GST
  monthly: number | null; // ₹/user/month on the monthly plan, before GST
  /** R-328: the price is not shown to a website visitor (Business Plus) — quote only. */
  priceHidden: boolean;
  /** Enterprise: always a written quote. */
  custom: boolean;
}

/**
 * R-1986 (Pardeep, 26 Oct 2026): `name` is Google's full plan name — "Business Starter",
 * "Business Standard", "Business Plus", "Enterprise" — the ONE source for every label on the buy
 * page and checkout (cards, buttons, price card, compare header, summary, phone bar). `short` is
 * only for a place too narrow for it (the price card's plan switch on a phone). Display only:
 * catalogue item names and the server's quote lines are not read from here.
 */
interface PlanCopy { name: string; short: string; blurb: string; features: string[]; popular?: boolean }

export const PLAN_COPY: Record<PlanId, PlanCopy> = {
  starter: {
    name: "Business Starter",
    short: "Starter",
    blurb: "Professional email and the core apps for small teams.",
    features: ["Email on your own domain", "30 GB storage per user", "Meet calls up to 100 people", "Gemini in Gmail"],
  },
  standard: {
    name: "Business Standard",
    short: "Standard",
    popular: true,
    blurb: "More storage, meeting recordings and Gemini across every app.",
    features: ["2 TB storage per user", "Meet up to 150 people, with recording", "Gemini in Docs, Sheets, Slides and Meet", "Booking pages and eSignature"],
  },
  plus: {
    name: "Business Plus",
    short: "Plus",
    blurb: "Archiving and stronger security for regulated businesses.",
    features: ["5 TB storage per user", "Meet up to 500 people, attendance tracking", "Vault retention and eDiscovery", "Advanced endpoint management"],
  },
  enterprise: {
    name: "Enterprise",
    short: "Enterprise",
    blurb: "For 300+ users or strict compliance requirements.",
    features: ["5 TB+ storage per user", "Livestreams up to 1,000 people", "Data loss prevention, data regions", "Context-aware access"],
  },
};

/**
 * R-1988 (Pardeep, 26 Oct 2026): the media slot per priced plan card. R-2031 (27 Oct): Pardeep's
 * "Google Workspace + apps" image (public/buy/workspace-apps.webp, 1536×1024) on both Starter and
 * Standard in place of the YouTube video. A plan with no entry shows three feature highlights.
 */
const WORKSPACE_APPS_IMAGE = {
  src: "/buy/workspace-apps.webp",
  width: 1536,
  height: 1024,
  alt: "Google Workspace apps: Gmail, Drive, Docs, Sheets, Slides, Meet, Calendar",
} as const;
export const PLAN_MEDIA: Partial<Record<PlanId, { src: string; width: number; height: number; alt: string }>> = {
  starter: WORKSPACE_APPS_IMAGE,
  standard: WORKSPACE_APPS_IMAGE,
};

const ORDER: PlanId[] = ["starter", "standard", "plus", "enterprise"];

/** The tiers the page built from the catalogue, as plans — in Starter → Enterprise order. */
export function toBuyPlans(
  tiers: ReadonlyArray<{ id: string; name: string; annualPrice: number | null; monthlyPrice: number | null }>,
  isHidden: (id: string) => boolean,
): BuyPlan[] {
  const plans: BuyPlan[] = [];
  for (const id of ORDER) {
    const t = tiers.find((x) => x.id === id);
    /* Enterprise is never a catalogue "main" row (it is an upgrade add-on), but it is always
       on offer as a quote — so its card is there even when the catalogue has no row. */
    if (!t && id !== "enterprise") continue;
    const copy = PLAN_COPY[id];
    const hidden = id !== "enterprise" && isHidden(id);
    const custom = id === "enterprise";
    plans.push({
      id,
      name: copy.name,
      short: copy.short,
      blurb: copy.blurb,
      features: copy.features,
      popular: !!copy.popular,
      annual: custom || hidden ? null : (t?.annualPrice ?? null),
      monthly: custom || hidden ? null : (t?.monthlyPrice ?? null),
      priceHidden: hidden,
      custom,
    });
  }
  return plans;
}

/** Can this plan be priced (and so bought online) at this billing? */
export function planRate(plan: BuyPlan, billing: Billing): number | null {
  return billing === "annual" ? plan.annual : plan.monthly;
}

export interface PlanSum {
  rate: number;      // ₹/user/month
  months: 1 | 12;
  subtotal: number;  // pre-GST, what one bill charges
  gst: number;       // 18%
  total: number;
}

/** The bill for `seats` users: a year up front (annual) or one month (monthly). */
export function planSum(plan: BuyPlan, seats: number, billing: Billing): PlanSum | null {
  const rate = planRate(plan, billing);
  if (rate == null) return null;
  if (billing === "annual") {
    const { annual, gst, total } = annualTotals(seats, rate);
    return { rate, months: 12, subtotal: annual, gst, total };
  }
  const subtotal = seats * rate;
  const gst = Math.round(subtotal * 0.18);
  return { rate, months: 1, subtotal, gst, total: subtotal + gst };
}

/** Monthly is offered only when every priced plan has a real monthly rate (R-157). */
export function monthlyOffered(plans: BuyPlan[]): boolean {
  const priced = plans.filter((p) => p.annual != null);
  return priced.length > 0 && priced.every((p) => p.monthly != null);
}

/** The real annual saving over monthly, rounded — "save 17%" (never a typed number). */
export function annualSavingPct(plans: BuyPlan[]): number {
  const pcts = plans
    .filter((p) => p.annual != null && p.monthly != null && p.monthly > 0)
    .map((p) => Math.round((1 - (p.annual as number) / (p.monthly as number)) * 100));
  return pcts.length ? Math.max(0, ...pcts) : 0;
}

export function usersLabel(n: number): string {
  return `${n.toLocaleString("en-IN")} ${n === 1 ? "user" : "users"}`;
}

export function clampSeats(n: number): number {
  return Math.max(1, Math.min(MAX_SEATS, Math.round(Number.isFinite(n) ? n : 1) || 1));
}

/** Compare table: a single-cell row is a category heading. */
export const COMPARE_ROWS: ReadonlyArray<readonly string[]> = [
  ["Email, storage and meetings"],
  ["Email on your own domain", "✓", "✓", "✓", "✓"],
  ["Storage per user (pooled)", "30 GB", "2 TB", "5 TB", "5 TB+"],
  ["Meet participants", "100", "150", "500", "1,000"],
  ["Meeting recording to Drive", "—", "✓", "✓", "✓"],
  ["Noise cancellation", "—", "✓", "✓", "✓"],
  ["Booking pages and eSignature", "—", "✓", "✓", "✓"],
  ["Livestreaming", "—", "—", "—", "✓"],
  ["Gemini AI"],
  ["Gemini in Gmail", "✓", "✓", "✓", "✓"],
  ["Gemini in Docs, Sheets, Slides, Meet", "—", "✓", "✓", "✓"],
  ["NotebookLM", "Basic", "Expanded", "Expanded", "Expanded"],
  ["Security and admin"],
  ["2-step verification, admin console", "✓", "✓", "✓", "✓"],
  ["Endpoint management", "Basic", "Basic", "Advanced", "Enterprise"],
  ["Vault retention and eDiscovery", "—", "—", "✓", "✓"],
  ["Secure LDAP", "—", "—", "✓", "✓"],
  ["Data loss prevention, data regions", "—", "—", "—", "✓"],
];

/**
 * "What happens after you pay" — today's promises (DECISIONS 6), all from the site's ONE
 * SLA table: call/WhatsApp within 4 working hours, live within 1 working day of DNS check.
 */
export const AFTER_PAY_STEPS: ReadonlyArray<{ when: string; what: string }> = [
  { when: "Right away", what: "Payment receipt and your GST tax invoice by email" },
  { when: `Within ${SLA.short.firstReply}`, what: "We call or WhatsApp you to confirm your domain and any email to move" },
  { when: "Your DNS step", what: "You add the one DNS record we send; we verify your domain with you" },
  { when: `Within ${SLA.short.workspaceLive}`, what: `Your team's email is live — ${SLA.workspaceLive}` },
  { when: "If you are switching", what: `Old email, contacts and calendars moved across — ${SLA.migration}` },
];
