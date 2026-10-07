/**
 * Every visible word of the Google Workspace ads landing page, in English and Hinglish
 * (R-396, 7 Oct 2026 — Pardeep: "both options hone chahiye").
 *
 * One `LpDict` shape, two objects typed against it, so a key added to one language and
 * forgotten in the other is a compile error. English is the default; `?lang=hi` (or
 * `?lang=hinglish`) in an ad's final URL opens the Hinglish page, and the toggle at the top
 * switches it. Facts and prices are the SAME in both — only the words change; numbers come
 * in as already-formatted arguments (₹ via `inr`), never typed into a sentence here. No
 * Business Plus price anywhere (R-328): Plus says CONTACT_FOR_PRICING.
 */
import type { LpPlanKey } from "@/site/lib/lp-plans";

export type LpLang = "en" | "hinglish";
export const LP_LANGS: readonly LpLang[] = ["en", "hinglish"];
export const LP_DEFAULT_LANG: LpLang = "en";
/** localStorage key for the visitor's last choice. */
export const LP_LANG_STORE = "anutech.lp.lang.v1";

/** `?lang=` value → language; anything else (missing, typo) → null so the caller falls back. */
export function parseLpLang(v: string | readonly string[] | null | undefined): LpLang | null {
  const s = (Array.isArray(v) ? v[0] : v)?.toString().trim().toLowerCase();
  if (!s) return null;
  if (s === "hi" || s === "hinglish" || s === "hi-latn") return "hinglish";
  if (s === "en" || s === "english") return "en";
  return null;
}

/** The hero lines. Also a prop, so an ad variant can bring its own (it then wins in both languages). */
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
  langToggleLabel: string;
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
  langToggleLabel: "Language",
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
  btn: { buyNow: "Buy Now", getQuote: "Get Quote", startTrial: "Start 14-Day Free Trial", freeTrial: "Free Trial", whatsapp: "WhatsApp", callWhatsapp: "Call / WhatsApp", close: "Close" },
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
    plainBody: ["Domain, users and old mail — done by our team. Plus a ", "14-day free trial", ", no card needed."],
    startNow: "Get started",
    getQuote: "Get a quote",
  },
  strip: { aria: "Why customers pick ANUTECH", trial: "14-day free trial", setup: "Free setup & migration", gst: "GST invoice", support: "Hindi / English support" },
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
      ["What happens after the 14-day trial?", offer
        ? `After the trial, you decide. To continue, take the yearly plan — a new account with 30+ users pays ${offerPrice}/user in the first year (with Google approval; list price from the second year); otherwise nothing is charged — no card is asked for.`
        : "After the trial, you decide. To continue, take the yearly or monthly plan; otherwise nothing is charged — no card is asked for."],
      ["Do I get a GST invoice?", "Yes, every order comes with a GST invoice, and your business can claim input tax credit on it."],
      [`How many users can ${plan} have?`, `${usersLimit}. You can add users any time, and upgrade the plan when you need to.`],
    ],
  },
  cta: { h3: "Ready to move your business to Google Workspace?", p: "14-day free trial, free setup and migration — give your name and number and we will call you today." },
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
    trialKicker: "14-day free trial",
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

