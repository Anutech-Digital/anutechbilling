/**
 * Site copy — the words, verbatim from the handoff. Copy IS design here: the positioning
 * doc (PROJECT_NOTES) is explicit that competitors are never named on the page; contrast is
 * always framed as "THEM: …" against our line.
 *
 * ⚠️ Client names, case-study figures and review quotes are PLACEHOLDERS to be replaced
 * with real ones before launch — the handoff marks them so.
 */
import { SLA } from "../config";

export const CATALOGUE = [
  { name: "Domains", from: "from ₹249/yr", body: "500+ extensions with register, renew and transfer prices on one row.", chips: ["500+ TLDS", "FREE DNS", "WHOIS PRIVACY"], href: "/domains" },
  { name: "Web hosting", from: "from ₹49.99/mo", body: "cPanel and LiteSpeed on NVMe, in Mumbai and Bengaluru.", chips: ["CPANEL", "LITESPEED", "99.9% SLA"], href: "/hosting" },
  { name: "Business email", from: "from ₹79/mo", body: "Anutech Mail, Google Workspace or Microsoft 365 — quoted side by side.", chips: ["NO SEAT MINIMUM", "FREE MIGRATION"], href: "/email" },
  { name: "SSL & security", from: "from ₹0", body: "Free DV on every site, wildcard and OV when a client needs the paperwork.", chips: ["DV", "OV", "WILDCARD"], href: "/ssl" },
  { name: "Reseller program", from: "₹0 to join", body: "Published wholesale rates with no slabs and no advance deposit.", chips: ["NO DEPOSIT", "ONE RATE", "WHITE LABEL"], href: "/reseller" },
  { name: "Migration desk", from: "free", body: "Sites, mail and DNS moved by us, outside your business hours.", chips: ["ANY SIZE", "ANY HOST", "OVERNIGHT"], href: "/contact" },
] as const;

export const CASES = [
  { tag: "AGENCY MIGRATION", headline: "Eleven client sites, one weekend", body: "A Mumbai studio left a reseller account that kept changing its rates. We moved every site, mailbox and DNS zone across two nights.", stats: [{ value: "11", label: "SITES MOVED" }, { value: "0 min", label: "DOWNTIME" }] },
  { tag: "EMAIL CONSOLIDATION", headline: "Forty mailboxes off a mixed estate", body: "A clinic group was paying for three different mail products. We quoted all three options, they picked two, and we merged the rest.", stats: [{ value: "40", label: "MAILBOXES" }, { value: "31%", label: "BILL REDUCED" }] },
  { tag: "PORTFOLIO TRANSFER", headline: "A 96-domain portfolio, in batches", body: "A freight company had names spread across four registrars with different expiry dates. Now they are on one invoice.", stats: [{ value: "96", label: "DOMAINS" }, { value: "1", label: "INVOICE" }] },
] as const;

export const TRUST = [
  { value: "12+ yrs", label: "RESELLING SINCE 2014" },
  /* Was an average-first-reply figure in minutes — nobody measures that (2 Oct 2026). */
  { value: "A person", label: "ANSWERS ON WHATSAPP", primary: true },
  { value: "99.9%", label: "UPTIME SLA, CREDITED" },
  { value: "₹0", label: "MIGRATION FEE, ANY SIZE" },
] as const;

/* REVIEWS removed 2 Oct 2026: three "Google review" quotes that were sample text, not reviews.
   Real ones go here only with a link to where the customer wrote them. */

/** Wholesale page: THEM vs us. Never a competitor's name. */
export const SWITCH_REASONS = [
  { them: "THEM: DEPOSIT FIRST, SEE YOUR RATE LATER", us: "Rate card published, ₹0 to join", body: "No advance deposit and no slab to buy into. The price you read today is the price on order one." },
  { them: "THEM: PRICING TIERS THAT MOVE WITH VOLUME", us: "One rate at every volume", body: "You never have to forecast next quarter's sales to know this quarter's cost. Quote clients with confidence." },
  { them: "THEM: RATES IN USD ON AN INDIAN SITE", us: "Billed in ₹, GST invoice every time", body: "No FX gap between quote and renewal. GSTIN on the invoice, input credit where you are eligible." },
  { them: "THEM: TICKET QUEUE AND A CHATBOT", us: "WhatsApp, and someone who knows your account", body: "A person replies in working hours, Mon–Sat. Migrations are done by us, not documented for you." },
] as const;

/** Why-us table. "ANUTECH DIGITAL" column renders on the dark band in --primary-on-dark. */
export const COMPARE_ROWS = [
  { label: "Seeing your price", us: "Published on this page", them: "After a deposit, inside a panel" },
  { label: "Joining fee", us: "₹0", them: "Advance deposit, often $25–$2,999" },
  { label: "Pricing structure", us: "One rate, every volume", them: "Volume slabs that move" },
  { label: "Currency", us: "₹, GST stated separately", them: "Often USD, GST unclear" },
  { label: "Renewal price", us: "Next to the first-year price", them: "Found at renewal time" },
  { label: "Migration", us: "Free, done by us", them: "A documentation article" },
  { label: "Support", us: "WhatsApp, answered by a person", them: "Ticket queue, chatbot first" },
  { label: "Who answers", us: "Someone who can change your account", them: "Tier-one, then escalation" },
  { label: "Datacentre", us: "Mumbai and Bengaluru", them: "Usually US, India optional" },
  { label: "Contract", us: "Monthly or yearly, cancel any time", them: "Tenure-locked promo pricing" },
] as const;

