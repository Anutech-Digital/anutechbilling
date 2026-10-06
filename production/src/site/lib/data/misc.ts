/**
 * Support KB, status services, demo client-area data and the legal drafts — from the handoff.
 *
 * The legal blocks are marked on-page as counsel-review drafts, exactly as the handoff wrote
 * them ("Placeholder draft — have your counsel review before publishing"). Do not quietly
 * drop that sentence: it is the difference between a draft and a representation.
 */

export const KB_ARTICLES = [
  { title: "How to point your domain at our nameservers", cat: "DOMAINS" },
  { title: "Transferring a domain in: auth codes and timelines", cat: "DOMAINS" },
  { title: "Setting up SPF, DKIM and DMARC correctly", cat: "EMAIL" },
  { title: "Migrating mailboxes from Google Workspace", cat: "EMAIL" },
  { title: "Restoring a site from a daily backup", cat: "HOSTING" },
  { title: "Forcing HTTPS on a cPanel site", cat: "HOSTING" },
  { title: "Creating a cPanel account for a client in WHM", cat: "RESELLER" },
  { title: "Reading your GST invoice and claiming input credit", cat: "BILLING" },
  { title: "What happens if a domain expires", cat: "BILLING" },
] as const;

/* 30 Sep 2026: these cards said the migration desk confirms "on WhatsApp" (the site's
   WhatsApp number is still a placeholder) and that SLA credits are "applied automatically"
   (nothing measures uptime yet). They now say only what happens. */
export const SUPPORT_CHANNELS = [
  { title: "Moving from another host or mail provider", body: "Free. Email us what you have today and where it is, and we schedule the move with you." },
  { title: "Bills and GST invoices", body: "Every order is billed by Anutech Digital in your business name. Ask for a copy of any bill by email." },
  { title: "Renewals", body: "We email you before anything expires. Renew from the client area, or reply to the reminder." },
] as const;

export interface StatusService {
  name: string;
  note: string;
  uptime: string;
  /** Indexes (0–29) of degraded 3-day bars. */
  bad: readonly number[];
}

export const STATUS_SERVICES: readonly StatusService[] = [
  { name: "Shared hosting · Mumbai", note: "LiteSpeed cluster", uptime: "99.98%", bad: [] },
  { name: "Shared hosting · Bengaluru", note: "LiteSpeed cluster", uptime: "99.99%", bad: [] },
  { name: "Anutech Mail", note: "IMAP, SMTP, webmail", uptime: "99.96%", bad: [17] },
  { name: "Anycast DNS", note: "Authoritative resolution", uptime: "100%", bad: [] },
  { name: "Client area & billing", note: "Panel and invoices", uptime: "99.93%", bad: [4, 22] },
  { name: "Domain registry API", note: "Register, renew, transfer", uptime: "99.97%", bad: [28] },
] as const;

/* ── Demo client area (explicitly demo data in the handoff) ────────────────── */

export const DASH_STATS = [
  { value: "14", label: "DOMAINS UNDER MANAGEMENT" },
  { value: "14", label: "SITES HOSTED" },
  { value: "38", label: "MAILBOXES" },
  { value: "2", label: "RENEWALS IN 30 DAYS", primary: true },
] as const;

export const DASH_DOMAINS = [
  { name: "studioanka.in", expires: "12 Oct 2026", renewal: "₹799", auto: "On", expiryColor: "#4A5560", autoColor: "#0F7B4F" },
  { name: "studioanka.com", expires: "04 Sep 2026", renewal: "₹1,199", auto: "On", expiryColor: "#B3261E", autoColor: "#0F7B4F" },
  { name: "kalyantextiles.in", expires: "21 Jan 2027", renewal: "₹799", auto: "On", expiryColor: "#4A5560", autoColor: "#0F7B4F" },
  { name: "nirvaanclinics.co.in", expires: "17 Sep 2026", renewal: "₹899", auto: "Off", expiryColor: "#C98A0A", autoColor: "#B3261E" },
  { name: "vasaimotors.shop", expires: "30 Mar 2027", renewal: "₹2,899", auto: "On", expiryColor: "#4A5560", autoColor: "#0F7B4F" },
] as const;

export const DASH_INVOICES = [
  { no: "INV-2026-0912", date: "01 Aug 2026", amount: "₹12,478", status: "Paid", color: "#0F7B4F" },
  { no: "INV-2026-0871", date: "01 Jul 2026", amount: "₹11,904", status: "Paid", color: "#0F7B4F" },
  { no: "INV-2026-0834", date: "01 Jun 2026", amount: "₹11,904", status: "Paid", color: "#0F7B4F" },
  { no: "INV-2026-0951", date: "01 Sep 2026", amount: "₹13,062", status: "Due in 4 days", color: "#C98A0A" },
] as const;

export const DASH_TICKETS = [
  { subject: "Move nirvaanclinics.co.in to the Bengaluru node", meta: "WhatsApp · replied 14 minutes ago" },
  { subject: "Add 6 mailboxes for the new sales team", meta: "Email · awaiting your confirmation" },
] as const;

/* ── Legal drafts ──────────────────────────────────────────────────────────── */

export interface LegalPage {
  title: string;
  updated: string;
  intro: string;
  blocks: readonly { h: string; p: string }[];
}

