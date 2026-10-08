/**
 * The marketing tools a Google Workspace / Microsoft 365 reseller that also builds custom
 * software should run — and, for each, why and how it connects to this app.
 *
 * Pardeep, 26 Sep 2026: "jo tools mere paas hone chahiye is business ko chalane ke liye,
 * unko use karne ka ek system banao". This list is the advice half of Marketing → Hub; the
 * per-company state (set up? who runs it? budget?) is the `marketing_tools` table. The
 * catalogue lives in code so a better "why" reaches every company without a migration.
 *
 * `channel` is the ad-spend / lead-source key (lib/marketing/ad-channels.ts,
 * lib/leads/lead-sources.ts). Where a tool has one, the Hub sets its monthly budget
 * against this month's actual spend on that channel and links a tracking link to it.
 */

export type ToolGroup = "ads" | "listings" | "messaging" | "website" | "email" | "social";

export const TOOL_GROUPS: Record<ToolGroup, { title: string; why: string }> = {
  ads:       { title: "Paid ads",              why: "Paid leads — spend and ROAS are both counted here" },
  listings:  { title: "Listings & marketplaces", why: "Be seen where people search" },
  messaging: { title: "WhatsApp & calling",    why: "Talk to leads — most deals close here" },
  email:     { title: "Email",                 why: "Remind past leads and customers" },
  website:   { title: "Website & tracking",    why: "Capture every lead's source" },
  social:    { title: "Social (organic)",      why: "Build trust — free reach" },
};

export interface MarketingTool {
  key: string;
  name: string;
  group: ToolGroup;
  /** One or two lines: why this business needs it. Plain English (app UI copy). */
  why: string;
  /** Where the account lives, for the "open" button before an account URL is saved. */
  homeUrl: string;
  /** Spend / lead-source channel key, when the tool is one. */
  channel?: string;
  /** Where in this app the tool's work is done or measured. */
  inApp: { href: string; label: string }[];
  /** First things to do once, in order. */
  setup: string[];
}

export const MARKETING_TOOLS: readonly MarketingTool[] = [
  // ── Paid ads ──────────────────────────────────────────────────────────────
  {
    key: "meta-ads", name: "Meta Ads Manager (Facebook / Instagram)", group: "ads", channel: "meta-ads",
    why: "The cheapest way to target local businesses for Workspace / email. Lead form or click-to-WhatsApp ads.",
    homeUrl: "https://adsmanager.facebook.com",
    inApp: [
      { href: "/marketing/links", label: "Tracking link for the ad" },
      { href: "/accounting/prepaid", label: "Top-up (advance) and monthly invoice" },
      { href: "/marketing/spend", label: "Spend" },
    ],
    setup: [
      "Create a Business Manager and add a payment method (it works on advance top-ups)",
      "Build every ad's link in Tracking links — the lead source is set automatically",
      "In Banking reconcile, mark top-ups as \"Advance / prepaid\"; book the monthly invoice on Prepaid",
    ],
  },
  {
    key: "google-ads", name: "Google Ads", group: "ads", channel: "google-ads",
    why: "People searching \"Google Workspace price\" or \"business email\" right now — the hottest leads.",
    homeUrl: "https://ads.google.com",
    inApp: [
      { href: "/marketing/links", label: "Tracking link for the ad" },
      { href: "/marketing/reports", label: "ROAS & CAC" },
    ],
    setup: [
      "Search campaign with keywords like \"google workspace price\", \"business email india\"",
      "Build the final URL in Tracking links",
      "Book Google's monthly invoice in Expenses under Advertising → Google Ads channel",
    ],
  },
  {
    key: "linkedin-ads", name: "LinkedIn Ads", group: "ads", channel: "linkedin-ads",
    why: "For large custom software / ERP deals — decision makers are here. Expensive, so start with a small budget.",
    homeUrl: "https://www.linkedin.com/campaignmanager",
    inApp: [{ href: "/marketing/links", label: "Tracking link" }],
    setup: ["Create the company page first", "Small test budget, only for projects (custom software)"],
  },
  // ── Listings ─────────────────────────────────────────────────────────────
  {
    key: "google-business", name: "Google Business Profile", group: "listings", channel: "google-organic",
    why: "Show up on the map for \"IT company near me\" — free. Reviews land here, and new customers look here first.",
    homeUrl: "https://business.google.com",
    inApp: [{ href: "/marketing/reviews", label: "Ask customers for reviews" }, { href: "/marketing/links", label: "Tracking link for the website button" }],
    setup: ["Verify the profile (address + phone)", "Save the \"Ask for reviews\" link on the Google reviews page", "Ask for a review after every project / setup", "Build the website link in Tracking links"],
  },
  {
    key: "indiamart", name: "IndiaMART", group: "listings", channel: "indiamart",
    why: "B2B buyers send requirements directly. It is a paid package, so measure both leads and deals won.",
    homeUrl: "https://seller.indiamart.com",
    inApp: [{ href: "/marketing/indiamart", label: "CRM key — automatic leads" }, { href: "/marketing/spend", label: "Package spend" }],
    setup: ["Products: Google Workspace, Microsoft 365, custom software", "Save the Lead Manager CRM key in Marketing Hub → IndiaMART leads — enquiries become leads automatically", "Set the source of manually added IndiaMART leads to \"IndiaMART\"", "Book the package payment in Expenses → Advertising → IndiaMART"],
  },
  {
    key: "justdial", name: "JustDial", group: "listings", channel: "justdial",
    why: "Phone calls from local search. On a paid listing, track its spend against leads.",
    homeUrl: "https://www.justdial.com/Free-Listing",
    inApp: [{ href: "/leads", label: "Set lead source to \"JustDial\"" }],
    setup: ["Start with the free listing", "Set the source of every JustDial call to \"JustDial\""],
  },
  // ── Messaging ────────────────────────────────────────────────────────────
  {
    key: "whatsapp-business", name: "WhatsApp Business (API)", group: "messaging", channel: "whatsapp",
    why: "Instant replies to leads, quotes and follow-ups. The app's WhatsApp inbox runs on it.",
    homeUrl: "https://business.facebook.com/wa/manage",
    inApp: [{ href: "/whatsapp", label: "WhatsApp inbox" }, { href: "/marketing/whatsapp", label: "Broadcast + templates" }, { href: "/marketing/whatsapp/reminders", label: "Renewal / invoice reminders" }, { href: "/automation", label: "Auto follow-up" }],
    setup: ["Verify the WhatsApp Business number on Meta", "Connect it in the app (Settings) — fill in the Business Account ID too", "Submit the starter templates on Meta, then Sync from Meta once approved", "Broadcast only to people who know you"],
  },
  // ── Email ────────────────────────────────────────────────────────────────
  {
    key: "email-campaigns", name: "Email campaigns (in-app)", group: "email", channel: "email-outreach",
    why: "Offers for past leads and reminders before renewals. Sent from the app — no separate tool needed.",
    homeUrl: "/campaigns",
    inApp: [{ href: "/campaigns", label: "Email campaigns" }, { href: "/coupons", label: "Offer coupon code" }],
    setup: ["Verify the sending domain (Resend) so mail does not land in spam", "Every mail gets an unsubscribe link automatically — do not remove it"],
  },
  // ── Website ──────────────────────────────────────────────────────────────
  {
    key: "search-console", name: "Google Search Console", group: "website", channel: "google-organic",
    why: "Which search terms bring up your website on Google — the free first step of SEO.",
    homeUrl: "https://search.google.com/search-console",
    inApp: [{ href: "/lead-gen", label: "Lead sources" }],
    setup: ["Verify the website", "Submit the sitemap"],
  },
  {
    key: "ga4", name: "Google Analytics 4", group: "website",
    why: "How many people visited the website, from where, and how many filled the form.",
    homeUrl: "https://analytics.google.com",
    inApp: [],
    setup: ["Create a property and add the tag to the website", "Mark the enquiry form submit as a conversion"],
  },
  // ── Social ───────────────────────────────────────────────────────────────
  {
    key: "facebook-page", name: "Facebook / Instagram page", group: "social", channel: "meta-organic",
    why: "Work photos and customer reviews — people who see an ad check the page first.",
    homeUrl: "https://business.facebook.com",
    inApp: [{ href: "/marketing/links", label: "Tracking link for posts" }],
    setup: ["2 posts a week: one project, one tip", "Build the bio link in Tracking links"],
  },
  {
    key: "linkedin-page", name: "LinkedIn company page", group: "social", channel: "linkedin-organic",
    why: "Custom software clients check the company here.",
    homeUrl: "https://www.linkedin.com/company/setup/new",
    inApp: [{ href: "/marketing/links", label: "Tracking link for posts" }],
    setup: ["Create the page and add the team", "Post a case study for every project"],
  },
];

