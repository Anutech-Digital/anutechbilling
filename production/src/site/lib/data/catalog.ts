/**
 * Every rate card on the site, copied from the handoff's `renderVals()` — NOT invented.
 *
 * ⚠️ ALL FIGURES ARE PLACEHOLDERS. The handoff says so in bold: "all prices … are
 * placeholders. They must be replaced with Anutech's real rate card … before launch."
 * They live in this one module so that replacing them is a one-file edit, and so a test
 * can count that no component carries a price of its own.
 */

export interface Tld {
  tld: string;
  reg: number;
  renew: number;
  transfer: number;
  use: string;
  group: "Popular" | "Business" | "Tech";
}

export const TLDS: readonly Tld[] = [
  { tld: ".in", reg: 499, renew: 799, transfer: 649, use: "Indian businesses", group: "Popular" },
  { tld: ".com", reg: 899, renew: 1199, transfer: 999, use: "Anything, anywhere", group: "Popular" },
  { tld: ".co.in", reg: 599, renew: 899, transfer: 749, use: "Registered companies", group: "Popular" },
  { tld: ".org", reg: 1099, renew: 1299, transfer: 1149, use: "Trusts and NGOs", group: "Popular" },
  { tld: ".net", reg: 1199, renew: 1399, transfer: 1249, use: "Infra and services", group: "Popular" },
  { tld: ".store", reg: 249, renew: 4199, transfer: 3899, use: "D2C and retail", group: "Business" },
  { tld: ".shop", reg: 299, renew: 2899, transfer: 2699, use: "Online stores", group: "Business" },
  { tld: ".company", reg: 799, renew: 1499, transfer: 1399, use: "New ventures", group: "Business" },
  { tld: ".agency", reg: 1899, renew: 2199, transfer: 2049, use: "Studios and agencies", group: "Business" },
  { tld: ".dev", reg: 1499, renew: 1599, transfer: 1549, use: "Developer projects", group: "Tech" },
  { tld: ".io", reg: 3899, renew: 4299, transfer: 4099, use: "SaaS and startups", group: "Tech" },
  { tld: ".ai", reg: 6999, renew: 7499, transfer: 7199, use: "AI products", group: "Tech" },
  { tld: ".cloud", reg: 899, renew: 1799, transfer: 1699, use: "Platforms and APIs", group: "Tech" },
  { tld: ".app", reg: 1299, renew: 1499, transfer: 1399, use: "Mobile and web apps", group: "Tech" },
] as const;

/* R-224 (7 Oct 2026): HOSTING_PLANS / HOSTING_SPECS (three old placeholder plans at
   ₹159–₹999) were removed — hosting is priced ONLY by HOSTING_TIERS in
   hosting-landing-v2.ts (from LANDING_PLANS), which /hosting, /rates, the cart and /quote use. */

/** ₹/mailbox/month. */
export const MAIL_RATES: Readonly<Record<string, number>> = {
  "Anutech Mail": 79,
  "Google Workspace": 165,
  "Microsoft 365": 185,
};

export interface LicenceEdition {
  name: string;
  note: string;
  /** ₹/seat/month on annual commitment. */
  annual: number;
  /** ₹/seat/month on flexible monthly. */
  monthly: number;
}

/** The email-page licence calculator's six editions. */
export const LICENCE_EDITIONS: readonly LicenceEdition[] = [
  /* R-157 (5 Oct 2026): GW fallbacks brought to the current list (they were Google's old
     ₹136 / ₹736). Used only when the live catalogue cannot be read. */
  { name: "GW Business Starter", note: "30 GB per user", annual: 270, monthly: 325 },
  { name: "GW Business Standard", note: "2 TB per user, recordings", annual: 1080, monthly: 1300 },
  { name: "GW Business Plus", note: "5 TB, Vault, eDiscovery", annual: 1380, monthly: 1620 },
  { name: "M365 Business Basic", note: "Web Office, 50 GB mail", annual: 145, monthly: 175 },
  { name: "M365 Business Standard", note: "Desktop Office, 1 TB", annual: 770, monthly: 900 },
  { name: "Zoho Workplace", note: "Mail + Office suite", annual: 90, monthly: 110 },
] as const;

export interface Cert {
  name: string;
  who: string;
  price: string;
  unit: string;
  highlighted: boolean;
  lines: readonly string[];
  cta: string;
  /** Numeric price when it can be added to cart; null routes to quote/hosting. */
  addPrice: number | null;
}

export const CERTS: readonly Cert[] = [
  { name: "Free DV", who: "Every site we host", price: "₹0", unit: "", highlighted: true, cta: "Included", addPrice: null, lines: ["Auto-issued and auto-renewed", "Padlock in every browser", "Wildcard on Plus"] },
  { name: "Positive SSL", who: "A single domain", price: "₹899", unit: "/yr", highlighted: false, cta: "Get a quote", addPrice: 899, lines: ["Domain validation, minutes", "₹50k relying-party warranty", "Reissue any time"] },
  { name: "Wildcard", who: "Every subdomain", price: "₹4,499", unit: "/yr", highlighted: false, cta: "Get a quote", addPrice: 4499, lines: ["Covers *.yourdomain.in", "One cert, unlimited subdomains", "Fits multi-client setups"] },
  { name: "OV / EV", who: "When a client needs paperwork", price: "₹6,999", unit: "/yr", highlighted: false, cta: "Talk to us", addPrice: null, lines: ["Organisation vetting by the CA", "Company name on the cert", "We handle the documents"] },
] as const;