export const LEGAL: Readonly<Record<"terms" | "privacy" | "refund", LegalPage>> = {
  terms: {
    title: "Terms and conditions",
    updated: "Last updated 30 September 2026",
    intro: "These terms govern services bought from Anutech Digital Pvt Ltd, Rohini, Delhi (GSTIN 07ABDCA0298H1ZP). Placeholder draft — have your counsel review before publishing.",
    blocks: [
      { h: "What we supply", p: "We resell Google Workspace, Microsoft 365 and Zoho subscriptions and supply domain registration, hosting, email and SSL services. Where a service originates with a vendor, that vendor's own terms apply alongside these." },
      { h: "Pricing and taxes", p: "Prices published on this site are in Indian rupees and exclusive of GST at 18% unless a page states otherwise. First-year and renewal prices are shown together; we give thirty days written notice before changing a renewal price on an active subscription." },
      { h: "Payment and activation", p: "Orders are paid online through Razorpay (UPI, netbanking, cards and wallets) and set up once the payment is confirmed. Licence orders are subject to vendor provisioning timelines. A GST tax invoice is issued in your name for every paid order." },
      { h: "Hosting and domains", p: "Every hosting plan is attached to a domain you own or buy from us. Domains are registered in your name, with the owner details you give at checkout, and those details must be accurate: the registry can suspend a domain whose owner details are false." },
      { h: "Free hosting trial", p: "The Starter hosting plan can be tried free for 15 days, once per customer. No card is taken, so nothing is charged when the trial ends." },
      { h: "Renewals and expiry", p: "We send renewal reminders by email from thirty days before expiry. Auto-renew is configurable per subscription. Domains that lapse enter the registry redemption period, and redemption fees set by the registry apply." },
      { h: "Support", p: "Support is provided by email at support@anutech.in, Monday to Saturday, 10:00 to 19:00 IST. Our target is a first reply inside four working hours." },
      { h: "Uptime and credits", p: "Hosting carries a 99.9% monthly uptime commitment. Where a calendar month falls below it, we credit the affected month to your account without you having to ask." },
      { h: "Your data", p: "You own your data. You may export it at any time and we delete it on written request, subject to statutory retention of invoices under GST law." },
      { h: "Limitation of liability", p: "Our aggregate liability for any claim is limited to the fees you paid for the affected service in the three months preceding the claim. We are not liable for indirect or consequential loss." },
      { h: "Governing law", p: "These terms are governed by the laws of India. Courts at Delhi have exclusive jurisdiction." },
    ],
  },
  privacy: {
    title: "Privacy policy",
    updated: "Last updated 30 September 2026",
    intro: "How Anutech Digital Pvt Ltd handles personal data, aligned to the Digital Personal Data Protection Act, 2023. Placeholder draft — have your counsel review before publishing.",
    blocks: [
      { h: "What we collect", p: "Contact details you give us (name, company, email, mobile), billing details including GSTIN, records of quotes, orders and invoices, support conversations, and basic technical logs needed to operate the service." },
      { h: "Why we collect it", p: "To supply and support what you bought, to raise GST-compliant invoices, to notify you about renewals and outages, and to meet statutory record-keeping obligations. We do not sell personal data." },
      { h: "Consent and choice", p: "Analytics and marketing cookies are set only if you accept them. You can decline and continue to use the site, and you can withdraw consent at any time by writing to us." },
      { h: "Where data lives", p: "Customer records are held on Indian infrastructure. ResellerOS runs on Google Cloud in the Mumbai region. Vendor subscriptions are provisioned on the vendor's own platform under their policies." },
      { h: "Sharing", p: "We share data only with the vendor whose product you bought, with payment processors to collect payment, and where compelled by law. Each processor is bound by contract to purpose limitation." },
      { h: "Retention", p: "Invoices and tax records are retained as long as GST law requires. Other personal data is deleted within ninety days of a valid deletion request or of the account closing, whichever is later." },
      { h: "Your rights", p: "You may ask for access to your data, correction of it, or its deletion, and you may nominate another person to exercise these rights on your behalf. Write to us and we respond inside thirty days." },
      { h: "Grievances", p: "Our Grievance Officer is Anutech Digital Pvt Ltd, Rohini, Delhi. Write to support@anutech.in with \"Grievance\" in the subject. If it is not resolved, you may escalate to the Data Protection Board of India." },
    ],
  },
  refund: {
    title: "Refund policy",
    updated: "Last updated 30 September 2026",
    intro: "What is refundable, what is not, and how long it takes.",
    blocks: [
      { h: "Hosting", p: "Full refund inside thirty days of a first hosting order, less any domain registered free with it. Renewals are refundable inside seven days if the account was not used in that period." },
      { h: "Licences", p: "Google Workspace, Microsoft 365 and Zoho subscriptions follow the vendor's cancellation terms. Annual commitments generally cannot be cancelled mid-term; monthly plans stop at the end of the paid month." },
      { h: "Domains", p: "Domain registrations, renewals and transfers are non-refundable once submitted to the registry. This is a registry rule, not ours. If a registration fails we refund in full." },
      { h: "Certificates", p: "Paid SSL certificates are refundable inside fifteen days of issue provided the certificate has been revoked." },
      { h: "Free trial", p: "The free hosting trial takes no payment, so there is nothing to refund. Ending it early costs nothing." },
      { h: "How to claim", p: "Email support@anutech.in from the address on the order, with the order number. We confirm eligibility the same working day." },
      { h: "Timelines", p: "Approved refunds are returned to the original payment method inside seven working days. GST already remitted is adjusted through a credit note." },
    ],
  },
};