export type ToolStatus = "not_started" | "setting_up" | "active" | "paused" | "not_needed";

export const TOOL_STATUS: Record<ToolStatus, { label: string; kind: "muted" | "warning" | "success" | "info" }> = {
  not_started: { label: "Not started",  kind: "muted" },
  setting_up:  { label: "Setting up",   kind: "warning" },
  active:      { label: "Active",       kind: "success" },
  paused:      { label: "Paused",       kind: "info" },
  not_needed:  { label: "Not needed",   kind: "muted" },
};

export interface ToolState {
  tool_key: string;
  status: ToolStatus;
  account_url: string | null;
  owner_name: string | null;
  monthly_budget: number;
  notes: string | null;
}

export interface ToolRow extends MarketingTool {
  state: ToolState;
  /** This month's recorded spend on the tool's channel, or null when it has no channel. */
  spentThisMonth: number | null;
}

/** Catalogue + saved state + this month's spend → one row per tool, catalogue order. */
export function mergeTools(
  saved: ToolState[],
  spendByChannel: Record<string, number>,
): ToolRow[] {
  const byKey = new Map(saved.map((s) => [s.tool_key, s]));
  return MARKETING_TOOLS.map((t) => ({
    ...t,
    state: byKey.get(t.key) ?? {
      tool_key: t.key, status: "not_started", account_url: null, owner_name: null, monthly_budget: 0, notes: null,
    },
    spentThisMonth: t.channel ? (spendByChannel[t.channel] ?? 0) : null,
  }));
}

/** The Hub's headline: how many tools are live, and budget against spend. */
export function hubSummary(rows: ToolRow[]) {
  const counted = rows.filter((r) => r.state.status !== "not_needed");
  return {
    active: counted.filter((r) => r.state.status === "active").length,
    total: counted.length,
    budget: rows.reduce((s, r) => s + (r.state.status === "active" ? r.state.monthly_budget : 0), 0),
    /* Once per channel: Google Business Profile and Search Console share google-organic,
       and adding both would count that spend twice. */
    spent: [...new Map(rows.filter((r) => r.channel).map((r) => [r.channel!, r.spentThisMonth ?? 0])).values()]
      .reduce((s, v) => s + v, 0),
    overBudget: rows.filter((r) => r.state.monthly_budget > 0 && (r.spentThisMonth ?? 0) > r.state.monthly_budget),
  };
}