const hinglish: LpDict = {
  htmlLang: "hi-Latn",
  langToggleLabel: "Bhasha",
  plans: {
    starter: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace for Your Business",
        h2: "Business ko banaye Smart, Secure & Professional!",
        sub: "Gmail, Drive, Meet, Docs aur bahut kuch — sab ek hi platform par. Work smarter, collaborate better, grow faster.",
      },
      benefits: [
        ["Professional email", "you@yourcompany.com — apne domain par"],
        ["Secure & reliable", "Google ki business-grade security"],
        ["Easy collaboration", "Kahin se bhi saath kaam karein"],
        ["Har device par", "Desktop, mobile aur tablet"],
      ],
      includes: ["30 GB per user · custom email", "Setup, domain aur migration help included"],
      usersLimit: "1 se 300 users tak",
      highlight: "Apne domain par professional email",
    },
    standard: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace Business Standard",
        h2: "Badhti team ke liye — 2 TB storage, recordings aur Gemini AI",
        sub: "Business email, 2 TB per user, 150 logon ki meetings recording ke saath, aur Docs, Sheets, Meet mein Gemini — setup aur migration hamari taraf se.",
      },
      benefits: [
        ["2 TB per user", "Files, videos aur backups — jagah ki chinta nahi"],
        ["Meeting recordings", "150 log tak, recording seedha Drive mein"],
        ["Gemini AI", "Gmail, Docs, Sheets aur Meet mein AI madad"],
        ["Booking & eSignature", "Appointment pages aur Docs mein sign"],
      ],
      includes: ["2 TB per user · custom email", "Meet recordings · Gemini in Docs, Sheets, Meet", "Setup, domain aur migration help included"],
      usersLimit: "1 se 300 users tak",
      highlight: "Gemini AI + meeting recordings",
    },
    plus: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace Business Plus",
        h2: "Compliance aur security chahiye? Vault, 5 TB aur advanced controls",
        sub: "Mail aur files ka retention (Vault), 5 TB per user, 500 logon ki meetings aur advanced device security — sab Google Workspace mein, setup ANUTECH ka.",
      },
      benefits: [
        ["5 TB per user", "Bade files aur archives ke liye"],
        ["Vault", "Mail aur files ka retention aur eDiscovery"],
        ["Advanced security", "Advanced endpoint management"],
        ["500-person meetings", "Bade townhalls aur trainings"],
      ],
      includes: ["5 TB per user · custom email", "Vault: retention & eDiscovery · advanced endpoint management", "Setup, domain aur migration help included"],
      usersLimit: "1 se 300 users tak",
      highlight: "Vault: mail retention aur eDiscovery",
    },
    enterprise: {
      hero: {
        eyebrow: EYEBROW,
        h1Rest: "Workspace Enterprise",
        h2: "Badi companies ke liye — enterprise security, bina user limit",
        sub: "300+ users, sakht security aur compliance, 1,000 logon ki meetings — hum aapki zaroorat samajh kar Enterprise ka quote aur rollout plan dete hain.",
      },
      benefits: [
        ["Enterprise security", "Data protection aur enterprise endpoint controls"],
        ["1,000-person meetings", "In-domain live streaming"],
        ["5 TB+ per user", "Zaroorat ho to aur storage"],
        ["No user limit", "300 se zyada users bhi"],
      ],
      includes: ["5 TB+ per user · custom email", "Enterprise security, Vault, 1,000-person meetings", "Migration planning aur rollout ANUTECH karta hai"],
      usersLimit: "koi limit nahi — 300 se zyada bhi",
      highlight: "Enterprise security, koi user limit nahi",
    },
  },
  categoryHero: {
    eyebrow: EYEBROW,
    h1Rest: "Workspace — har business ke liye plan",
    h2: "Starter se Enterprise tak — sahi plan, sahi daam, setup hamari taraf se",
    sub: "Gmail, Drive, Meet, Docs aur Gemini — 1 user se 1,000+ tak. Plan hum milkar chunte hain; domain, users aur purana mail hamari team shift karti hai.",
  },
  nav: { onThisPage: "Is page par", features: "Features", plans: "Plans", price: "Daam", compare: "Compare", faq: "FAQ", viewOffer: "Offer dekhein", seePrice: "Daam dekhein" },
  btn: { buyNow: "Abhi kharidein", getQuote: "Quote lein", startTrial: "14 din ka free trial shuru karein", freeTrial: "Free Trial", whatsapp: "WhatsApp", callWhatsapp: "Call / WhatsApp", close: "Band karein" },
  wa: {
    want: (plan) => `Hello ANUTECH, mujhe Google Workspace ${plan} chahiye.`,
    buy: (plan) => `Hello ANUTECH, mujhe Google Workspace ${plan} kharidna hai.`,
    callback: (name, plan) => `Hello ANUTECH, main ${name} hoon. Mujhe Google Workspace${plan ? ` ${plan}` : ""} ke liye call chahiye.`,
    enquiry: (name, users) => `Hello ANUTECH, main ${name} hoon. Mujhe ${users} users ke liye Google Workspace chahiye.`,
  },
  hero: {
    ticks: ["Trial mein koi card nahi", "Setup + migration free", "GST invoice"],
    noteOffer: (min, pm) => [`${min}+ users: pehle saal sirf `, `${pm}/user/mahina`, " (saalana plan)"],
    notePrice: (plan, pm) => [`${plan}: `, `${pm}/user/mahina`, " (saalana plan)"],
    noteQuote: (plan) => `${plan}: daam aapki zaroorat ke hisaab se`,
    photoAlt: "Google Workspace par kaam karta ek business owner",
    float: "Google ke saath business badhaiye",
    floatSmall: "Secure · Collaborative · Productive",
  },
  promo: {
    offerAria: "Khaas offer",
    tagOffer: (min) => `${min}+ users · naya account`,
    off: "off",
    firstYear: "Pehle saal",
    perUser: "/user",
    offerBody: ["Saath mein ", "FREE setup + email migration", " — domain, users aur purana mail, sab hamari team karti hai."],
    offerBtn: "Offer lo",
    plainAria: "Aapko kya milega",
    setup: "setup",
    plainHead: "FREE setup + email migration",
    plainBody: ["Domain, users aur purana mail — hamari team karti hai. Saath mein ", "14 din free trial", ", koi card nahi."],
    startNow: "Abhi shuru karein",
    getQuote: "Quote lein",
  },
  strip: { aria: "Customers ANUTECH ko kyun chunte hain", trial: "14 din free trial", setup: "Free setup aur migration", gst: "GST invoice", support: "Hindi / English support" },
  apps: { aria: "Google Workspace apps", what: ["Business Email", "Cloud Storage", "Video Meetings", "Banao aur saath kaam karo", "Saath kaam karein", "Ideas present karein", "Organised rahein"] },
  steps: {
    kicker: "Kaise shuru hota hai",
    h3: "3 kadam — aur aapki team professional email par",
    items: (hours) => [
      ["Form ya WhatsApp", "Naam aur number dijiye — 1 minute."],
      ["Hamari call", `Users, domain aur plan tay karte hain — ${hours}.`],
      ["Setup hum karte hain", "Domain, users, purana mail — sab shift. Aapki team kaam shuru karti hai."],
    ],
  },
  benefits: { kicker: "Google Workspace kyun?", h3: "Business ki har zaroorat, ek hi jagah.", copy: "Email, files, meetings aur roz ka kaam — ek simple, secure jagah par." },
  price: {
    aria: "Daam",
    perUserMonth: " per user / mahina",
    perYear: (y) => `${y} per user / saal · + 18% GST (input credit milta hai)`,
    quoteInADay: " — ek din mein quote",
    letsTalk: "Baat karte hain",
    offerLine: (min) => `${min}+ users · naya account`,
    offBadge: (pct) => `${pct}% OFF`,
    offerYear: (list, offer, pm) => ["Pehle saal ", list, offer, `/user (${pm}/mahina)`],
    renew: (y) => `Google approval ke saath (aam taur par mil jaati hai) · doosre saal se ${y}/user`,
    gstLine: "GST invoice",
    usersQ: "Kitne users?",
    fewer: "Ek user kam",
    more: "Ek user zyada",
    firstYear: "Pehla saal",
    firstYearGst: "Pehla saal + 18% GST",
    saving: (pct) => `Aapki bachat (${pct}% OFF)`,
    fromSecond: "Doosre saal se",
    perYearGst: "/saal + GST",
    nudge: (min, pct) => `${min} users par pehle saal ${pct}% OFF — ${min} karke dekhein`,
    secure: "Aasaan setup · Expert support · India mein local support",
  },
  grid: {
    kicker: "Saare plans",
    h3: "Apne business ke hisaab se plan chunein",
    flag: (min, pu) => `${min}+ users: pehla saal ${pu}/user`,
    perMonth: "/user/mahina",
    quote: "Quote",
    quoteSub: " — ek din mein",
    yearlyGst: "saalana plan · + GST",
    over300: "300+ users ke liye",
    choose: "Ye plan lein",
    getQuote: "Quote lein",
    more: (plan) => `${plan} ke baare mein →`,
    note: "Pakka nahi kaunsa? Call-back maangiye — 5 minute mein sahi plan bata denge.",
  },
  compare: {
    kicker: "Free Gmail vs Google Workspace",
    h3: "Business ke liye free Gmail kaafi kyun nahi",
    feature: "Feature",
    freeGmail: "Free Gmail",
    workspace: "Google Workspace",
    rows: (storage, meet) => [
      ["Email address", "yourname@gmail.com", "you@yourcompany.com"],
      ["Storage", "15 GB, Drive aur Photos ke saath shared", storage],
      ["Inbox mein ads", "Haan", "Koi ads nahi"],
      ["Group video calls", "60 minute ki limit", `${meet}, lambi meetings`],
      ["Account kiska hai", "Employee ka", "Aapki company ka — koi bhi user add, remove, reset"],
      ["Atak jaayein to madad", "Online forums", "ANUTECH team + Google support"],
    ],
  },
  why: {
    kicker: "ANUTECH se kyun lein?",
    h3: "Google ka product, ANUTECH ka saath",
    items: (hours) => [
      ["GST invoice in INR", "Har order par GST invoice — business input credit le sakta hai."],
      ["Setup hum karte hain", "Domain verify, MX records, users — hamari team karti hai."],
      ["Free migration", "Purana mail, folders, contacts aur calendar — hum shift karte hain, kuch nahi chhootta."],
      ["Local support", `Hindi / English mein, phone aur WhatsApp par — ${hours}.`],
    ],
  },
  faq: {
    kicker: "FAQ",
    h3: "Aksar puchhe jaane wale sawal",
    items: ({ plan, usersLimit, offer, offerPrice }) => [
      ["Mere paas domain nahi hai — kya hoga?", "Koi baat nahi. Hum aapka domain bhi register kar dete hain aur usi par Google Workspace chalu karte hain — ek hi jagah se."],
      ["Purana email (cPanel, Zoho, Outlook) ka kya hoga?", "Free migration: purane mail, folders, contacts aur calendar hum Google Workspace mein shift karte hain. Aapke paas kuch nahi chhootta."],
      ["14 din ke trial ke baad kya hota hai?", offer
        ? `Trial ke baad aap tay karte hain. Jaari rakhna hai to saalana plan lijiye — naya account aur 30+ users ho to pehle saal ${offerPrice}/user (Google approval ke saath; doosre saal se list price); nahi to kuch nahi katega — koi card nahi maanga jaata.`
        : "Trial ke baad aap tay karte hain. Jaari rakhna hai to saalana ya monthly plan lijiye; nahi to kuch nahi katega — koi card nahi maanga jaata."],
      ["GST invoice milega?", "Haan, har order par GST invoice milta hai, aur business us par input tax credit le sakta hai."],
      [`${plan} kitne users tak?`, `${usersLimit}. Users kabhi bhi badha sakte hain, aur zaroorat par plan upgrade bhi.`],
    ],
  },
  cta: { h3: "Apna business Google Workspace par le jaane ko taiyaar?", p: "14 din free trial, free setup aur migration — naam aur number dijiye, hum aaj hi call karte hain." },
  foot: { line: "Google Workspace solutions", callWa: "Call / WhatsApp" },
  exit: { kicker: "Jaane se pehle", h3: "Ek free call — koi commitment nahi", p: "Naam aur number dijiye. Hum batayenge aapke business ke liye kaunsa plan sahi hai, aur setup kaise hoga." },
  sticky: { aria: "Jaldi ke buttons" },
  callback: {
    aria: "Call back maangiye",
    title: "Ya hum aapko call karein — free",
    name: "Aapka naam",
    namePlaceholder: "Aapka naam",
    mobile: "Mobile number",
    send: "Mujhe call karein",
    spamCheck: "Ek second — spam check ho raha hai",
    failed: "Request nahi ja paayi",
    thanks: (first) => `Shukriya${first ? `, ${first}` : ""}! Hum jald call karenge.`,
    waNow: " · abhi baat karni ho to WhatsApp karein",
  },
  enquiry: {
    spamCheck: "Ek second — spam check ho raha hai",
    failed: "Request nahi ja paayi",
    tryAgain: " — dobara koshish karein.",
    doneKicker: "Request mil gayi",
    doneH: (first) => `Shukriya, ${first}!`,
    doneP: (hours) => `Hamari team ${hours} ke beech aapko call karegi. Email par confirmation bhi aa raha hai.`,
    doneWa: "Abhi WhatsApp par baat karein",
    trialKicker: "14 din ka free trial",
    buyH: "Apni details dijiye",
    trialH: "Free trial shuru karein",
    buyP: "Hamari team aaj hi call karke aapke domain par setup karegi.",
    trialP: "Koi card nahi chahiye. Hum aapke domain par trial chalu karenge.",
    name: "Naam",
    company: "Company ka naam",
    email: "Email",
    mobile: "Mobile number",
    users: "Kitne users",
    sending: "Bhej rahe hain…",
    submit: "Enquiry bhejein →",
  },
};

export const LP_TEXT: Record<LpLang, LpDict> = { en, hinglish };