export const DOMAIN_FEATURES = [
  { title: "Anycast DNS", body: "Full record control with global anycast resolution. No add-on fee, no per-query billing." },
  { title: "WHOIS privacy", body: "Your client's details stay off the public record wherever the registry permits it." },
  { title: "Theft protection", body: "Registrar lock on by default. Transfers out need an authorisation you approve." },
  { title: "Auto-renew, your call", body: "On or off per domain. We chase you on WhatsApp thirty days before expiry either way." },
  { title: "Free email forwards", body: "Unlimited forwarders and a catch-all address before you buy a single mailbox." },
  { title: "Bulk operations", body: "Renew, update nameservers or edit contacts across a whole portfolio in one action." },
  { title: "Transfer help", body: "Send us a list. We pull auth codes and move a portfolio in batches, at no charge." },
  { title: "GST invoice", body: "Rupee pricing with 18% GST stated separately and GSTIN printed on every invoice." },
] as const;

export const EMAIL_FEATURES = [
  { title: "Free migration", body: `Mail, folders, contacts and calendars moved across — ${SLA.migration}.` },
  { title: "No seat minimum", body: "One mailbox is a valid order. Add and remove seats month to month." },
  { title: "Deliverability setup", body: "SPF, DKIM and DMARC configured and tested, not left as a support article." },
  { title: "Hosted in India", body: "Anutech Mail stays on Indian infrastructure. Useful when a client asks where data sits." },
  { title: "Works with your app", body: "Outlook, Apple Mail, Thunderbird, Gmail app. Standard protocols, no lock-in." },
  { title: "Quotes in 1 working day", body: `Send a headcount, get all three options priced side by side ${SLA.quote}.` },
  { title: "Retention and archive", body: "Configurable retention with recovery of deleted mail inside the window." },
  { title: "Mixed estates", body: "Run Workspace for sales and Anutech Mail for the rest. One invoice." },
] as const;

export const SECURITY_FEATURES = [
  { title: "When you do not need a paid cert", body: "A brochure site or a WordPress blog is fine on free DV. We will say so rather than sell you one." },
  { title: "Anti-spam both ways", body: "Inbound filtering plus outbound reputation monitoring, so a compromised mailbox does not burn your domain." },
  { title: "Weekly malware scan", body: "Every hosted site scanned weekly. If something is found we clean it and tell you how it got in." },
  { title: "Backups you can restore", body: "Daily to hourly depending on plan, restorable by you from cPanel or by us on WhatsApp." },
  { title: "Registrar lock by default", body: "Domains cannot be moved out without an authorisation you personally approve." },
  { title: "Two-factor on the panel", body: "TOTP on client accounts, and reseller sub-accounts scoped per client." },
] as const;

export const MAIL_OPTIONS = [
  { name: "Anutech Mail", who: "Most Indian SMBs", highlighted: true, cta: "Get a quote", lines: ["5 GB per mailbox, hosted in India", "IMAP, POP, ActiveSync", "Unlimited aliases and catch-all", "Anti-spam in and outbound"] },
  { name: "Google Workspace", who: "Teams living in Docs and Meet", highlighted: false, cta: "Get a quote", lines: ["30 GB per user, Drive included", "Docs, Sheets, Meet, Calendar", "India region pricing", "We handle DNS and setup"] },
  { name: "Microsoft 365", who: "Offices standardised on Outlook", highlighted: false, cta: "Get a quote", lines: ["50 GB mailbox, 1 TB OneDrive", "Outlook, Teams, web Office", "Works with existing AD", "Licence management by us"] },
] as const;

export const COMPANY_FACTS = [
  { label: "LEGAL NAME", value: "Anutech Digital Pvt Ltd" },
  { label: "FOUNDER", value: "Pardeep Sharma" },
  { label: "GSTIN", value: "07ABDCA0298H1ZP" },
  { label: "HSN CODE", value: "998313" },
  { label: "REGISTERED OFFICE", value: "Rohini, Delhi" },
  { label: "PARTNER STATUS", value: "Google Premier Partner, since 2014" },
  { label: "SUPPORT HOURS", value: "Mon–Sat, 10:00–19:00 IST" },
  { label: "PRODUCT", value: "ResellerOS · resellersos.in" },
] as const;

export const PROOF_POINTS = [
  "Published prices, renewal shown up front",
  "GST invoice on every order",
  "Free migration, done by us",
  "WhatsApp support from a person",
] as const;
