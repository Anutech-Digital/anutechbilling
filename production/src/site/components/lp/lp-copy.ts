/**
 * Every visible word of the Google Workspace ads landing page.
 *
 * English only (R-1752, 22 Oct 2026 — Pardeep: the whole product, customer messages and the
 * public website are English). R-396 had a second, Hinglish dictionary behind a header toggle
 * and `?lang=hi`; both are gone. An old ad URL that still carries `?lang=hi` simply opens the
 * English page. Facts and prices are never typed into a sentence here: numbers come in as
 * already-formatted arguments (₹ via `inr`). No Business Plus price anywhere (R-328): Plus
 * says CONTACT_FOR_PRICING.
 */
import type { LpPlanKey } from "@/site/lib/lp-plans";
import { WORKSPACE_TRIAL_DAYS } from "@/lib/trials/trial-days";

/** The hero lines. Also a prop, so an ad variant can bring its own (it then wins over the plan's own). */
export interface WorkspaceAdCopy {
  eyebrow: string;
  h1Rest: string;
  h2: string;
  sub: string;
}

/** A sentence with one bold part in the middle: [before, bold, after]. */
export type Rich = readonly [string, string, string];

interface PlanText {
  hero: WorkspaceAdCopy;
  /** Four benefits beside the price card: [title, line]. */
  benefits: readonly (readonly [string, string])[];
  /** Lines under the price on the price card. */
  includes: readonly string[];
  usersLimit: string;
  /** The one line per plan card (category grid) that storage and Meet size do not already say. */
  highlight: string;
}

export interface LpDict {
  /** BCP-47 tag for the page wrapper (screen readers, translation tools). */
  htmlLang: string;
  plans: Record<LpPlanKey, PlanText>;
  categoryHero: WorkspaceAdCopy;
  nav: { onThisPage: string; features: string; plans: string; price: string; compare: string; faq: string; viewOffer: string; seePrice: string };
  btn: { buyNow: string; getQuote: string; startTrial: string; freeTrial: string; whatsapp: string; callWhatsapp: string; close: string };
  wa: { want: (plan: string) => string; buy: (plan: string) => string; callback: (name: string, plan: string) => string; enquiry: (name: string, users: number) => string };
  hero: {
    ticks: readonly [string, string, string];
    noteOffer: (minUsers: number, perMonth: string) => Rich;
    notePrice: (plan: string, perMonth: string) => Rich;
    noteQuote: (plan: string) => string;
    photoAlt: string;
    float: string;
    floatSmall: string;
  };
  promo: {
    offerAria: string;
    tagOffer: (minUsers: number) => string;
    off: string;
    firstYear: string;
    perUser: string;
    offerBody: Rich;
    offerBtn: string;
    plainAria: string;
    setup: string;
    plainHead: string;
    plainBody: Rich;
    startNow: string;
    getQuote: string;
  };
  strip: { aria: string; trial: string; setup: string; gst: string; support: string };
  apps: { aria: string; what: readonly [string, string, string, string, string, string, string] };
  steps: { kicker: string; h3: string; items: (hours: string) => readonly (readonly [string, string])[] };
  benefits: { kicker: string; h3: string; copy: string };
  price: {
    aria: string;
    perUserMonth: string;
    perYear: (yearly: string) => string;
    quoteInADay: string;
    letsTalk: string;
    offerLine: (minUsers: number) => string;
    offBadge: (pct: number) => string;
    offerYear: (list: string, offer: string, perMonth: string) => readonly [string, string, string, string];
    renew: (yearly: string) => string;
    gstLine: string;
    usersQ: string;
    fewer: string;
    more: string;
    firstYear: string;
    firstYearGst: string;
    saving: (pct: number) => string;
    fromSecond: string;
    perYearGst: string;
    nudge: (minUsers: number, pct: number) => string;
    secure: string;
  };
  grid: {
    kicker: string;
    h3: string;
    flag: (minUsers: number, perUser: string) => string;
    perMonth: string;
    quote: string;
    quoteSub: string;
    yearlyGst: string;
    over300: string;
    choose: string;
    getQuote: string;
    more: (plan: string) => string;
    note: string;
  };
  compare: {
    kicker: string;
    h3: string;
    feature: string;
    freeGmail: string;
    workspace: string;
    rows: (storage: string, meetPeople: string) => readonly (readonly [string, string, string])[];
  };
  why: { kicker: string; h3: string; items: (hours: string) => readonly (readonly [string, string])[] };
  faq: {
    kicker: string;
    h3: string;
    items: (o: { plan: string; usersLimit: string; offer: boolean; offerPrice: string }) => readonly (readonly [string, string])[];
  };
  cta: { h3: string; p: string };
  foot: { line: string; callWa: string };
  exit: { kicker: string; h3: string; p: string };
  sticky: { aria: string };
  callback: {
    aria: string;
    title: string;
    name: string;
    namePlaceholder: string;
    mobile: string;
    send: string;
    spamCheck: string;
    failed: string;
    thanks: (first: string) => string;
    waNow: string;
  };
  enquiry: {
    spamCheck: string;
    failed: string;
    tryAgain: string;
    doneKicker: string;
    doneH: (first: string) => string;
    doneP: (hours: string) => string;
    doneWa: string;
    trialKicker: string;
    buyH: string;
    trialH: string;
    buyP: string;
    trialP: string;
    name: string;
    company: string;
    email: string;
    mobile: string;
    users: string;
    sending: string;
    submit: string;
  };
}