export interface EditionMatrix {
  cols: readonly [string, string, string];
  note: string;
  rows: readonly (readonly [string, string, string, string])[];
}

/** Compare-editions page: three suites, 11 rows each. "—" = absent, --text-disabled. */
export const EDITION_MATRICES: Readonly<Record<string, EditionMatrix>> = {
  "Google Workspace": {
    cols: ["BUSINESS STARTER", "BUSINESS STANDARD", "BUSINESS PLUS"],
    note: "Google caps Business editions at 300 users. Above that it is Enterprise — talk to us.",
    rows: [
      ["Price per seat, annual", "₹270/mo", "₹1,080/mo", "₹1,380/mo"],
      ["Storage per user", "30 GB", "2 TB", "5 TB"],
      ["Custom email on your domain", "Yes", "Yes", "Yes"],
      ["Meet participants", "100", "150", "500"],
      ["Meeting recordings to Drive", "—", "Yes", "Yes"],
      ["Attendance tracking", "—", "—", "Yes"],
      ["Shared drives for teams", "—", "Yes", "Yes"],
      ["Vault — retention & eDiscovery", "—", "—", "Yes"],
      ["Advanced endpoint management", "—", "—", "Yes"],
      ["Secure LDAP", "—", "—", "Yes"],
      ["User cap", "300", "300", "300"],
    ],
  },
  "Microsoft 365": {
    cols: ["BUSINESS BASIC", "BUSINESS STANDARD", "BUSINESS PREMIUM"],
    note: "Desktop Office apps start at Standard. Premium adds Intune and Defender for Business.",
    rows: [
      ["Price per seat, annual", "₹145/mo", "₹770/mo", "₹1,540/mo"],
      ["Mailbox size", "50 GB", "50 GB", "50 GB"],
      ["OneDrive per user", "1 TB", "1 TB", "1 TB"],
      ["Web and mobile Office", "Yes", "Yes", "Yes"],
      ["Desktop Office apps", "—", "Yes", "Yes"],
      ["Teams meetings and webinars", "Yes", "Yes", "Yes"],
      ["Intune device management", "—", "—", "Yes"],
      ["Defender for Business", "—", "—", "Yes"],
      ["Azure Information Protection", "—", "—", "Yes"],
      ["Works with existing AD", "Yes", "Yes", "Yes"],
      ["User cap", "300", "300", "300"],
    ],
  },
  Zoho: {
    cols: ["MAIL LITE", "WORKPLACE STANDARD", "ZOHO ONE"],
    note: "Zoho is the value option and an Indian company. Weakest choice if you depend on Google or Microsoft file formats.",
    rows: [
      ["Price per seat, annual", "₹59/mo", "₹90/mo", "₹1,299/mo"],
      ["Mailbox size", "5 GB", "30 GB", "100 GB"],
      ["Office suite — Writer, Sheet, Show", "—", "Yes", "Yes"],
      ["Cliq chat and Meeting", "—", "Yes", "Yes"],
      ["WorkDrive team storage", "—", "Yes", "Yes"],
      ["CRM and Books included", "—", "—", "Yes"],
      ["40+ business apps", "—", "—", "Yes"],
      ["eDiscovery and retention", "—", "Add-on", "Yes"],
      ["Data centre in India", "Yes", "Yes", "Yes"],
      ["Works with Outlook", "Yes", "Yes", "Yes"],
      ["User cap", "None", "None", "None"],
    ],
  },
};

/** "Six situations, six answers" on the compare page. */
export const PICK_GUIDES = [
  { when: "Under 10 people, mail and Drive only", pick: "Business Starter or M365 Basic", why: "You will not use recordings or Vault. 30 GB per person is enough until people start storing video." },
  { when: "You run client calls and need recordings", pick: "Business Standard", why: "Meet recordings, 150-participant meetings and 2 TB per user. This is where most Indian SMBs land." },
  { when: "You need retention, eDiscovery or audit", pick: "Business Plus", why: "Vault, advanced endpoint management and 5 TB. Buy it only if compliance or a client contract demands it." },
  { when: "The office lives in Excel and Outlook", pick: "M365 Business Standard", why: "Desktop Office apps and 1 TB OneDrive per person. Cheaper than retraining everyone onto Sheets." },
  { when: "Tight budget, small team, Indian stack", pick: "Zoho Workplace", why: "Mail plus an office suite at a third of the price. Weakest if you depend on Google or Microsoft file formats." },
  { when: "Mixed needs across departments", pick: "Two editions on one domain", why: "Standard for sales, Starter for the rest. We split it and you still get one GST invoice." },
] as const;

/** Wholesale margin-calculator assumptions (₹, per unit per month or per year as labelled). */
export const MARGIN = {
  domains: { cost: 649, retail: 899, perUnit: 250, label: "Domains (.com)" },
  sites: { cost: 359, retail: 599, perUnit: 240, label: "Hosting / site" },
  mailboxes: { cost: 79, retail: 129, perUnit: 50, label: "Mailboxes" },
} as const;