const EYEBROW = "Authorised Google Workspace Reseller";

const en: LpDict = {
  htmlLang: "en-IN",
  plans: {
    starter: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace for Your Business",
        h2: "Make your business smart, secure & professional!",
        sub: "Gmail, Drive, Meet, Docs and much more — all on one platform. Work smarter, collaborate better, grow faster.",
      },
      benefits: [
        ["Professional email", "you@yourcompany.com — on your own domain"],
        ["Secure & reliable", "Google's business-grade security"],
        ["Easy collaboration", "Work together from anywhere"],
        ["On every device", "Desktop, mobile and tablet"],
      ],
      includes: ["30 GB per user · custom email", "Setup, domain and migration help included"],
      usersLimit: "1 to 300 users",
      highlight: "Professional email on your domain",
    },
    standard: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace Business Standard",
        h2: "For growing teams — 2 TB storage, recordings and Gemini AI",
        sub: "Business email, 2 TB per user, meetings of 150 people with recording, and Gemini in Docs, Sheets and Meet — setup and migration done by us.",
      },
      benefits: [
        ["2 TB per user", "Files, videos and backups — no space worries"],
        ["Meeting recordings", "Up to 150 people, recordings saved straight to Drive"],
        ["Gemini AI", "AI help in Gmail, Docs, Sheets and Meet"],
        ["Booking & eSignature", "Appointment pages and signing in Docs"],
      ],
      includes: ["2 TB per user · custom email", "Meet recordings · Gemini in Docs, Sheets, Meet", "Setup, domain and migration help included"],
      usersLimit: "1 to 300 users",
      highlight: "Gemini AI + meeting recordings",
    },
    plus: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace Business Plus",
        h2: "Need compliance and security? Vault, 5 TB and advanced controls",
        sub: "Mail and file retention (Vault), 5 TB per user, meetings of 500 people and advanced device security — all in Google Workspace, set up by ANUTECH.",
      },
      benefits: [
        ["5 TB per user", "For large files and archives"],
        ["Vault", "Retention and eDiscovery for mail and files"],
        ["Advanced security", "Advanced endpoint management"],
        ["500-person meetings", "Large town halls and trainings"],
      ],
      includes: ["5 TB per user · custom email", "Vault: retention & eDiscovery · advanced endpoint management", "Setup, domain and migration help included"],
      usersLimit: "1 to 300 users",
      highlight: "Vault: mail retention & eDiscovery",
    },
    enterprise: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace Enterprise",
        h2: "For large companies — enterprise security, no user limit",
        sub: "300+ users, strict security and compliance, meetings of 1,000 people — we understand your needs and give you an Enterprise quote and rollout plan.",
      },
      benefits: [
        ["Enterprise security", "Data protection and enterprise endpoint controls"],
        ["1,000-person meetings", "In-domain live streaming"],
        ["5 TB+ per user", "More storage when you need it"],
        ["No user limit", "More than 300 users too"],
      ],
      includes: ["5 TB+ per user · custom email", "Enterprise security, Vault, 1,000-person meetings", "Migration planning and rollout by ANUTECH"],
      usersLimit: "no limit — more than 300 too",
      highlight: "Enterprise security, no user limit",
    },
  },
  categoryHero: {
    eyebrow: EYEBROW,
    h1Rest: "Workspace — a plan for every business",
    h2: "From Starter to Enterprise — the right plan, the right price, setup done by us",
    sub: "Gmail, Drive, Meet, Docs and Gemini — from 1 user to 1,000+. We pick the plan together; our team moves your domain, users and old mail.",
  },
  nav: { onThisPage: "On this page", features: "Features", plans: "Plans", price: "Price", compare: "Compare", faq: "FAQ", viewOffer: "View Offer", seePrice: "See Price" },
  btn: { buyNow: "Buy Now", getQuote: "Get Quote", startTrial: `Start ${WORKSPACE_TRIAL_DAYS}-Day Free Trial`, freeTrial: "Free Trial", whatsapp: "WhatsApp", callWhatsapp: "Call / WhatsApp", close: "Close" },
  wa: {
    want: (plan) => `Hello ANUTECH, I want Google Workspace ${plan}.`,
    buy: (plan) => `Hello ANUTECH, I want to buy Google Workspace ${plan}.`,
    callback: (name, plan) => `Hello ANUTECH, I am ${name}. I would like a call about Google Workspace${plan ? ` ${plan}` : ""}.`,
    enquiry: (name, users) => `Hello ANUTECH, I am ${name}. I want Google Workspace for ${users} users.`,
  },
  hero: {
    ticks: ["No card for the trial", "Free setup + migration", "GST invoice"],
    noteOffer: (min, pm) => [`${min}+ users: first year only `, `${pm}/user/month`, " (yearly plan)"],
    notePrice: (plan, pm) => [`${plan}: `, `${pm}/user/month`, " (yearly plan)"],
    noteQuote: (plan) => `${plan}: priced to your needs`,
    photoAlt: "A business owner working on Google Workspace",
    float: "Grow your business with Google",
    floatSmall: "Secure · Collaborative · Productive",
  },
  promo: {
    offerAria: "Special offer",
    tagOffer: (min) => `${min}+ users · new account`,
    off: "off",
    firstYear: "First year",
    perUser: "/user",
    offerBody: ["Plus ", "FREE setup + email migration", " — domain, users and old mail, all done by our team."],
    offerBtn: "Get the offer",
    plainAria: "What you get",
    setup: "setup",
    plainHead: "FREE setup + email migration",
    plainBody: ["Domain, users and old mail — done by our team. Plus a ", `${WORKSPACE_TRIAL_DAYS}-day free trial`, ", no card needed."],
    startNow: "Get started",
    getQuote: "Get a quote",
  },
  strip: { aria: "Why customers pick ANUTECH", trial: `${WORKSPACE_TRIAL_DAYS}-day free trial`, setup: "Free setup & migration", gst: "GST invoice", support: "Hindi / English support" },
  apps: { aria: "Google Workspace apps", what: ["Business Email", "Cloud Storage", "Video Meetings", "Create & Collaborate", "Work Together", "Present Ideas", "Stay Organised"] },
  steps: {
    kicker: "How it starts",
    h3: "3 steps — and your team is on professional email",
    items: (hours) => [
      ["Form or WhatsApp", "Give your name and number — 1 minute."],
      ["Our call", `We settle users, domain and plan — ${hours}.`],
      ["We do the setup", "Domain, users, old mail — all moved. Your team starts working."],
    ],
  },
  benefits: { kicker: "Why Google Workspace?", h3: "Everything your business needs, in one place.", copy: "Email, files, meetings and daily work — in one simple, secure place." },
  price: {
    aria: "Price",
    perUserMonth: " per user / month",
    perYear: (y) => `${y} per user / year · + 18% GST (input credit available)`,
    quoteInADay: " — quote in a day",
    letsTalk: "Let's talk",
    offerLine: (min) => `${min}+ users · new account`,
    offBadge: (pct) => `${pct}% OFF`,
    offerYear: (list, offer, pm) => ["First year ", list, offer, `/user (${pm}/month)`],
    renew: (y) => `With Google approval (usually given) · from the second year ${y}/user`,
    gstLine: "GST invoice",
    usersQ: "How many users?",
    fewer: "One user fewer",
    more: "One user more",
    firstYear: "First year",
    firstYearGst: "First year + 18% GST",
    saving: (pct) => `You save (${pct}% OFF)`,
    fromSecond: "From the second year",
    perYearGst: "/year + GST",
    nudge: (min, pct) => `${pct}% OFF the first year at ${min} users — try ${min}`,
    secure: "Easy setup · Expert support · Local support in India",
  },
  grid: {
    kicker: "All plans",
    h3: "Pick the plan that fits your business",
    flag: (min, pu) => `${min}+ users: first year ${pu}/user`,
    perMonth: "/user/month",
    quote: "Quote",
    quoteSub: " — in a day",
    yearlyGst: "yearly plan · + GST",
    over300: "for 300+ users",
    choose: "Choose this plan",
    getQuote: "Get a quote",
    more: (plan) => `About ${plan} →`,
    note: "Not sure which one? Ask for a call back — we will tell you the right plan in 5 minutes.",
  },
  compare: {
    kicker: "Free Gmail vs Google Workspace",
    h3: "Why free Gmail is not enough for a business",
    feature: "Feature",
    freeGmail: "Free Gmail",
    workspace: "Google Workspace",
    rows: (storage, meet) => [
      ["Email address", "yourname@gmail.com", "you@yourcompany.com"],
      ["Storage", "15 GB, shared with Drive & Photos", storage],
      ["Ads in the inbox", "Yes", "No ads"],
      ["Group video calls", "60-minute limit", `${meet}, long meetings`],
      ["Who owns the account", "The employee", "Your company — add, remove, reset any user"],
      ["Help when stuck", "Online forums", "ANUTECH team + Google support"],
    ],
  },
  why: {
    kicker: "Why buy from ANUTECH?",
    h3: "Google's product, ANUTECH's support",
    items: (hours) => [
      ["GST invoice in INR", "A GST invoice with every order — your business can claim input credit."],
      ["Setup done for you", "Domain verification, MX records, users — our team does it."],
      ["Free migration", "Old mail, folders, contacts and calendar — we move it all, nothing is left behind."],
      ["Local support", `In Hindi / English, on phone and WhatsApp — ${hours}.`],
    ],
  },
  faq: {
    kicker: "FAQ",
    h3: "Frequently asked questions",
    items: ({ plan, usersLimit, offer, offerPrice }) => [
      ["I don't have a domain — what happens?", "No problem. We register your domain too and start Google Workspace on it — all in one place."],
      ["What about my old email (cPanel, Zoho, Outlook)?", "Free migration: we move your old mail, folders, contacts and calendar into Google Workspace. You lose nothing."],
      [`What happens after the ${WORKSPACE_TRIAL_DAYS}-day trial?`, offer
        ? `After the trial, you decide. To continue, take the yearly plan — a new account with 30+ users pays ${offerPrice}/user in the first year (with Google approval; list price from the second year); otherwise nothing is charged — no card is asked for.`
        : "After the trial, you decide. To continue, take the yearly or monthly plan; otherwise nothing is charged — no card is asked for."],
      ["Do I get a GST invoice?", "Yes, every order comes with a GST invoice, and your business can claim input tax credit on it."],
      [`How many users can ${plan} have?`, `${usersLimit}. You can add users any time, and upgrade the plan when you need to.`],
    ],
  },
  cta: { h3: "Ready to move your business to Google Workspace?", p: `${WORKSPACE_TRIAL_DAYS}-day free trial, free setup and migration — give your name and number and we will call you today.` },
  foot: { line: "Google Workspace solutions", callWa: "Call / WhatsApp" },
  exit: { kicker: "Before you go", h3: "One free call — no commitment", p: "Give your name and number. We will tell you which plan suits your business, and how the setup will work." },
  sticky: { aria: "Quick actions" },
  callback: {
    aria: "Request a call back",
    title: "Or we call you — free",
    name: "Your name",
    namePlaceholder: "Your name",
    mobile: "Mobile number",
    send: "Call me back",
    spamCheck: "One second — running a spam check",
    failed: "Request did not go through",
    thanks: (first) => `Thank you${first ? `, ${first}` : ""}! We will call you soon.`,
    waNow: " · to talk right now, WhatsApp us",
  },
  enquiry: {
    spamCheck: "One second — running a spam check",
    failed: "Request did not go through",
    tryAgain: " — please try again.",
    doneKicker: "Request received",
    doneH: (first) => `Thank you, ${first}!`,
    doneP: (hours) => `Our team will call you between ${hours}. A confirmation is on its way to your email.`,
    doneWa: "Talk on WhatsApp now",
    trialKicker: `${WORKSPACE_TRIAL_DAYS}-day free trial`,
    buyH: "Share your details",
    trialH: "Start your free trial",
    buyP: "Our team will call you today and set it up on your domain.",
    trialP: "No card needed. We will start the trial on your domain.",
    name: "Name",
    company: "Company name",
    email: "Email",
    mobile: "Mobile number",
    users: "Number of users",
    sending: "Sending…",
    submit: "Submit enquiry →",
  },
};

export const LP_TEXT: LpDict = en;
