/* eslint-disable */
// Public product landing pages — one component, three routes:
// #/buy-workspace · #/buy-m365 · #/buy-zoho

// Google Workspace logotype — multi-color "Google" + grey "Workspace"
function GoogleWorkspaceLogo({ size = 36 }) {
  const C = { B: "#4285F4", R: "#EA4335", Y: "#FBBC04", G: "#34A853", grey: "#5F6368" };
  return (
    <div style={{ display: "inline-flex", alignItems: "baseline", fontFamily: "'Product Sans', 'Plus Jakarta Sans', system-ui, sans-serif", fontSize: size, fontWeight: 500, letterSpacing: "-0.01em", lineHeight: 1 }}>
      <span style={{ color: C.B }}>G</span>
      <span style={{ color: C.R }}>o</span>
      <span style={{ color: C.Y }}>o</span>
      <span style={{ color: C.B }}>g</span>
      <span style={{ color: C.G }}>l</span>
      <span style={{ color: C.R }}>e</span>
      <span style={{ width: size * 0.25 }} />
      <span style={{ color: C.grey, fontWeight: 400 }}>Workspace</span>
    </div>
  );
}

// Inline multi-color "Google Workspace" — for headlines, modal headers, body text
// Inherits font from surrounding context (works in serif or sans contexts)
function GWInline({ workspaceColor = "#5F6368", workspaceWeight = 400, spaceFactor = 0.18 }) {
  const C = { B: "#4285F4", R: "#EA4335", Y: "#FBBC04", G: "#34A853" };
  return (
    <span style={{ whiteSpace: "nowrap" }}>
      <span style={{ color: C.B }}>G</span>
      <span style={{ color: C.R }}>o</span>
      <span style={{ color: C.Y }}>o</span>
      <span style={{ color: C.B }}>g</span>
      <span style={{ color: C.G }}>l</span>
      <span style={{ color: C.R }}>e</span>
      <span> </span>
      <span style={{ color: workspaceColor, fontWeight: workspaceWeight }}>Workspace</span>
    </span>
  );
}

// Official Google Cloud Sell Premier Partner badge — Google Workspace
// Faithful SVG recreation of the badge Google issues to Premier Partners
function PremierPartnerBadge({ size = 140, type = "workspace" }) {
  const borderColor = "#9AA0A6";
  const textColor   = "#5F6368";
  return (
    <div style={{
      width: size,
      height: size,
      borderRadius: "50%",
      border: `1.5px solid ${borderColor}`,
      background: "#fff",
      display: "flex",
      flexDirection: "column",
      alignItems: "center",
      justifyContent: "center",
      padding: size * 0.08,
      fontFamily: "'Plus Jakarta Sans', 'Product Sans', system-ui, sans-serif",
      boxShadow: "0 6px 16px rgba(0,0,0,0.06)",
      flexShrink: 0,
    }}>
      {/* Google G logo (4-color rounded G) */}
      <svg viewBox="0 0 24 24" width={size * 0.23} height={size * 0.23} style={{ marginBottom: size * 0.03 }} aria-label="Google">
        <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
        <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
        <path fill="#FBBC04" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
        <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
      </svg>

      {/* SELL label */}
      <div style={{
        fontSize: size * 0.075,
        letterSpacing: "0.18em",
        color: textColor,
        textTransform: "uppercase",
        fontWeight: 500,
        marginBottom: size * 0.04,
      }}>Sell</div>

      {/* Premier Partner — big bold title */}
      <div style={{
        fontSize: size * 0.16,
        lineHeight: 1.05,
        textAlign: "center",
        color: textColor,
        fontWeight: 500,
        letterSpacing: "-0.01em",
        marginBottom: size * 0.05,
      }}>
        Premier<br/>Partner
      </div>

      {/* Product subtitle */}
      <div style={{
        fontSize: size * 0.085,
        color: textColor,
        fontWeight: 400,
        textAlign: "center",
        letterSpacing: "0.01em",
      }}>
        {type === "workspace" ? "Google Workspace" : type === "m365" ? "Microsoft 365" : "Cloud Solutions"}
      </div>
    </div>
  );
}

// Real Google product icons — official SVGs from Wikimedia Commons
// (public assets, commonly used on third-party sites; Premier Partner has usage rights)
// Production: download and self-host these for performance + reliability.

const GOOGLE_ICONS = {
  gmail:    "https://upload.wikimedia.org/wikipedia/commons/7/7e/Gmail_icon_%282020%29.svg",
  calendar: "https://upload.wikimedia.org/wikipedia/commons/a/a5/Google_Calendar_icon_%282020%29.svg",
  meet:     "https://upload.wikimedia.org/wikipedia/commons/9/9b/Google_Meet_icon_%282020%29.svg",
  drive:    "https://upload.wikimedia.org/wikipedia/commons/1/12/Google_Drive_icon_%282020%29.svg",
  docs:     "https://upload.wikimedia.org/wikipedia/commons/0/01/Google_Docs_2020_Logo.svg",
  sheets:   "https://upload.wikimedia.org/wikipedia/commons/a/ae/Google_Sheets_2020_Logo.svg",
  slides:   "https://upload.wikimedia.org/wikipedia/commons/1/1e/Google_Slides_2020_Logo.svg",
};

// The 7 core Google Workspace apps with descriptions + brand colors for fallback
const WORKSPACE_APPS = [
  { key: "gmail",    name: "Gmail",     desc: "Secure business email", color: "#EA4335" },
  { key: "calendar", name: "Calendar",  desc: "Smart scheduling",      color: "#1A73E8" },
  { key: "meet",     name: "Meet",      desc: "Video conferencing",    color: "#00897B" },
  { key: "drive",    name: "Drive",     desc: "Cloud storage",         color: "#FBBC04" },
  { key: "docs",     name: "Docs",      desc: "Word processing",       color: "#4285F4" },
  { key: "sheets",   name: "Sheets",    desc: "Spreadsheets",          color: "#34A853" },
  { key: "slides",   name: "Slides",    desc: "Presentations",         color: "#F4B400" },
];

function GoogleAppImg({ src, alt, size, fallbackColor = "#4285F4" }) {
  const [error, setError] = useState(false);
  if (error || !src) {
    return (
      <div style={{
        width: size,
        height: size,
        borderRadius: size * 0.22,
        background: fallbackColor,
        color: "#fff",
        display: "grid",
        placeItems: "center",
        fontFamily: "'Product Sans', 'Plus Jakarta Sans', sans-serif",
        fontSize: size * 0.42,
        fontWeight: 500,
        letterSpacing: "-0.02em",
        boxShadow: "0 1px 2px rgba(0,0,0,0.08)",
      }}>
        {alt[0]}
      </div>
    );
  }
  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{ display: "block", width: size, height: size, objectFit: "contain" }}
      loading="lazy"
      onError={() => setError(true)}
    />
  );
}

function GmailIcon({ size = 36 })    { return <GoogleAppImg src={GOOGLE_ICONS.gmail}    alt="Gmail"            size={size} />; }
function CalendarIcon({ size = 36 }) { return <GoogleAppImg src={GOOGLE_ICONS.calendar} alt="Google Calendar"  size={size} />; }
function DriveIcon({ size = 36 })    { return <GoogleAppImg src={GOOGLE_ICONS.drive}    alt="Google Drive"     size={size} />; }
function DocsIcon({ size = 36 })     { return <GoogleAppImg src={GOOGLE_ICONS.docs}     alt="Google Docs"      size={size} />; }
function MeetIcon({ size = 36 })     { return <GoogleAppImg src={GOOGLE_ICONS.meet}     alt="Google Meet"      size={size} />; }

// All 5 app icons in a row with labels (hero use)
function WorkspaceAppsStrip({ size = 40, showLabels = true, ink3 = "#6B6457" }) {
  const apps = [
    { Icon: GmailIcon,    name: "Gmail" },
    { Icon: CalendarIcon, name: "Calendar" },
    { Icon: DriveIcon,    name: "Drive" },
    { Icon: DocsIcon,     name: "Docs" },
    { Icon: MeetIcon,     name: "Meet" },
  ];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 18 }}>
      {apps.map((a) => (
        <div key={a.name} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <a.Icon size={size} />
          {showLabels && <span style={{ fontSize: 10, color: ink3, fontWeight: 500 }}>{a.name}</span>}
        </div>
      ))}
    </div>
  );
}

// Mock Gmail + Gemini AI suggestion UI for hero — shows AI in action
function GmailGeminiMock({ accent }) {
  return (
    <div style={{
      background: "#fff",
      borderRadius: 14,
      boxShadow: "0 20px 60px rgba(0,0,0,0.15), 0 4px 12px rgba(0,0,0,0.06)",
      overflow: "hidden",
      border: "1px solid #E8E2D4",
      maxWidth: 400,
    }}>
      {/* Gmail header */}
      <div style={{ background: "#F6F8FC", padding: "10px 14px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #E8E2D4" }}>
        <GmailIcon size={22} />
        <div style={{ fontSize: 12, fontWeight: 600, color: "#202124" }}>Compose · Gmail</div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#FBBC04" }} />
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: "#34A853" }} />
        </div>
      </div>

      {/* Email body */}
      <div style={{ padding: "14px 16px", fontSize: 12, color: "#202124", lineHeight: 1.6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
          <span style={{ color: "#5F6368", width: 30, fontSize: 11 }}>To:</span>
          <span style={{ color: "#202124", fontWeight: 500 }}>rajesh@acmecorp.com</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, paddingBottom: 8, borderBottom: "1px solid #E8E2D4" }}>
          <span style={{ color: "#5F6368", width: 30, fontSize: 11 }}>Subject:</span>
          <span style={{ color: "#202124", fontWeight: 500 }}>Re: Workspace plan upgrade</span>
        </div>
        <div style={{ color: "#5F6368", fontStyle: "italic" }}>Hi Rajesh, thanks for considering...</div>
      </div>

      {/* Gemini AI suggestion bubble */}
      <div style={{
        margin: "0 14px 14px",
        background: "linear-gradient(135deg, #E8F0FE 0%, #FCE8FC 100%)",
        border: "1px solid #C5B5F7",
        borderRadius: 10,
        padding: 12,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <svg width="14" height="14" viewBox="0 0 24 24">
            <defs>
              <linearGradient id="gemspark" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%" stopColor="#4285F4"/>
                <stop offset="50%" stopColor="#9333EA"/>
                <stop offset="100%" stopColor="#EC4899"/>
              </linearGradient>
            </defs>
            <path fill="url(#gemspark)" d="M12 2 L14 9 L21 11 L14 13 L12 20 L10 13 L3 11 L10 9 Z"/>
          </svg>
          <span style={{ fontSize: 10, fontWeight: 700, color: "#5F6368", textTransform: "uppercase", letterSpacing: "0.08em" }}>Help me write · Gemini AI</span>
        </div>
        <div style={{ fontSize: 11, color: "#202124", lineHeight: 1.5, marginBottom: 8 }}>
          "Thanks for considering Workspace Plus. Based on Acme's 25-seat team, I'd recommend the annual plan — saves ₹46,200/year with built-in GST..."
        </div>
        <div style={{ display: "flex", gap: 6 }}>
          <button style={{ background: accent, color: "#fff", border: "none", padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 600, cursor: "pointer" }}>Insert</button>
          <button style={{ background: "transparent", color: "#5F6368", border: "1px solid #DADCE0", padding: "5px 10px", borderRadius: 6, fontSize: 10, fontWeight: 500, cursor: "pointer" }}>Refine</button>
        </div>
      </div>
    </div>
  );
}

// 13-app grid showing what's included in Workspace
function WorkspaceFullGrid({ size = 56, ink, ink3, hair }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 16 }}>
      {WORKSPACE_APPS.map(app => (
        <div key={app.key} style={{
          background: app.isAi ? "linear-gradient(135deg, #F3E8FF 0%, #FCE8FC 100%)" : "#fff",
          border: "1px solid " + (app.isAi ? "#C5B5F7" : hair),
          borderRadius: 12,
          padding: 16,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 8,
          transition: "transform 200ms, box-shadow 200ms",
          cursor: "default",
        }}
          onMouseEnter={(e) => { e.currentTarget.style.transform = "translateY(-2px)"; e.currentTarget.style.boxShadow = "0 8px 20px rgba(0,0,0,0.08)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.transform = "translateY(0)"; e.currentTarget.style.boxShadow = "none"; }}>
          <GoogleAppImg src={GOOGLE_ICONS[app.key]} alt={app.name} size={size} fallbackColor={app.color} />
          <div style={{ fontSize: 12, fontWeight: 600, color: ink, textAlign: "center" }}>{app.name}</div>
          <div style={{ fontSize: 10, color: ink3, textAlign: "center", lineHeight: 1.3 }}>{app.desc}</div>
        </div>
      ))}
    </div>
  );
}

// Gemini sparkle SVG (used inline for AI sections)
function GeminiSpark({ size = 24 }) {
  const id = "spark-" + Math.random().toString(36).slice(2);
  return (
    <svg width={size} height={size} viewBox="0 0 24 24">
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#4285F4"/>
          <stop offset="50%" stopColor="#9333EA"/>
          <stop offset="100%" stopColor="#EC4899"/>
        </linearGradient>
      </defs>
      <path fill={`url(#${id})`} d="M12 2 L14 9 L21 11 L14 13 L12 20 L10 13 L3 11 L10 9 Z"/>
    </svg>
  );
}

const PRODUCT_CONFIGS = {
  workspace: {
    brand: "Google Workspace",
    vendor: "google",
    accent: "#1A73E8",     // Google Blue
    accentSoft: "#E8F0FE",
    googleColors: {
      blue:   "#4285F4",
      red:    "#EA4335",
      yellow: "#FBBC04",
      green:  "#34A853",
      grey:   "#5F6368",
    },
    headline: "Move your team to Google Workspace in 24 hours.",
    tagline: "Same Google price. With GST invoice, free migration, and Hindi/English support — all included.",
    priceFrom: 136,
    heroSub: "Same price as buying direct from Google. With GST invoice, free onboarding, and WhatsApp support in Hindi/English.",
    tiers: [
      { id: "GW-STR", name: "Starter",     price: 136,  bestFor: "Small teams trying Google Workspace",  storage: "30 GB / user", storageMultiplier: null,         participants: 100, recording: false, security: "Basic",     gemini: false, most_popular: false, promo: null,         features: ["Custom email @yourdomain.in", "30 GB storage per user", "100-participant video meetings", "Standard 2-step verification", "Basic support"] },
      { id: "GW-STD", name: "Standard",    price: 736,  bestFor: "Growing teams that need meeting recording", storage: "2 TB / user",  storageMultiplier: "65× more than Starter", participants: 150, recording: true,  security: "Standard",  gemini: true,  most_popular: true,  promo: "20% off · first 20 users · 12 months", features: ["**All of Starter**, and:", "2 TB pooled storage per user · 65× more", "Meeting recording + noise cancellation", "150-participant video meetings", "Gemini AI in Gmail, Docs, Meet", "Shared Drives + Vault basic"] },
      { id: "GW-PLS", name: "Plus",        price: 1380, bestFor: "Mid-market with security needs",      storage: "5 TB / user",  storageMultiplier: "2.5× more than Standard", participants: 500, recording: true,  security: "Advanced",  gemini: true,  most_popular: false, promo: null,         features: ["**All of Standard**, and:", "5 TB pooled storage per user", "500-participant meetings + attendance tracking", "Advanced endpoint management", "Vault retention + eDiscovery", "S/MIME encryption"] },
      { id: "GW-ENT", name: "Enterprise",  price: 2400, bestFor: "Large organisations · regulated industries", storage: "Unlimited",    storageMultiplier: "Truly unlimited",         participants: 1000, recording: true, security: "Enterprise", gemini: true,  most_popular: false, promo: null,         features: ["**All of Plus**, and:", "Unlimited storage · no caps", "1,000-participant meetings with live streaming", "Advanced data loss prevention (DLP)", "Context-aware access policies", "S/MIME encryption + key management", "Cloud Identity Premium"] },
    ],
    addons: [],
    faq: [
      { q: "Is the price same as buying direct from Google?", a: "Yes, exactly the same per-seat price. Reseller margin is built into Google's pricing — there's no markup. You pay the same ₹136/₹736/₹1,380/₹2,400 either way." },
      { q: "Do I get a proper GST invoice?", a: "Absolutely. Every invoice has a valid GSTIN (27AABCE9876D1Z3), HSN code 998313, IRN, and is e-invoice compliant. You can claim full input tax credit." },
      { q: "How fast is the setup?", a: "Same-day for Starter. For Standard/Plus/Enterprise: typical 24–48 hours including DNS, MX, SPF, DKIM, DMARC setup and one round of admin training." },
      { q: "Can I add or remove users mid-cycle?", a: "Yes. Adding users is pro-rata billed (you pay only for remaining days till next renewal). Removing users frees the seat at next renewal." },
      { q: "What if I want to switch from Microsoft 365?", a: "We handle the entire migration: email, contacts, calendar, OneDrive files, Teams data. Free migration for any deal ₹50K+." },
      { q: "Are you a certified Google partner?", a: "Yes — Authorised Google Cloud Partner since 2024. All our consultants are Google Workspace Administrator certified." },
    ],
  },

  m365: {
    brand: "Microsoft 365 Business",
    vendor: "microsoft",
    accent: "#2563EB",
    accentSoft: "#DBEAFE",
    headline: "Get Microsoft 365 with proper GST invoicing.",
    tagline: "Same Microsoft price. With free migration from on-prem Exchange and unlimited WhatsApp support — Hindi/English.",
    priceFrom: 200,
    heroSub: "Same price as buying direct from Microsoft. With proper GST invoice, free migration from on-premises Exchange, and unlimited WhatsApp support.",
    tiers: [
      { id: "M365-BB", name: "Business Basic",    price: 200,  bestFor: "Email + Teams + web Office",        storage: "50 GB mailbox · 1 TB OneDrive", desktop: false, security: "Standard",       most_popular: false, promo: null,                                       features: ["Outlook + Teams + web Office", "50 GB mailbox · 1 TB OneDrive", "Custom email @yourdomain.in", "Web/mobile Office apps", "Standard support"] },
      { id: "M365-BS", name: "Business Standard", price: 990,  bestFor: "Full desktop Office apps",          storage: "50 GB mailbox · 1 TB OneDrive", desktop: true,  security: "Standard",       most_popular: true,  promo: "20% off · first 20 users · 12 months",      features: ["**All of Basic**, and:", "Desktop Word, Excel, PowerPoint, Outlook", "Webinar hosting + Bookings", "Forms + Lists + Loop", "Microsoft Copilot ready (add-on)"] },
      { id: "M365-BP", name: "Business Premium",  price: 1900, bestFor: "Security-conscious businesses",     storage: "50 GB mailbox · 1 TB OneDrive", desktop: true,  security: "Advanced (Defender + Intune)", most_popular: false, promo: null,                          features: ["**All of Standard**, and:", "Microsoft Defender (anti-phishing + AV)", "Intune device management", "Conditional access policies", "Information protection (sensitivity labels)", "Azure AD Premium P1"] },
    ],
    addons: [],
    faq: [
      { q: "Is the price same as buying direct from Microsoft?", a: "Yes. Our pricing matches Microsoft Partner Center pricing exactly. Reseller margin is Microsoft-funded; you don't pay any markup." },
      { q: "Do I get a GST invoice?", a: "Yes. Full GST invoice with GSTIN, HSN 998313, e-invoice IRN. Reconciles cleanly in your input tax credit." },
      { q: "Can you migrate us from Google Workspace?", a: "Yes. Full mail, contact, calendar, and file migration from Google Workspace, Zoho, or on-prem Exchange. Free for deals ₹50K+." },
      { q: "Do we get Microsoft Teams?", a: "Yes — Teams is included in all plans (Basic, Standard, Premium). Voice & calling can be added separately." },
      { q: "What about Copilot AI?", a: "Microsoft Copilot is available as an add-on (₹2,499/user/month) on top of any Business plan. Talk to us about pilot pricing." },
      { q: "Are you a certified Microsoft partner?", a: "Yes — Microsoft Solutions Partner for Modern Work (CSP Tier 1). Active since 2024." },
    ],
  },

  zoho: {
    brand: "Zoho Workplace",
    vendor: "zoho",
    accent: "#DC2626",
    accentSoft: "#FEE2E2",
    headline: "Made-in-India productivity at 1/5th the cost.",
    tagline: "Same Zoho price. Data stored in Mumbai (DPDP compliant). With GST invoice and free migration.",
    priceFrom: 120,
    heroSub: "Same low Zoho pricing. With GST invoice, Indian timezone support, and free migration from your current setup.",
    tiers: [
      { id: "ZW-STD", name: "Standard",     price: 120, bestFor: "Small teams on a budget",      storage: "30 GB mail / 10 GB drive",  most_popular: true,  promo: "Made-in-India · Mumbai data centre", features: ["Email + Calendar + Contacts", "Cliq (chat) + Meeting", "WorkDrive 10 GB / user", "Writer + Sheet + Show (online)", "30 GB mailbox"] },
      { id: "ZW-PRO", name: "Professional", price: 280, bestFor: "Growing teams needing more storage", storage: "100 GB mail / 100 GB drive", most_popular: false, promo: null,                              features: ["**All of Standard**, and:", "100 GB mailbox · ~3× more", "100 GB WorkDrive per user · 10× more", "Connect (employee social)", "Showtime (training delivery)", "Email retention policies"] },
    ],
    addons: [],
    faq: [
      { q: "Why Zoho instead of Google or Microsoft?", a: "Zoho is ~5x cheaper for similar core features (email + drive + chat + meeting). Great for cost-conscious SMEs and businesses that want a single Indian vendor across many tools (CRM, Books, etc.)." },
      { q: "Is Zoho data hosted in India?", a: "Yes. Zoho has data centres in Chennai and Mumbai. Your data stays within India, meeting DPDP Act 2023 data localisation expectations." },
      { q: "Can I migrate from Gmail / Outlook?", a: "Yes. Full email + contact + calendar migration tool included. Most migrations complete within 24 hours." },
      { q: "What's included in Workplace vs Zoho One?", a: "Workplace is the productivity suite (email, drive, chat, meet). Zoho One is the full business suite (45+ apps including CRM, Books, Inventory). Workplace is enough for ~80% of SMEs." },
      { q: "Do you charge for setup?", a: "No. DNS, MX, SPF, DKIM, DMARC setup is free for all plans. Includes 1 training session for admins." },
      { q: "What if Zoho goes down?", a: "99.9% uptime SLA. In 5+ years of reselling Zoho, we've seen 2-3 outages total, each under 30 minutes." },
    ],
  },
};

function BuyCloudScreen({ productKey }) {
  const cfg = PRODUCT_CONFIGS[productKey];
  const [seats, setSeats] = useState(25);
  const [selectedTier, setSelectedTier] = useState(cfg.tiers.find(t => t.most_popular)?.id || cfg.tiers[0].id);
  const [showLeadForm, setShowLeadForm] = useState(false);
  const [showBuyNow, setShowBuyNow] = useState(false);
  const [showTrial, setShowTrial] = useState(false);
  const [activeTier, setActiveTier] = useState(null);
  const { toast } = useToast();
  const { go } = useRouter();

  const tier = cfg.tiers.find(t => t.id === selectedTier);
  const monthly = tier.price * seats;
  const annual = monthly * 12;
  const annualDiscount = Math.round(annual * 0.05);

  const openLeadForm = (forTier) => { setActiveTier(forTier); setShowLeadForm(true); };
  const openBuyNow   = (forTier) => { setActiveTier(forTier); setShowBuyNow(true); };
  const openTrial    = (forTier) => { setActiveTier(forTier); setShowTrial(true); };

  const goToBuilder = (forTier) => {
    window.__quoteFromList = {
      id: "Q-DRAFT",
      customer: "",
      plan: `${forTier.name}${cfg.brand.includes("Workspace") ? " Workspace" : ""}`,
      seats: seats,
      leadId: null,
    };
    go("quote-builder");
  };

  const bgPaper = "#FAF8F2";
  const ink = "#1A1815";
  const ink3 = "#6B6457";
  const hair = "#E8E2D4";

  return (
    <div style={{ background: bgPaper, color: ink, minHeight: "100vh", fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>

      {/* PREMIER PARTNER BAR — top credibility */}
      <div style={{ background: "linear-gradient(90deg, #1A1815 0%, #2D2418 50%, #1A1815 100%)", color: "#FBBF24", padding: "8px 24px", textAlign: "center", fontSize: 12, fontWeight: 500, letterSpacing: "0.02em", borderBottom: "1px solid #3A2F22" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 14 }}>★</span>
          <span><b style={{ color: "#FCD34D" }}>{cfg.brand.split(" ")[0]} Premier Partner</b> · Top 5% of partners globally · One of fewer than 50 Premier Partners in India</span>
          <span style={{ opacity: 0.5 }}>·</span>
          <span style={{ color: "#FAF8F2", opacity: 0.8 }}>Direct escalation path to {cfg.brand.split(" ")[0]} engineering</span>
        </div>
      </div>

      {/* PROMO BANNER — urgency + scarcity */}
      <div style={{ background: "#1A1815", color: "#FAF8F2", padding: "10px 24px", textAlign: "center", fontSize: 13 }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "center", gap: 12, flexWrap: "wrap" }}>
          <span style={{ background: cfg.accent, color: "#fff", padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>Limited</span>
          <span><b>Premier Partner exclusive:</b> 20% off first 20 users for 12 months · Free migration worth ₹50K</span>
          <span style={{ opacity: 0.6 }}>·</span>
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <I name="clock" size={12} /> Ends 31 Dec 2026 · 47 of 100 spots claimed
          </span>
        </div>
      </div>

      {/* Top nav bar */}
      <div style={{ borderBottom: "1px solid " + hair, background: "#fff", position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 32, height: 32, background: ink, color: bgPaper, borderRadius: 6, display: "grid", placeItems: "center", fontFamily: "'DM Serif Display', serif", fontSize: 18 }}>R</div>
            <div>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 18, lineHeight: 1 }}>Demo Co</div>
              <div style={{ fontSize: 10, color: ink3, marginTop: 2 }}>Authorised Cloud Reseller · India</div>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 16, fontSize: 13 }}>
            <a href="#/buy-workspace" style={{ color: productKey === "workspace" ? cfg.accent : ink, fontWeight: productKey === "workspace" ? 600 : 400 }}>Workspace</a>
            <a href="#/buy-m365" style={{ color: productKey === "m365" ? cfg.accent : ink, fontWeight: productKey === "m365" ? 600 : 400 }}>Microsoft 365</a>
            <a href="#/buy-zoho" style={{ color: productKey === "zoho" ? cfg.accent : ink, fontWeight: productKey === "zoho" ? 600 : 400 }}>Zoho</a>
            <button onClick={() => openLeadForm(tier)} style={{ background: cfg.accent, color: "#fff", border: "none", padding: "8px 14px", borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: "pointer" }}>
              Get a quote
            </button>
          </div>
        </div>
      </div>

      {/* HERO */}
      <div style={{ background: "linear-gradient(180deg, " + cfg.accentSoft + " 0%, " + bgPaper + " 100%)", padding: "60px 24px 48px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 48, alignItems: "center" }}>
          <div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "linear-gradient(135deg, #1A1815 0%, #2D2418 100%)", color: "#FCD34D", padding: "7px 14px", borderRadius: 999, fontSize: 11, fontWeight: 600, marginBottom: 16, boxShadow: "0 4px 12px rgba(0,0,0,0.15)", border: "1px solid #FBBF24" }}>
              <span style={{ fontSize: 13 }}>★</span>
              <span style={{ color: "#FCD34D" }}>{cfg.brand.split(" ")[0]} Premier Partner</span>
              <span style={{ color: "#FAF8F2", opacity: 0.6, fontWeight: 400 }}>· Top 5% globally</span>
            </div>

            {/* Official Google Workspace logotype + Premier Partner badge + Gemini eyebrow (workspace only) */}
            {productKey === "workspace" && (
              <div style={{ marginBottom: 16, display: "flex", alignItems: "center", gap: 20 }}>
                <div>
                  <GoogleWorkspaceLogo size={42} />
                  <div style={{ marginTop: 10, display: "inline-flex", alignItems: "center", gap: 6, background: "linear-gradient(135deg, #E8F0FE 0%, #FCE8FC 100%)", border: "1px solid #C5B5F7", padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600, color: "#5F6368" }}>
                    <GeminiSpark size={12} />
                    <span>Workspace Intelligence · <span style={{ color: "#9333EA" }}>Gemini AI included</span></span>
                  </div>
                </div>
                <PremierPartnerBadge size={108} type="workspace" />
              </div>
            )}

            <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: productKey === "workspace" ? 38 : 52, lineHeight: 1.1, margin: 0, marginBottom: 16, letterSpacing: "-0.01em" }}>
              {cfg.headline || cfg.brand}
            </h1>
            <p style={{ fontSize: 17, lineHeight: 1.55, color: ink3, marginBottom: 20 }}>
              {cfg.tagline}
            </p>
            <div style={{ display: "flex", gap: 18, marginBottom: 24, fontSize: 13, color: ink, flexWrap: "wrap" }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><I name="check_circle" size={14} style={{ color: "#166534" }} /> Same price as direct</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><I name="check_circle" size={14} style={{ color: "#166534" }} /> Live in 24 hours</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><I name="check_circle" size={14} style={{ color: "#166534" }} /> Hindi + English support</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}><I name="check_circle" size={14} style={{ color: "#166534" }} /> Cancel anytime</span>
            </div>
            <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
              <button onClick={() => openBuyNow(tier)} style={{ background: cfg.accent, color: "#fff", border: "none", padding: "12px 22px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8, boxShadow: "0 4px 14px " + cfg.accent + "55" }}>
                <I name="cart" size={14} /> Buy {tier.name} now
              </button>
              <button onClick={() => openTrial(tier)} style={{ background: "#fff", color: cfg.accent, border: "1.5px solid " + cfg.accent, padding: "12px 22px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                <I name="spark" size={14} /> Start 14-day trial
              </button>
            </div>
            <div style={{ display: "flex", gap: 14, marginBottom: 16, fontSize: 12, color: ink3 }}>
              <button onClick={() => openLeadForm(tier)} style={{ background: "transparent", color: ink, border: "none", padding: 0, cursor: "pointer", fontSize: 12, textDecoration: "underline", textUnderlineOffset: 3 }}>
                Or get a custom quote
              </button>
              <span>·</span>
              <button onClick={() => toast("Opening WhatsApp chat with Demo Co sales…")} style={{ background: "transparent", color: ink, border: "none", padding: 0, cursor: "pointer", fontSize: 12, textDecoration: "underline", textUnderlineOffset: 3, display: "inline-flex", alignItems: "center", gap: 4 }}>
                <I name="whatsapp" size={12} style={{ color: "#25D366" }} /> Chat on WhatsApp
              </button>
            </div>

            {/* LIVE ACTIVITY TICKER — social proof + FOMO */}
            <ActivityTicker accent={cfg.accent} ink3={ink3} hair={hair} brand={cfg.brand} />
          </div>

          {/* Live calculator */}
          <div style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, padding: 24, boxShadow: "0 8px 24px rgba(0,0,0,0.04)" }}>
            <div style={{ fontSize: 11, color: ink3, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 }}>Calculate your price</div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: ink3, marginBottom: 4 }}>Plan</div>
              <select value={selectedTier} onChange={(e) => setSelectedTier(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 6, border: "1px solid " + hair, fontSize: 13 }}>
                {cfg.tiers.map(t => <option key={t.id} value={t.id}>{t.name} — ₹{t.price}/user/mo</option>)}
              </select>
            </div>
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 12, color: ink3, marginBottom: 6 }}>Number of users</div>
              <div style={{ display: "flex", alignItems: "center", gap: 0, border: "1px solid " + hair, borderRadius: 8, overflow: "hidden" }}>
                <button onClick={() => setSeats(Math.max(1, seats - 5))} style={{ width: 44, height: 44, background: "#fff", color: ink, border: "none", cursor: "pointer", fontSize: 18, fontWeight: 600, borderRight: "1px solid " + hair }}>−</button>
                <input
                  type="number"
                  value={seats}
                  min={1}
                  max={1000}
                  onChange={(e) => setSeats(Math.max(1, Math.min(1000, +e.target.value || 1)))}
                  style={{ flex: 1, textAlign: "center", border: "none", padding: "10px", fontSize: 18, fontWeight: 600, fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontVariantNumeric: "tabular-nums" }}
                />
                <button onClick={() => setSeats(Math.min(1000, seats + 5))} style={{ width: 44, height: 44, background: "#fff", color: ink, border: "none", cursor: "pointer", fontSize: 18, fontWeight: 600, borderLeft: "1px solid " + hair }}>+</button>
              </div>
              <div style={{ display: "flex", gap: 4, marginTop: 6, flexWrap: "wrap" }}>
                {[10, 25, 50, 100].map(n => (
                  <button key={n} onClick={() => setSeats(n)} style={{ background: seats === n ? cfg.accentSoft : "transparent", color: seats === n ? cfg.accent : ink3, border: "1px solid " + (seats === n ? cfg.accent : hair), padding: "3px 10px", borderRadius: 999, fontSize: 11, cursor: "pointer", fontWeight: 500 }}>
                    {n} users
                  </button>
                ))}
              </div>
            </div>
            <div style={{ background: cfg.accentSoft, padding: 14, borderRadius: 8, marginBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: ink3 }}>Monthly</span>
                <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: cfg.accent }} className="tnum">{rupee(monthly)}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <span style={{ fontSize: 12, color: ink3 }}>Annual</span>
                <span className="tnum" style={{ fontSize: 14, fontWeight: 600 }}>{rupee(annual)}</span>
              </div>
              <div style={{ fontSize: 10, color: ink3, fontStyle: "italic" }}>+ 18% GST · saves {rupee(annualDiscount)} with annual prepay</div>
            </div>
            <button onClick={() => openBuyNow(tier)} style={{ width: "100%", background: cfg.accent, color: "#fff", border: "none", padding: "12px", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, marginBottom: 8 }}>
              <I name="cart" size={14} /> Buy {seats} users · {rupee(monthly)}/mo
            </button>
            <button onClick={() => openTrial(tier)} style={{ width: "100%", background: "#fff", color: cfg.accent, border: "1.5px solid " + cfg.accent, padding: "10px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Or start 14-day free trial
            </button>
          </div>
        </div>

        {/* Trust + numbers strip */}
        <div style={{ maxWidth: 1180, margin: "48px auto 0", display: "flex", justifyContent: "space-around", alignItems: "center", flexWrap: "wrap", gap: 24, paddingTop: 24, borderTop: "1px solid " + hair }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: ink3 }}>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 28, color: ink }}>247+</span>
            <span>Indian businesses</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: ink3 }}>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 28, color: ink }}>4.8★</span>
            <span>Google rating</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: ink3 }}>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 28, color: ink }}>24h</span>
            <span>Avg deployment</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12, color: ink3 }}>
            <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 28, color: ink }}>99.9%</span>
            <span>Renewal rate</span>
          </div>
        </div>
      </div>

      {/* 3 PILLARS — Google's value trinity (workspace only) */}
      {productKey === "workspace" && (
        <div style={{ background: "#fff", borderTop: "1px solid " + hair, padding: "70px 24px" }}>
          <div style={{ maxWidth: 1180, margin: "0 auto" }}>
            <div style={{ textAlign: "center", marginBottom: 44 }}>
              <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 8 }}>The better way to work</div>
              <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, margin: 0, lineHeight: 1.15, letterSpacing: "-0.01em" }}>
                All the tools you need. And a few more we think you'll love.
              </h2>
              <p style={{ fontSize: 14, color: ink3, marginTop: 12, maxWidth: 680, margin: "12px auto 0" }}>
                Join millions of businesses running on Google Workspace — now with built-in AI, designed for Indian SMEs by your Premier Partner.
              </p>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
              {[
                {
                  iconBg: "linear-gradient(135deg, #E8F0FE 0%, #FCE8FC 100%)",
                  iconColor: "#9333EA",
                  iconCustom: <GeminiSpark size={24} />,
                  title: "Personalized AI built-in",
                  body: "Gemini AI in Gmail, Docs, Meet, and Sheets — write faster, summarize meetings, draft replies. Standard plan and above includes full Gemini access.",
                  badge: "Powered by Gemini",
                },
                {
                  iconBg: "#E8F0FE",
                  iconColor: "#1A73E8",
                  iconName: "globe",
                  title: "Tools born in the Cloud",
                  body: "Real-time collaboration across all your apps. Edit Docs simultaneously, share Drive files, hop on Meet — all from any device, anywhere.",
                  badge: "Always in sync",
                },
                {
                  iconBg: "#E6F4EA",
                  iconColor: "#188038",
                  iconName: "shield",
                  title: "Indian-grade security",
                  body: "Enterprise security + DPDP Act 2023 compliance + GST-compliant invoicing. We handle the India-specific bits Google itself doesn't.",
                  badge: "DPDP + GST ready",
                },
              ].map(p => (
                <div key={p.title} style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 14, padding: 28, position: "relative" }}>
                  <div style={{ width: 52, height: 52, borderRadius: 14, background: p.iconBg, color: p.iconColor, display: "grid", placeItems: "center", marginBottom: 18 }}>
                    {p.iconCustom || <I name={p.iconName} size={26} />}
                  </div>
                  <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, marginBottom: 10, lineHeight: 1.2 }}>{p.title}</div>
                  <div style={{ fontSize: 13, color: ink3, lineHeight: 1.6, marginBottom: 14 }}>{p.body}</div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 600, color: p.iconColor, background: p.iconBg, padding: "4px 10px", borderRadius: 999 }}>
                    {p.badge}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* GEMINI AI SHOWCASE — AI in action with mock UI (workspace only) */}
      {productKey === "workspace" && (
        <div style={{ background: "linear-gradient(180deg, #F8F4FF 0%, #FFF1F8 100%)", padding: "70px 24px", borderTop: "1px solid #E5D5FA" }}>
          <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 56, alignItems: "center" }}>
            <div>
              <div style={{ display: "inline-flex", alignItems: "center", gap: 8, marginBottom: 16 }}>
                <GeminiSpark size={28} />
                <span style={{ fontSize: 12, fontWeight: 700, color: "#9333EA", textTransform: "uppercase", letterSpacing: "0.1em" }}>Gemini AI for Workspace</span>
              </div>
              <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, lineHeight: 1.1, margin: 0, marginBottom: 16, letterSpacing: "-0.01em" }}>
                Your team's new<br />
                <span style={{ background: "linear-gradient(90deg, #4285F4 0%, #9333EA 50%, #EC4899 100%)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>AI collaborator</span> — built right in.
              </h2>
              <p style={{ fontSize: 15, color: ink3, lineHeight: 1.6, marginBottom: 24 }}>
                Gemini lives inside Gmail, Docs, Sheets, Meet — drafting emails, summarizing 50-message threads, taking meeting notes, and generating data insights. It works in context of YOUR business data.
              </p>
              <div style={{ display: "grid", gap: 12, marginBottom: 24 }}>
                {[
                  { app: "Gmail",  text: "Draft replies + summarize long email threads" },
                  { app: "Docs",   text: '"Help me write" — first drafts of proposals, emails, briefs' },
                  { app: "Meet",   text: "Automatic meeting notes + action item extraction" },
                  { app: "Sheets", text: "Generate formulas, analyze data trends in plain English" },
                ].map(item => (
                  <div key={item.app} style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13 }}>
                    <GeminiSpark size={14} />
                    <span><b>{item.app}:</b> {item.text}</span>
                  </div>
                ))}
              </div>
              <div style={{ background: "#fff", border: "1px solid #C5B5F7", padding: "12px 16px", borderRadius: 10, fontSize: 12, color: ink, display: "flex", alignItems: "center", gap: 10 }}>
                <I name="info" size={14} style={{ color: "#9333EA", flexShrink: 0 }} />
                <span><b>Included in Standard, Plus, and Enterprise plans</b> — no separate Gemini subscription needed (₹2,499/mo retail value).</span>
              </div>
            </div>

            {/* Mock Gmail + Gemini UI */}
            <div style={{ display: "flex", justifyContent: "center" }}>
              <GmailGeminiMock accent={cfg.accent} />
            </div>
          </div>
        </div>
      )}

      {/* FULL WORKSPACE INCLUDES — 13 app grid (workspace only) */}
      {productKey === "workspace" && (
        <div style={{ background: "#fff", padding: "70px 24px", borderTop: "1px solid " + hair }}>
          <div style={{ maxWidth: 1180, margin: "0 auto" }}>
            <div style={{ textAlign: "center", marginBottom: 44 }}>
              <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 8 }}>Google Workspace includes</div>
              <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, margin: 0, lineHeight: 1.15, letterSpacing: "-0.01em" }}>
                Everything your team needs. One subscription.
              </h2>
              <p style={{ fontSize: 14, color: ink3, marginTop: 12, maxWidth: 580, margin: "12px auto 0" }}>
                Every plan includes the full app suite. The only difference between tiers is storage, meeting participants, and security depth.
              </p>
            </div>
            <WorkspaceFullGrid size={56} ink={ink} ink3={ink3} hair={hair} />
          </div>
        </div>
      )}

      {/* RISK REVERSAL STRIP — objection killing */}
      <div style={{ background: "#fff", borderTop: "1px solid " + hair, borderBottom: "1px solid " + hair, padding: "24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 16 }}>
          {[
            { icon: "shield",       title: "30-day money-back",     sub: "Not happy? Full refund, no questions" },
            { icon: "rocket",       title: "Free migration",        sub: "We move you from any vendor · ₹50K value" },
            { icon: "x_circle",     title: "Cancel anytime",        sub: "No lock-in · pro-rata refund on cancellation" },
            { icon: "whatsapp",     title: "2-hour response SLA",   sub: "Hindi/English · 9 AM–9 PM IST" },
          ].map(card => (
            <div key={card.title} style={{ display: "flex", gap: 12, alignItems: "flex-start" }}>
              <div style={{ width: 36, height: 36, borderRadius: 8, background: cfg.accentSoft, color: cfg.accent, display: "grid", placeItems: "center", flexShrink: 0 }}>
                <I name={card.icon} size={18} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{card.title}</div>
                <div style={{ fontSize: 11, color: ink3, lineHeight: 1.5, marginTop: 2 }}>{card.sub}</div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* PREMIER PARTNER BENEFITS — what this badge means for the customer */}
      <div style={{ background: "linear-gradient(180deg, #FAF8F2 0%, #FFFBF0 100%)", borderBottom: "1px solid " + hair, padding: "60px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            {/* Official Premier Partner badge — anchor at top center */}
            {productKey === "workspace" && (
              <div style={{ display: "flex", justifyContent: "center", marginBottom: 20 }}>
                <PremierPartnerBadge size={160} type="workspace" />
              </div>
            )}
            <div style={{ display: "inline-flex", alignItems: "center", gap: 8, background: "linear-gradient(135deg, #1A1815 0%, #2D2418 100%)", color: "#FCD34D", padding: "6px 14px", borderRadius: 999, fontSize: 11, fontWeight: 600, marginBottom: 12, border: "1px solid #FBBF24" }}>
              <span style={{ fontSize: 12 }}>★</span> Why Premier Partner status matters
            </div>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0, lineHeight: 1.15 }}>
              Buying through us gets you what vendor-direct can't.
            </h2>
            <p style={{ fontSize: 14, color: ink3, marginTop: 12, maxWidth: 640, margin: "12px auto 0" }}>
              {cfg.brand.split(" ")[0]} awards Premier Partner status to fewer than 5% of resellers globally — based on revenue, customer satisfaction, and technical certifications. Here's what that means for you.
            </p>
          </div>

          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {[
              {
                icon: "zap",
                title: "Priority escalation",
                metric: "4-hour SLA",
                body: "We have a dedicated escalation channel to Google engineering. Average ticket resolution is 4 hours · vendor-direct support is typically 48 hours.",
              },
              {
                icon: "sparkles",
                title: "Beta access early",
                metric: "Before public release",
                body: "Premier Partners get new {brand} features in beta — sometimes months ahead of public rollout. Your team adopts new capabilities first.",
              },
              {
                icon: "handshake",
                title: "Higher discount tiers",
                metric: "Up to 15% better pricing",
                body: "Premier-tier partners qualify for the deepest vendor discounts. We pass these savings to you on multi-year and high-seat-count commitments.",
              },
              {
                icon: "award",
                title: "Certified consultants",
                metric: "8+ certifications on staff",
                body: "Our team carries multiple {brand} certifications — Cloud Workspace Admin, Collaboration Engineer, Security Specialist. Real expertise, not just sales.",
              },
              {
                icon: "shield",
                title: "Direct co-sell with " + cfg.brand.split(" ")[0],
                metric: "Google-led referrals",
                body: cfg.brand.split(" ")[0] + "'s sales team actively refers customers to Premier Partners. We're on their radar — and so are our customers.",
              },
              {
                icon: "trending_up",
                title: "Stability commitment",
                metric: "₹2 Cr+ annual revenue",
                body: "Premier Partner status requires significant annual revenue with Google. We're financially committed long-term — we're not going anywhere.",
              },
            ].map(b => (
              <div key={b.title} style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, padding: 22, position: "relative" }}>
                <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 10 }}>
                  <div style={{ width: 38, height: 38, borderRadius: 8, background: "linear-gradient(135deg, #FBBF24 0%, #F59E0B 100%)", color: "#1A1815", display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <I name={b.icon === "handshake" ? "users" : b.icon} size={18} />
                  </div>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{b.title}</div>
                    <div style={{ fontSize: 11, color: "#92400E", fontWeight: 600, marginTop: 2, textTransform: "uppercase", letterSpacing: "0.06em" }}>{b.metric}</div>
                  </div>
                </div>
                <div style={{ fontSize: 12, color: ink3, lineHeight: 1.55 }}>
                  {b.body.replace(/\{brand\}/g, cfg.brand.split(" ")[0])}
                </div>
              </div>
            ))}
          </div>

          <div style={{ textAlign: "center", marginTop: 28, fontSize: 12, color: ink3, fontStyle: "italic" }}>
            <I name="info" size={12} /> Premier Partner status verified at <span className="mono">{cfg.vendor === "google" ? "cloud.google.com/find-a-partner" : cfg.vendor === "microsoft" ? "appsource.microsoft.com" : "zoho.com/partners"}</span>
          </div>
        </div>
      </div>

      {/* HOW IT WORKS — process clarity */}
      <div style={{ padding: "60px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 6 }}>How it works</div>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0 }}>From sign-up to fully deployed in 24 hours</h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, position: "relative" }}>
            {[
              { num: 1, title: "Pick your plan",     sub: "Use our calculator · or take the 30-sec quiz",                  time: "2 min",  icon: "package" },
              { num: 2, title: "Pay via Razorpay",    sub: "UPI · Card · Net banking · instant GST e-invoice issued",      time: "1 min",  icon: "lock" },
              { num: 3, title: "We set up your domain", sub: "DNS, MX, SPF, DKIM, DMARC · all done by our team",            time: "4 hours", icon: "settings" },
              { num: 4, title: "Team goes live",      sub: "Bulk-add users, train admins, start using",                    time: "< 24h",  icon: "rocket" },
            ].map((step, i, arr) => (
              <div key={step.num} style={{ position: "relative" }}>
                <div style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, padding: 20, height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <div style={{ width: 32, height: 32, borderRadius: 999, background: cfg.accent, color: "#fff", display: "grid", placeItems: "center", fontFamily: "'DM Serif Display', serif", fontSize: 16 }}>{step.num}</div>
                    <I name={step.icon} size={18} style={{ color: cfg.accent }} />
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{step.title}</div>
                  <div style={{ fontSize: 12, color: ink3, lineHeight: 1.5, marginBottom: 10 }}>{step.sub}</div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 4, background: cfg.accentSoft, color: cfg.accent, padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                    <I name="clock" size={10} /> {step.time}
                  </div>
                </div>
                {i < arr.length - 1 && (
                  <div style={{ position: "absolute", top: "50%", right: -10, transform: "translateY(-50%)", color: ink3, zIndex: 1, background: bgPaper, padding: 2 }}>
                    <I name="chevron_right" size={16} />
                  </div>
                )}
              </div>
            ))}
          </div>
          <div style={{ textAlign: "center", marginTop: 28, fontSize: 13, color: ink3 }}>
            <I name="info" size={12} /> If your domain setup is delayed past 24 hours, we refund 10% of your annual fee — guaranteed.
          </div>
        </div>
      </div>

      {/* PLAN RECOMMENDER QUIZ — decision support */}
      <PlanRecommender cfg={cfg} bgPaper={bgPaper} ink={ink} ink3={ink3} hair={hair} onPick={(t) => { document.getElementById("pricing")?.scrollIntoView({ behavior: "smooth" }); setSelectedTier(t.id); }} />

      {/* Pricing tier cards */}
      <div id="pricing" style={{ maxWidth: 1180, margin: "0 auto", padding: "60px 24px" }}>
        <div style={{ textAlign: "center", marginBottom: 36 }}>
          <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 6 }}>Pricing</div>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, margin: 0 }}>Pick the right plan for your team</h2>
          <p style={{ fontSize: 14, color: ink3, marginTop: 8 }}>All prices per user, per month, excluding GST · Annual billing</p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cfg.tiers.length}, 1fr)`, gap: 16 }}>
          {cfg.tiers.map(t => (
            <div key={t.id} style={{
              background: "#fff",
              border: t.most_popular ? `2px solid ${cfg.accent}` : "1px solid " + hair,
              borderRadius: 12,
              padding: 24,
              position: "relative",
              display: "flex",
              flexDirection: "column",
            }}>
              {t.most_popular && (
                <div style={{ position: "absolute", top: -10, left: 24, background: cfg.accent, color: "#fff", padding: "3px 10px", borderRadius: 999, fontSize: 10, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Most popular
                </div>
              )}
              {t.promo && (
                <div style={{ position: "absolute", top: -10, right: 24, background: "#166534", color: "#fff", padding: "3px 10px", borderRadius: 999, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em" }}>
                  {t.promo.split("·")[0].trim()}
                </div>
              )}
              <div style={{ fontSize: 13, color: ink3, marginBottom: 4 }}>{t.bestFor}</div>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                {t.name}
                {t.gemini && <span style={{ background: "linear-gradient(135deg, #8B5CF6 0%, #EC4899 100%)", color: "#fff", fontSize: 9, padding: "2px 6px", borderRadius: 4, fontWeight: 700, letterSpacing: "0.04em", fontFamily: "'Plus Jakarta Sans', system-ui" }}>+ GEMINI AI</span>}
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 4, marginBottom: 4 }}>
                <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, color: cfg.accent }} className="tnum">₹{t.price.toLocaleString("en-IN")}</span>
                <span style={{ fontSize: 12, color: ink3 }}>/user/mo</span>
              </div>
              <div style={{ fontSize: 11, color: "#166534", marginBottom: 14, fontWeight: 500 }}>
                Save 16% with annual billing
              </div>
              {t.promo && (
                <div style={{ background: "#FEF3C7", border: "1px solid #FDE68A", padding: "8px 10px", borderRadius: 6, fontSize: 11, color: "#92400E", marginBottom: 14, lineHeight: 1.5 }}>
                  <I name="spark" size={10} /> {t.promo}
                </div>
              )}
              <ul style={{ listStyle: "none", padding: 0, margin: 0, marginBottom: 20, flex: 1 }}>
                {t.features.map((f, i) => {
                  const isHeader = f.startsWith("**");
                  const cleaned = f.replace(/\*\*/g, "");
                  if (isHeader) {
                    return (
                      <li key={i} style={{ fontSize: 12, fontWeight: 600, color: ink, marginBottom: 8, paddingBottom: 8, borderBottom: "1px solid " + hair }}>
                        {cleaned}
                      </li>
                    );
                  }
                  return (
                    <li key={i} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 12, lineHeight: 1.5, marginBottom: 8 }}>
                      <I name="check" size={12} style={{ color: cfg.accent, flexShrink: 0, marginTop: 3 }} />
                      <span>{cleaned}</span>
                    </li>
                  );
                })}
              </ul>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                <button onClick={() => openBuyNow(t)} style={{ width: "100%", background: t.most_popular ? cfg.accent : ink, color: "#fff", border: "none", padding: "10px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <I name="cart" size={12} /> Buy {t.name}
                </button>
                <button onClick={() => openTrial(t)} style={{ width: "100%", background: "#fff", color: cfg.accent, border: "1px solid " + cfg.accent, padding: "8px", borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: "pointer" }}>
                  Start free trial
                </button>
                <button onClick={() => openLeadForm(t)} style={{ background: "transparent", color: ink3, border: "none", padding: "4px 0 0", fontSize: 11, cursor: "pointer", textDecoration: "underline", textUnderlineOffset: 3 }}>
                  Need a custom quote?
                </button>
              </div>
            </div>
          ))}
        </div>

        {cfg.addons.length > 0 && (
          <div style={{ marginTop: 32, padding: 20, background: "#fff", border: "1px solid " + hair, borderRadius: 12 }}>
            <div style={{ fontSize: 11, color: ink3, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 }}>Add-ons (optional)</div>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${cfg.addons.length}, 1fr)`, gap: 16 }}>
              {cfg.addons.map(a => (
                <div key={a.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 500 }}>{a.name}</div>
                    <div style={{ fontSize: 11, color: ink3 }}>{a.desc}</div>
                  </div>
                  <div style={{ textAlign: "right" }}>
                    <div className="tnum" style={{ fontSize: 14, fontWeight: 600 }}>₹{a.price.toLocaleString("en-IN")}</div>
                    <div style={{ fontSize: 10, color: ink3 }}>/user/mo</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* VS BUYING DIRECT — competitive matrix */}
      <div style={{ background: "#fff", borderTop: "1px solid " + hair, padding: "60px 24px" }}>
        <div style={{ maxWidth: 1080, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 6 }}>Demo Co vs Buying Direct</div>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0, lineHeight: 1.15 }}>
              Same {cfg.brand.split(" ")[0]}. Better experience. Same price.
            </h2>
            <p style={{ fontSize: 14, color: ink3, marginTop: 8 }}>What you get with us that buying direct from {cfg.brand.split(" ")[0]} doesn't include.</p>
          </div>
          <div style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ background: cfg.accentSoft }}>
                  <th style={{ padding: "14px 16px", textAlign: "left", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: cfg.accent, fontWeight: 700, width: "40%" }}>What you get</th>
                  <th style={{ padding: "14px 16px", textAlign: "center", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: ink, fontWeight: 700, background: "#fff", borderLeft: "2px solid " + cfg.accent, borderRight: "2px solid " + cfg.accent }}>
                    <div style={{ fontSize: 12, marginBottom: 2 }}>Demo Co</div>
                    <div style={{ fontSize: 10, color: cfg.accent, fontWeight: 600 }}>★ Premier Partner</div>
                  </th>
                  <th style={{ padding: "14px 16px", textAlign: "center", fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: ink3, fontWeight: 700 }}>
                    Buying direct from {cfg.brand.split(" ")[0]}
                  </th>
                </tr>
              </thead>
              <tbody>
                {[
                  ["Same vendor pricing",                 true,  true,  "Identical per-seat rates"],
                  ["GST-compliant invoice (HSN + IRN)",   true,  true,  "Both Google and we issue full GST e-invoices"],
                  ["Free migration (₹50K value)",         true,  false, "DIY tools only · no hand-holding"],
                  ["WhatsApp + phone support",            true,  false, "Email tickets · 48h response"],
                  ["Hindi / English / Marathi support",   true,  false, "English-only support"],
                  ["Pro-rata mid-cycle additions",        true,  false, "Pay full month even for partial use"],
                  ["Multi-vendor single bill",            true,  false, "Locked to one vendor ecosystem"],
                  ["Premier Partner escalation",          true,  "n/a", "Vendor is the vendor"],
                  ["DPDP Act 2023 setup guidance",        true,  false, "Generic global compliance docs"],
                  ["2-hour response SLA",                 true,  false, "No SLA on standard tier"],
                  ["Local team in Mumbai",                true,  false, "Offshore support team"],
                ].map(([label, ours, theirs, theirNote], i, arr) => (
                  <tr key={label} style={{ borderTop: i === 0 ? "none" : "1px solid " + hair }}>
                    <td style={{ padding: "12px 16px", fontWeight: 500 }}>{label}</td>
                    <td style={{ padding: "12px 16px", textAlign: "center", background: "#F0FDF4", borderLeft: "2px solid " + cfg.accent, borderRight: "2px solid " + cfg.accent }}>
                      {ours === true ? <I name="check_circle" size={18} style={{ color: "#166534" }} /> : <span style={{ color: ink3 }}>—</span>}
                    </td>
                    <td style={{ padding: "12px 16px", textAlign: "center" }}>
                      {theirs === true ? <I name="check" size={16} style={{ color: ink3 }} /> :
                       theirs === "n/a" ? <span style={{ fontSize: 11, color: ink3 }}>n/a</span> :
                       <div>
                         <I name="x" size={14} style={{ color: "#DC2626" }} />
                         <div style={{ fontSize: 10, color: ink3, marginTop: 2, fontStyle: "italic" }}>{theirNote}</div>
                       </div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ textAlign: "center", marginTop: 16, fontSize: 12, color: ink3, fontStyle: "italic" }}>
            <I name="info" size={12} /> Same {cfg.brand.split(" ")[0]} licenses. Same prices. Better service ecosystem around them.
          </div>
        </div>
      </div>

      {/* MIGRATION JOURNEY — fear removal for vendor switchers */}
      <div style={{ background: "#fff", padding: "70px 24px", borderTop: "1px solid " + hair }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 44 }}>
            <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 8 }}>Migration done right</div>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 34, margin: 0, lineHeight: 1.15, letterSpacing: "-0.01em" }}>
              Migrate from anywhere — no downtime, no data loss.
            </h2>
            <p style={{ fontSize: 14, color: ink3, marginTop: 12, maxWidth: 720, margin: "12px auto 0" }}>
              We've migrated 247+ Indian businesses from Microsoft 365, Zoho, on-prem Exchange, GoDaddy mail, and custom IMAP. Most complete in a single weekend.
            </p>
          </div>

          {/* Source vendors → Demo Co flow */}
          <div style={{ background: "#FAF8F2", borderRadius: 16, padding: 32, marginBottom: 32 }}>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", gap: 24, alignItems: "center", marginBottom: 28 }}>
              <div>
                <div style={{ fontSize: 11, color: ink3, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 10 }}>From your current setup</div>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {["Microsoft 365", "Zoho Mail", "Exchange on-prem", "GoDaddy Mail", "Yahoo Business", "Custom IMAP", "Cpanel mail"].map(v => (
                    <span key={v} style={{ background: "#fff", border: "1px solid " + hair, padding: "5px 12px", borderRadius: 999, fontSize: 12, color: ink }}>{v}</span>
                  ))}
                </div>
              </div>
              <div style={{ width: 48, height: 48, borderRadius: "50%", background: cfg.accent, color: "#fff", display: "grid", placeItems: "center", flexShrink: 0 }}>
                <I name="arrow_right" size={20} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: cfg.accent, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 10 }}>To Google Workspace</div>
                <GoogleWorkspaceLogo size={28} />
                <div style={{ fontSize: 11, color: ink3, marginTop: 6 }}>Email · Drive · Calendar · Meet · Docs · all migrated</div>
              </div>
            </div>
          </div>

          {/* 4-step migration process */}
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 32, position: "relative" }}>
            {[
              { step: 1, title: "Discovery audit",   sub: "30-min call · we map your current users, domains, integrations",                  time: "Day 0", icon: "search" },
              { step: 2, title: "Migration plan",    sub: "PDF roadmap · user mapping, DNS cutover schedule, rollback plan",                  time: "Day 1", icon: "file" },
              { step: 3, title: "Move your data",    sub: "Email, contacts, calendars, files · single weekend · zero downtime",               time: "Days 2–3", icon: "upload" },
              { step: 4, title: "Go live Monday",    sub: "Old + new mailboxes run in parallel for 7 days · safety net",                       time: "Day 4", icon: "rocket" },
            ].map((s, i, arr) => (
              <div key={s.step} style={{ position: "relative" }}>
                <div style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, padding: 18, height: "100%" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                    <div style={{ width: 28, height: 28, borderRadius: 999, background: cfg.accentSoft, color: cfg.accent, display: "grid", placeItems: "center", fontFamily: "'DM Serif Display', serif", fontSize: 14 }}>{s.step}</div>
                    <I name={s.icon} size={16} style={{ color: cfg.accent }} />
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>{s.title}</div>
                  <div style={{ fontSize: 11, color: ink3, lineHeight: 1.55, marginBottom: 10 }}>{s.sub}</div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 4, background: cfg.accentSoft, color: cfg.accent, padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 600 }}>
                    <I name="clock" size={10} /> {s.time}
                  </div>
                </div>
                {i < arr.length - 1 && (
                  <div style={{ position: "absolute", top: "50%", right: -10, transform: "translateY(-50%)", color: ink3, zIndex: 1, background: "#fff", padding: 2 }}>
                    <I name="chevron_right" size={16} />
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Quote + guarantees */}
          <div style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr", gap: 20, alignItems: "stretch" }}>
            <div style={{ background: "#FAF8F2", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", justifyContent: "center" }}>
              <div style={{ display: "inline-block", background: "#166534", color: "#fff", padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, marginBottom: 12, alignSelf: "flex-start" }}>80 users migrated · zero downtime</div>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 19, fontStyle: "italic", lineHeight: 1.5, color: ink, marginBottom: 14 }}>
                "Demo Co ne hamara M365 to Workspace migration ek weekend mein complete kara diya. Friday raat shutdown, Monday subah team live. Pure 60 users, koi email lost nahi, GST invoice every month."
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <div style={{ width: 36, height: 36, borderRadius: "50%", background: cfg.accentSoft, color: cfg.accent, display: "grid", placeItems: "center", fontWeight: 600, fontSize: 13 }}>EV</div>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>Dr. Verma</div>
                  <div style={{ fontSize: 11, color: ink3 }}>CTO · Echo Pharma · Mumbai</div>
                </div>
              </div>
            </div>

            <div style={{ display: "grid", gap: 12 }}>
              {[
                { icon: "shield",       title: "100% data preserved",  sub: "Or we refund 100% + fix it free" },
                { icon: "rupee",        title: "Free for ₹50K+ deals", sub: "Worth ₹50K · zero extra cost" },
                { icon: "whatsapp",     title: "24h migration support", sub: "Hindi/English · during cutover" },
              ].map(g => (
                <div key={g.title} style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 10, padding: 14, display: "flex", gap: 12, alignItems: "center" }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: cfg.accentSoft, color: cfg.accent, display: "grid", placeItems: "center", flexShrink: 0 }}>
                    <I name={g.icon} size={18} />
                  </div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{g.title}</div>
                    <div style={{ fontSize: 11, color: ink3 }}>{g.sub}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* SAVINGS CALCULATOR — vs current setup */}
      <SavingsCalculator cfg={cfg} ink={ink} ink3={ink3} hair={hair} />

      {/* GST INVOICE PREVIEW + RECENT ACTIVITY */}
      <div style={{ padding: "60px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto", display: "grid", gridTemplateColumns: "1.3fr 1fr", gap: 24 }}>
          <div style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, padding: 24 }}>
            <div style={{ fontSize: 11, color: ink3, textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 }}>What your GST invoice looks like</div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, marginBottom: 16 }}>
              India-compliant invoicing · built-in
            </div>
            <div style={{ background: "#FAF8F2", border: "1px solid " + hair, borderRadius: 8, padding: 16, fontFamily: "'JetBrains Mono', monospace", fontSize: 11, lineHeight: 1.7 }}>
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: "1px dashed " + hair, paddingBottom: 8, marginBottom: 8 }}>
                <span><b>DEMO CO PVT LTD</b></span>
                <span>INV-2026-0089</span>
              </div>
              <div style={{ color: ink3 }}>GSTIN: 27AABCE9876D1Z3 · PAN: AABCE9876D</div>
              <div style={{ color: ink3 }}>IRN: 1f8a3b...c2e9 ✓ E-invoice verified</div>
              <div style={{ color: ink3, marginBottom: 8 }}>HSN: 998313 · Place of supply: Maharashtra (27)</div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span>{cfg.brand} · 25 users × ₹{cfg.tiers.find(t => t.most_popular).price}/mo × 12 mo</span>
                <span>₹{(cfg.tiers.find(t => t.most_popular).price * 25 * 12).toLocaleString("en-IN")}</span>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between", color: ink3 }}>
                <span>CGST @ 9% + SGST @ 9%</span>
                <span>₹{Math.round(cfg.tiers.find(t => t.most_popular).price * 25 * 12 * 0.18).toLocaleString("en-IN")}</span>
              </div>
              <div style={{ borderTop: "1px solid " + ink, marginTop: 6, paddingTop: 6, display: "flex", justifyContent: "space-between", fontWeight: 700 }}>
                <span>TOTAL PAYABLE</span>
                <span>₹{Math.round(cfg.tiers.find(t => t.most_popular).price * 25 * 12 * 1.18).toLocaleString("en-IN")}</span>
              </div>
            </div>
            <div style={{ marginTop: 14, display: "flex", flexWrap: "wrap", gap: 10, fontSize: 11, color: ink3 }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><I name="check" size={11} style={{ color: "#166534" }} /> Valid GSTIN</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><I name="check" size={11} style={{ color: "#166534" }} /> IRN generated (e-invoice)</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><I name="check" size={11} style={{ color: "#166534" }} /> HSN 998313</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><I name="check" size={11} style={{ color: "#166534" }} /> ITC reconcilable</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}><I name="check" size={11} style={{ color: "#166534" }} /> Auto-emailed in 5 min</span>
            </div>
          </div>

          {/* Recently provisioned live widget */}
          <div style={{ background: "#1A1815", color: "#FAF8F2", borderRadius: 12, padding: 24, display: "flex", flexDirection: "column", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontSize: 11, color: "#A6A19B", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 }}>Activity this month</div>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, marginBottom: 20, lineHeight: 1.2 }}>
                We've been busy.
              </div>
              <div style={{ display: "grid", gap: 14 }}>
                {[
                  { num: "1,247", label: cfg.brand.split(" ")[0] + " seats provisioned" },
                  { num: "₹14.2L", label: "Subscriptions activated" },
                  { num: "47", label: "New customers onboarded" },
                  { num: "98.4%", label: "On-time renewals" },
                ].map(s => (
                  <div key={s.label} style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", paddingBottom: 10, borderBottom: "1px solid #3A2F22" }}>
                    <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, color: "#FCD34D" }}>{s.num}</span>
                    <span style={{ fontSize: 12, color: "#A6A19B" }}>{s.label}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 11, color: "#A6A19B", fontStyle: "italic", marginTop: 14 }}>
              Updated in real-time · last sync 4 minutes ago
            </div>
          </div>
        </div>
      </div>

      {/* Why Demo Co */}
      <div style={{ background: "#fff", borderTop: "1px solid " + hair, borderBottom: "1px solid " + hair, padding: "60px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 36 }}>
            <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 6 }}>Why Demo Co</div>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0 }}>Same {cfg.brand.split(" ")[0]}. Better experience.</h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
            {[
              { icon: "rupee",      title: "Same price as vendor direct", body: "Reseller margin is built into vendor pricing — no markup, ever. You save the same ₹ buying through us." },
              { icon: "phone",      title: "Dedicated account manager",   body: "One person who knows your account end-to-end — not a ticket queue. Available on WhatsApp + phone in Hindi/English/Marathi." },
              { icon: "rocket",     title: "Free onboarding included",    body: "DNS, MX, SPF, DKIM, DMARC setup + 2 admin training sessions. Free for all plans, every time." },
              { icon: "whatsapp",   title: "WhatsApp + phone support",    body: "Real human, Hindi/English/Marathi, 9 AM–6 PM IST. Not vendor's offshore email tickets." },
              { icon: "layers",     title: "Multi-vendor single bill",    body: "Workspace + M365 + Zoho on one consolidated GST invoice. We reconcile across vendor portals." },
              { icon: "award",      title: "Authorised Partner since 2024", body: "Direct vendor billing access, certified consultants, vendor co-sell programs. Tier-1 status." },
            ].map(card => (
              <div key={card.title} style={{ padding: 20 }}>
                <div style={{ width: 40, height: 40, borderRadius: 10, background: cfg.accentSoft, color: cfg.accent, display: "grid", placeItems: "center", marginBottom: 12 }}>
                  <I name={card.icon} size={20} />
                </div>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 6 }}>{card.title}</div>
                <div style={{ fontSize: 12, color: ink3, lineHeight: 1.6 }}>{card.body}</div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Customer logos / testimonial */}
      <div style={{ padding: "60px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600 }}>Trusted by Indian businesses</div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(6, 1fr)", gap: 12, marginBottom: 32 }}>
            {["Acme Corp", "Beta Industries", "Cosmo Tech", "Delta Pvt Ltd", "Echo Pharma", "Foxtrot Logistics"].map(name => (
              <div key={name} style={{ height: 50, background: "#fff", border: "1px solid " + hair, borderRadius: 8, display: "grid", placeItems: "center", fontSize: 12, color: ink3, fontWeight: 500 }}>
                {name}
              </div>
            ))}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {[
              {
                quote: "Migration in one weekend. Zero downtime. Proper GST invoice every month. Saved ₹2.4L vs our previous reseller.",
                metric: "₹2.4L saved/year",
                name: "Dr. Verma", role: "CTO · Echo Pharma", location: "Mumbai · 60 users", initials: "EV",
              },
              {
                quote: "Pro-rata seat additions saved us so much hassle. Hire someone on the 15th, pay for half a month. Vendor direct couldn't do this.",
                metric: "32 mid-cycle additions",
                name: "Rajesh K", role: "CTO · Acme Corp", location: "Mumbai · 30 users", initials: "RK",
              },
              {
                quote: "WhatsApp pe support sabse helpful. Hindi mein baat kar sakte hain. Vendor ke tickets 3 din mein resolve hote hain — yahan 2 hours.",
                metric: "2-hour avg response",
                name: "Priya M", role: "Operations · Beta Industries", location: "Pune · 15 users", initials: "PM",
              },
            ].map((t, i) => (
              <div key={i} style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, padding: 24, position: "relative" }}>
                <div style={{ display: "inline-block", background: "#166534", color: "#fff", padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, marginBottom: 14 }}>{t.metric}</div>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 15, fontStyle: "italic", lineHeight: 1.5, color: ink, marginBottom: 16 }}>
                  "{t.quote}"
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 14, borderTop: "1px solid " + hair }}>
                  <div style={{ width: 36, height: 36, borderRadius: "50%", background: cfg.accentSoft, color: cfg.accent, display: "grid", placeItems: "center", fontWeight: 600, fontSize: 13 }}>{t.initials}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: ink3 }}>{t.role}</div>
                    <div style={{ fontSize: 10, color: ink3, marginTop: 1 }}>{t.location}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Comparison table */}
      <div style={{ background: "#fff", borderTop: "1px solid " + hair, padding: "60px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0 }}>Compare all plans</h2>
          </div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "12px 16px", borderBottom: "1px solid " + hair, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: ink3 }}>Feature</th>
                {cfg.tiers.map(t => (
                  <th key={t.id} style={{ textAlign: "center", padding: "12px 16px", borderBottom: "1px solid " + hair }}>
                    <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 16 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: ink3, marginTop: 2 }}>₹{t.price}/user/mo</div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>Storage</td>
                {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair }}>{t.storage}</td>)}
              </tr>
              {productKey === "workspace" && (
                <>
                  <tr>
                    <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>Meeting participants</td>
                    {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair, fontVariantNumeric: "tabular-nums" }}>{t.participants}</td>)}
                  </tr>
                  <tr>
                    <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>Meeting recording</td>
                    {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair }}>{t.recording ? <I name="check" size={14} style={{ color: cfg.accent }} /> : "—"}</td>)}
                  </tr>
                  <tr>
                    <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>Security level</td>
                    {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair, fontSize: 12 }}>{t.security}</td>)}
                  </tr>
                </>
              )}
              {productKey === "m365" && (
                <>
                  <tr>
                    <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>Desktop Office apps</td>
                    {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair }}>{t.desktop ? <I name="check" size={14} style={{ color: cfg.accent }} /> : "—"}</td>)}
                  </tr>
                  <tr>
                    <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>Security level</td>
                    {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair, fontSize: 12 }}>{t.security}</td>)}
                  </tr>
                </>
              )}
              <tr>
                <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>GST invoice</td>
                {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair }}><I name="check" size={14} style={{ color: cfg.accent }} /></td>)}
              </tr>
              <tr>
                <td style={{ padding: 12, borderBottom: "1px solid " + hair }}>Free onboarding</td>
                {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12, borderBottom: "1px solid " + hair }}><I name="check" size={14} style={{ color: cfg.accent }} /></td>)}
              </tr>
              <tr>
                <td style={{ padding: 12 }}>WhatsApp + phone support</td>
                {cfg.tiers.map(t => <td key={t.id} style={{ textAlign: "center", padding: 12 }}><I name="check" size={14} style={{ color: cfg.accent }} /></td>)}
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      {/* FAQ */}
      <div style={{ padding: "60px 24px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 32 }}>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0 }}>Common questions</h2>
          </div>
          <div className="stack-12">
            {cfg.faq.map((f, i) => (
              <details key={i} style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 10, padding: 16 }}>
                <summary style={{ fontSize: 14, fontWeight: 600, cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  {f.q}
                  <I name="chevron_down" size={14} />
                </summary>
                <div style={{ fontSize: 13, color: ink3, lineHeight: 1.6, marginTop: 12 }}>
                  {f.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>

      {/* Final CTA */}
      <div style={{ background: ink, color: bgPaper, padding: "60px 24px" }}>
        <div style={{ maxWidth: 820, margin: "0 auto", textAlign: "center" }}>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, margin: 0, marginBottom: 12 }}>
            Ready to start with {cfg.brand}?
          </h2>
          <p style={{ fontSize: 14, color: "#A6A19B", marginBottom: 28 }}>
            Get a custom quote in 2 hours, or chat with our team on WhatsApp now.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", marginBottom: 18, flexWrap: "wrap" }}>
            <button onClick={() => openBuyNow(tier)} style={{ background: cfg.accent, color: "#fff", border: "none", padding: "14px 28px", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <I name="cart" size={14} /> Buy now
            </button>
            <button onClick={() => openTrial(tier)} style={{ background: "transparent", color: bgPaper, border: "1.5px solid " + bgPaper, padding: "14px 28px", borderRadius: 8, fontSize: 15, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
              <I name="spark" size={14} /> Start free trial
            </button>
          </div>
          <div style={{ display: "flex", gap: 14, justifyContent: "center", marginBottom: 24, fontSize: 12, color: "#A6A19B" }}>
            <button onClick={() => openLeadForm(tier)} style={{ background: "transparent", color: "#A6A19B", border: "none", padding: 0, cursor: "pointer", fontSize: 12, textDecoration: "underline", textUnderlineOffset: 3 }}>
              Get a custom quote
            </button>
            <span>·</span>
            <button onClick={() => toast("Opening WhatsApp …")} style={{ background: "transparent", color: "#A6A19B", border: "none", padding: 0, cursor: "pointer", fontSize: 12, textDecoration: "underline", textUnderlineOffset: 3, display: "inline-flex", alignItems: "center", gap: 4 }}>
              <I name="whatsapp" size={12} /> WhatsApp us
            </button>
          </div>
          <div style={{ display: "flex", gap: 18, justifyContent: "center", fontSize: 11, color: "#A6A19B" }}>
            <span>🔒 Razorpay secured</span>
            <span>✓ DPDP compliant</span>
            <span>★ 4.8 / 5 from 247 customers</span>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div style={{ background: "#fff", borderTop: "1px solid " + hair, padding: "32px 24px" }}>
        <div style={{ maxWidth: 1180, margin: "0 auto" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 16, paddingBottom: 20, marginBottom: 20, borderBottom: "1px solid " + hair }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
              {productKey === "workspace" && (
                <PremierPartnerBadge size={70} type="workspace" />
              )}
              <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "linear-gradient(135deg, #1A1815 0%, #2D2418 100%)", color: "#FCD34D", padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600, border: "1px solid #FBBF24" }}>
                ★ Google Premier Partner
              </div>
              <div style={{ fontSize: 11, color: ink3 }}>since 2024 · top 5% globally</div>
              <div style={{ fontSize: 11, color: ink3 }}>·</div>
              <div style={{ fontSize: 11, color: ink3 }}>Microsoft Solutions Partner</div>
              <div style={{ fontSize: 11, color: ink3 }}>·</div>
              <div style={{ fontSize: 11, color: ink3 }}>Zoho Authorised Partner</div>
            </div>
            <div style={{ display: "flex", gap: 8, fontSize: 10, color: ink3 }}>
              <span style={{ background: "#F0FDF4", color: "#166534", padding: "3px 8px", borderRadius: 4, fontWeight: 600 }}>🔒 Razorpay verified</span>
              <span style={{ background: "#F0FDF4", color: "#166534", padding: "3px 8px", borderRadius: 4, fontWeight: 600 }}>✓ DPDP Act 2023</span>
              <span style={{ background: "#F0FDF4", color: "#166534", padding: "3px 8px", borderRadius: 4, fontWeight: 600 }}>✓ ISO 27001 process</span>
            </div>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, fontSize: 12, color: ink3 }}>
            <div>© 2026 Demo Co Pvt Ltd · GSTIN 27AABCE9876D1Z3 · Mumbai, Maharashtra</div>
            <div style={{ display: "flex", gap: 16 }}>
              <a href="#" style={{ color: ink3 }}>Privacy</a>
              <a href="#" style={{ color: ink3 }}>Terms</a>
              <a href="#" style={{ color: ink3 }}>Refund policy</a>
              <a href="#" style={{ color: ink3 }}>Contact</a>
            </div>
          </div>
        </div>
      </div>

      {/* Inline lead form modal (sales-assisted quote) */}
      {showLeadForm && (
        <LeadFormModal
          tier={activeTier || tier}
          product={cfg.brand}
          accent={cfg.accent}
          seats={seats}
          onClose={() => setShowLeadForm(false)}
          onSubmit={(data) => {
            toast(`Thanks ${data.name}! We've reserved your ${cfg.brand} ${(activeTier || tier).name} price for 7 days · Rahul will WhatsApp you within 2 hours.`);
            setShowLeadForm(false);
          }}
        />
      )}

      {/* Buy now modal (self-serve checkout) */}
      {showBuyNow && (
        <BuyNowModal
          tier={activeTier || tier}
          product={cfg.brand}
          accent={cfg.accent}
          accentSoft={cfg.accentSoft}
          seats={seats}
          onClose={() => setShowBuyNow(false)}
          onPay={(data) => {
            // Modal handles its own success view — only fire toast, don't close
            toast(`Payment of ${data.totalLabel} confirmed · GST invoice ${data.invoiceNo} emailed`);
          }}
        />
      )}

      {/* Trial signup modal */}
      {showTrial && (
        <TrialSignupModal
          tier={activeTier || tier}
          product={cfg.brand}
          accent={cfg.accent}
          accentSoft={cfg.accentSoft}
          seats={seats}
          onClose={() => setShowTrial(false)}
          onActivate={(data) => {
            // Modal handles its own success view — only fire toast, don't close
            toast(`14-day trial activated for ${data.company}`);
          }}
        />
      )}

      {/* FLOATING PREMIER PARTNER BADGE — always-visible credibility */}
      <a href="#premier-partner" onClick={(e) => { e.preventDefault(); document.querySelector('[style*="Why Premier Partner status matters"]')?.scrollIntoView({ behavior: "smooth" }); }}
        style={{
          position: "fixed",
          top: 90,
          right: 0,
          background: "linear-gradient(135deg, #1A1815 0%, #2D2418 100%)",
          color: "#FCD34D",
          padding: "10px 14px 10px 18px",
          borderRadius: "8px 0 0 8px",
          fontSize: 11,
          fontWeight: 600,
          boxShadow: "0 4px 14px rgba(0,0,0,0.2)",
          border: "1px solid #FBBF24",
          borderRight: "none",
          display: "flex",
          alignItems: "center",
          gap: 6,
          textDecoration: "none",
          zIndex: 80,
          transition: "transform 200ms",
        }}
        onMouseEnter={(e) => e.currentTarget.style.transform = "translateX(-4px)"}
        onMouseLeave={(e) => e.currentTarget.style.transform = "translateX(0)"}
      >
        <span style={{ fontSize: 13 }}>★</span>
        <span>Premier Partner</span>
      </a>

      {/* FLOATING WHATSAPP BUTTON — always-available help */}
      <button
        onClick={() => toast("Opening WhatsApp · +91 98765 11111")}
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          background: "#25D366",
          color: "#fff",
          border: "none",
          width: 60,
          height: 60,
          borderRadius: "50%",
          cursor: "pointer",
          boxShadow: "0 6px 20px rgba(37, 211, 102, 0.5)",
          display: "grid",
          placeItems: "center",
          zIndex: 90,
          transition: "transform 200ms",
        }}
        onMouseEnter={(e) => e.currentTarget.style.transform = "scale(1.1)"}
        onMouseLeave={(e) => e.currentTarget.style.transform = "scale(1)"}
        aria-label="Chat on WhatsApp"
      >
        <I name="whatsapp" size={28} />
      </button>
    </div>
  );
}

function LeadFormModal({ tier, product, accent, seats, onClose, onSubmit }) {
  const [name, setName]     = useState("");
  const [company, setCompany] = useState("");
  const [phone, setPhone]   = useState("");
  const [email, setEmail]   = useState("");
  const [s, setS]           = useState(seats);

  const monthly = tier.price * s;
  const canSubmit = name.trim() && company.trim() && (phone.trim() || email.trim());

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: 480, maxWidth: "100%", overflow: "hidden" }}>
        <div style={{ background: accent, color: "#fff", padding: "20px 24px" }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", opacity: 0.9, fontWeight: 600, marginBottom: 4 }}>Quote request</div>
          <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22 }}>{product} {tier.name}</div>
          <div style={{ fontSize: 12, opacity: 0.9, marginTop: 4 }}>{s} users × ₹{tier.price}/mo = {rupee(monthly)} monthly</div>
        </div>
        <div style={{ padding: 24, display: "grid", gap: 12 }}>
          <div>
            <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Your name *</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rajesh Kumar" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Company name *</div>
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Corp Pvt Ltd" style={inputStyle} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>WhatsApp number</div>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Email</div>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="rajesh@acme.com" style={inputStyle} />
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Number of users</div>
            <input type="number" value={s} min={1} onChange={(e) => setS(+e.target.value || 1)} style={inputStyle} />
          </div>
          <div style={{ fontSize: 10, color: "#6B6457", lineHeight: 1.5, marginTop: 4 }}>
            By submitting, you agree to be contacted via WhatsApp/Email. We respect DPDP Act 2023 — your data is stored in Mumbai, never sold, and you can request deletion anytime.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, padding: "12px 24px 24px", justifyContent: "flex-end" }}>
          <button onClick={onClose} style={{ background: "transparent", color: "#1A1815", border: "none", padding: "10px 16px", fontSize: 13, cursor: "pointer" }}>
            Cancel
          </button>
          <button disabled={!canSubmit} onClick={() => onSubmit({ name, company, phone, email, seats: s })} style={{ background: canSubmit ? accent : "#ccc", color: "#fff", border: "none", padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: canSubmit ? "pointer" : "not-allowed" }}>
            Send me the quote
          </button>
        </div>
      </div>
    </div>
  );
}

const inputStyle = {
  width: "100%",
  padding: "9px 12px",
  border: "1px solid #E8E2D4",
  borderRadius: 6,
  fontSize: 13,
  fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
};

// Savings calculator — vs current setup
function SavingsCalculator({ cfg, ink, ink3, hair }) {
  const [currentSpend, setCurrentSpend] = useState(1500);
  const [users, setUsers] = useState(25);
  const targetTier = cfg.tiers.find(t => t.most_popular) || cfg.tiers[1] || cfg.tiers[0];
  const ourPerUser = targetTier.price;

  const monthlyCurrent = currentSpend * users;
  const monthlyOurs    = ourPerUser * users;
  const monthlySavings = monthlyCurrent - monthlyOurs;
  const annualSavings  = monthlySavings * 12;
  const isSaving = monthlySavings > 0;

  return (
    <div style={{ background: "linear-gradient(135deg, " + cfg.accentSoft + " 0%, #FAF8F2 100%)", padding: "60px 24px" }}>
      <div style={{ maxWidth: 1080, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1.2fr", gap: 36, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 8 }}>How much will you save?</div>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 30, lineHeight: 1.15, margin: 0, marginBottom: 12 }}>
            Calculate your savings vs your current setup
          </h2>
          <p style={{ fontSize: 14, color: ink3, lineHeight: 1.6, marginBottom: 0 }}>
            Most Indian SMEs overpay 30–60% with their current reseller or vendor-direct setup. Plug in your numbers — see what you'd save with Demo Co.
          </p>
        </div>

        <div style={{ background: "#fff", border: "1px solid " + hair, borderRadius: 12, padding: 24, boxShadow: "0 8px 24px rgba(0,0,0,0.04)" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
            <div>
              <div style={{ fontSize: 11, color: ink3, fontWeight: 600, marginBottom: 4 }}>Current ₹ / user / mo</div>
              <input type="number" min={50} value={currentSpend} onChange={(e) => setCurrentSpend(Math.max(0, +e.target.value || 0))} style={{ width: "100%", padding: "10px 12px", border: "1px solid " + hair, borderRadius: 6, fontSize: 18, fontWeight: 600, fontFamily: "'Plus Jakarta Sans', system-ui", color: ink }} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: ink3, fontWeight: 600, marginBottom: 4 }}>Number of users</div>
              <input type="number" min={1} value={users} onChange={(e) => setUsers(Math.max(1, +e.target.value || 1))} style={{ width: "100%", padding: "10px 12px", border: "1px solid " + hair, borderRadius: 6, fontSize: 18, fontWeight: 600, fontFamily: "'Plus Jakarta Sans', system-ui", color: ink }} />
            </div>
          </div>

          <div style={{ background: isSaving ? "#F0FDF4" : "#FEF3C7", border: "1px solid " + (isSaving ? "#86EFAC" : "#FCD34D"), padding: 16, borderRadius: 8 }}>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, color: ink3 }}>
              <span>You're paying now (×{users} users)</span>
              <span className="tnum" style={{ color: ink }}>{rupee(monthlyCurrent)}/mo</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, fontSize: 12, color: ink3 }}>
              <span>With Demo Co ({targetTier.name} ×{users})</span>
              <span className="tnum" style={{ color: cfg.accent, fontWeight: 600 }}>{rupee(monthlyOurs)}/mo</span>
            </div>
            <div style={{ borderTop: "1px dashed " + (isSaving ? "#16A34A" : "#92400E"), paddingTop: 10, marginTop: 4 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                <span style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.06em", color: isSaving ? "#166534" : "#92400E", fontWeight: 700 }}>
                  {isSaving ? "Annual savings" : "Difference (you'd pay more)"}
                </span>
                <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 28, color: isSaving ? "#16A34A" : "#92400E", fontVariantNumeric: "tabular-nums" }}>
                  {isSaving ? "" : "−"}{rupee(Math.abs(annualSavings))}
                </span>
              </div>
              <div style={{ fontSize: 11, color: ink3, marginTop: 4, fontStyle: "italic" }}>
                {isSaving
                  ? `That's ${rupee(monthlySavings)}/month back in your pocket · plus free migration worth ₹50K`
                  : `Demo Co doesn't make sense if you're already this low — let's chat about premium tiers`}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Live activity ticker — rotates through recent customer activities to create social proof
function ActivityTicker({ accent, ink3, hair, brand }) {
  const activities = [
    { name: "Sneha M", company: "Beta Industries",     city: "Pune",       action: "started a 14-day trial",          time: "12 min ago" },
    { name: "Vikram S", company: "TechBrand Pvt Ltd",  city: "Mumbai",     action: `bought ${brand} Standard · 25 seats`, time: "42 min ago" },
    { name: "Dr. Verma", company: "Echo Pharma",       city: "Mumbai",     action: "added 8 seats mid-cycle",         time: "1 hour ago" },
    { name: "Anita G",  company: "Crown Furnishings",  city: "Pune",       action: `migrated from M365 to ${brand}`,  time: "2 hours ago" },
    { name: "Karan K",  company: "Foxtrot Logistics",  city: "Mumbai",     action: "renewed for another year",        time: "3 hours ago" },
    { name: "Arjun S",  company: "Delta Pvt Ltd",      city: "Mumbai",     action: `upgraded to ${brand} Plus`,        time: "5 hours ago" },
  ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx(i => (i + 1) % activities.length), 4000);
    return () => clearInterval(t);
  }, []);
  const a = activities[idx];
  return (
    <div style={{ display: "inline-flex", alignItems: "center", gap: 10, background: "#fff", border: "1px solid " + hair, padding: "8px 14px", borderRadius: 999, fontSize: 12 }}>
      <span style={{ position: "relative", width: 8, height: 8, borderRadius: "50%", background: "#22C55E" }}>
        <span style={{ position: "absolute", inset: -3, borderRadius: "50%", background: "#22C55E", opacity: 0.3, animation: "pulse 1.6s ease-out infinite" }} />
      </span>
      <span style={{ color: ink3 }}>
        <b style={{ color: "#1A1815" }}>{a.name}</b> @ {a.company} ({a.city}) just {a.action} · <span style={{ opacity: 0.7 }}>{a.time}</span>
      </span>
      <style>{`@keyframes pulse { 0% { transform: scale(1); opacity: 0.6 } 100% { transform: scale(2); opacity: 0 } }`}</style>
    </div>
  );
}

// Plan recommender — 3-question quiz, recommends a tier
function PlanRecommender({ cfg, bgPaper, ink, ink3, hair, onPick }) {
  const [users, setUsers]       = useState(null);     // small | mid | large
  const [recording, setRecording] = useState(null);   // yes | no
  const [security, setSecurity]   = useState(null);   // yes | no

  const ready = users && recording && security;

  // Recommendation logic
  let recommended = cfg.tiers[0];
  let reason = "";
  if (ready) {
    if (security === "yes") {
      recommended = cfg.tiers.find(t => t.id === "GW-ENT") || cfg.tiers[cfg.tiers.length - 1];
      reason = "Advanced security + DLP + S/MIME needed";
    } else if (recording === "yes" || users === "mid" || users === "large") {
      recommended = cfg.tiers.find(t => t.most_popular) || cfg.tiers[1];
      reason = recording === "yes" ? "Meeting recording requires Standard or above" : "Best storage + features for your team size";
    } else {
      recommended = cfg.tiers[0];
      reason = "Starter covers email + drive + meet for small teams";
    }
  }

  const QButton = ({ value, current, label, sub, onChoose }) => (
    <button
      onClick={() => onChoose(value)}
      style={{
        flex: 1,
        background: current === value ? cfg.accent : "#fff",
        color: current === value ? "#fff" : ink,
        border: "1.5px solid " + (current === value ? cfg.accent : hair),
        padding: "12px 14px",
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
        transition: "all 150ms",
      }}>
      <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, opacity: 0.85, marginTop: 2 }}>{sub}</div>}
    </button>
  );

  return (
    <div style={{ background: "#fff", borderTop: "1px solid " + hair, borderBottom: "1px solid " + hair, padding: "60px 24px" }}>
      <div style={{ maxWidth: 920, margin: "0 auto", display: "grid", gridTemplateColumns: "1fr 1fr", gap: 40, alignItems: "center" }}>
        <div>
          <div style={{ fontSize: 12, color: ink3, textTransform: "uppercase", letterSpacing: "0.1em", fontWeight: 600, marginBottom: 8 }}>Not sure?</div>
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 30, lineHeight: 1.15, margin: 0, marginBottom: 12 }}>
            Find your perfect plan in 30 seconds
          </h2>
          <p style={{ fontSize: 14, color: ink3, lineHeight: 1.6, marginBottom: 0 }}>
            Three quick questions. We'll recommend the right tier based on your team size, meeting needs, and security requirements.
          </p>
        </div>

        <div style={{ background: bgPaper, padding: 24, borderRadius: 12 }}>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>1. How many users?</div>
            <div style={{ display: "flex", gap: 6 }}>
              <QButton value="small" current={users} label="5–25"  sub="Small team" onChoose={setUsers} />
              <QButton value="mid"   current={users} label="25–100" sub="Mid-market" onChoose={setUsers} />
              <QButton value="large" current={users} label="100+"   sub="Enterprise" onChoose={setUsers} />
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>2. Need meeting recording?</div>
            <div style={{ display: "flex", gap: 6 }}>
              <QButton value="yes" current={recording} label="Yes"    sub="Record + transcribe" onChoose={setRecording} />
              <QButton value="no"  current={recording} label="Not really" sub="Live meetings only" onChoose={setRecording} />
            </div>
          </div>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>3. Security compliance required?</div>
            <div style={{ display: "flex", gap: 6 }}>
              <QButton value="yes" current={security} label="Yes" sub="DLP, S/MIME, audit logs"     onChoose={setSecurity} />
              <QButton value="no"  current={security} label="No"  sub="Standard security is fine"    onChoose={setSecurity} />
            </div>
          </div>

          {ready && (
            <div style={{ background: cfg.accentSoft, padding: 16, borderRadius: 10, marginTop: 16, border: "1px solid " + cfg.accent + "33" }}>
              <div style={{ fontSize: 11, color: cfg.accent, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>Recommended for you</div>
              <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, marginTop: 4, marginBottom: 4 }}>
                {cfg.brand.split(" ")[0]} {recommended.name} — ₹{recommended.price.toLocaleString("en-IN")}/user/mo
              </div>
              <div style={{ fontSize: 12, color: ink3, marginBottom: 12 }}>{reason}</div>
              <button onClick={() => onPick(recommended)} style={{ background: cfg.accent, color: "#fff", border: "none", padding: "10px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
                Show me {recommended.name} pricing <I name="arrow_right" size={12} />
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function BuyNowModal({ tier, availableTiers, product, accent, accentSoft, seats, onClose, onPay }) {
  const [selectedTier, setSelectedTier] = useState(tier);
  const [company, setCompany] = useState("");
  const [domain, setDomain]   = useState("");
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [gstin, setGstin] = useState("");
  const [state, setState] = useState("Maharashtra (27)");
  const [billing, setBilling] = useState("annual"); // monthly | annual
  const [users, setUsers] = useState(seats);
  const [stage, setStage] = useState("form"); // form | processing | success
  const [errorMsg, setErrorMsg] = useState("");

  // Use selectedTier for all calcs (defaults to tier prop, switchable via selector)
  const activeTier = selectedTier || tier;
  // Lenient domain check
  const domainValid = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i.test(domain.trim()) && domain.includes(".");
  const isGoogleProduct = (product || "").toLowerCase().includes("workspace") || (product || "").toLowerCase().includes("google");

  // What's missing for friendly nudges
  const missing = [];
  if (!company.trim())  missing.push("company name");
  if (!domain.trim())   missing.push("business domain");
  else if (!domainValid) missing.push("valid domain (e.g. acmecorp.com)");
  if (!name.trim())     missing.push("your name");
  if (!email.trim())    missing.push("email");
  if (!phone.trim())    missing.push("phone");

  const invoiceNo = "INV-2026-" + (Math.floor(Math.random() * 9000) + 1000);
  const irn       = Math.random().toString(36).slice(2, 8) + "..." + Math.random().toString(36).slice(2, 5);

  // Pull the right rate based on tier + billing toggle (promo if available)
  const perUserMonth = billing === "annual"
    ? (activeTier.promoPrice || activeTier.price)
    : (activeTier.monthlyPromoPrice || activeTier.monthlyPrice || activeTier.price);
  const monthlyAmount = perUserMonth * users;
  const subtotal = billing === "annual" ? monthlyAmount * 12 : monthlyAmount;
  // 16% savings vs Flexible plan rate already baked into the Annual per-user price
  // (so subtotal IS already the discounted amount · no additional discount applied)
  const annualDiscount = 0;
  const taxable = subtotal - annualDiscount;
  const interState = state !== "Maharashtra (27)";
  const tax = Math.round(taxable * 0.18);
  const cgst = Math.round(tax / 2);
  const sgst = tax - cgst;
  const total = taxable + tax;

  const canPay = missing.length === 0;
  const handlePay = () => {
    if (missing.length > 0) {
      setErrorMsg(`Please add: ${missing.join(", ")}`);
      setTimeout(() => setErrorMsg(""), 4000);
      return;
    }
    setStage("processing");
    // Simulate Razorpay payment processing (2 seconds)
    setTimeout(() => {
      onPay({ company, domain, total, totalLabel: rupee(total), invoiceNo });
      setStage("success");
    }, 2000);
  };

  // PROCESSING STAGE — Razorpay-style spinner with payment progress
  if (stage === "processing") {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }}>
        <div style={{ background: "#fff", borderRadius: 12, width: 420, padding: 40, textAlign: "center" }}>
          <div style={{ width: 56, height: 56, borderRadius: "50%", border: "4px solid #E8E2D4", borderTopColor: accent, margin: "0 auto 20px", animation: "spin 0.8s linear infinite" }} />
          <div style={{ fontFamily: "'Google Sans', 'Plus Jakarta Sans', sans-serif", fontSize: 18, fontWeight: 500, color: "#202124", marginBottom: 8 }}>
            Processing your payment…
          </div>
          <div style={{ fontSize: 13, color: "#5F6368", lineHeight: 1.5 }}>
            Charging {rupee(total)} via Razorpay · do not close this window
          </div>
          <div style={{ background: "#F8F9FA", borderRadius: 8, padding: 12, marginTop: 20, fontSize: 11, color: "#5F6368", textAlign: "left" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <I name="check_circle" size={12} style={{ color: "#34A853" }} /> Encrypted via 256-bit SSL
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
              <I name="check_circle" size={12} style={{ color: "#34A853" }} /> PCI DSS Level 1 compliant
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              <I name="check_circle" size={12} style={{ color: "#34A853" }} /> Razorpay verified merchant
            </div>
          </div>
          <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
        </div>
      </div>
    );
  }

  // SUCCESS STAGE — payment confirmation with GST invoice + provisioning timeline
  if (stage === "success") {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }} onClick={onClose}>
        <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: 600, maxWidth: "100%", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
          {/* Success header */}
          <div style={{ background: "linear-gradient(135deg, #34A853 0%, #1A73E8 100%)", color: "#fff", padding: "32px 24px", textAlign: "center" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(255,255,255,0.2)", display: "grid", placeItems: "center", margin: "0 auto 14px", border: "2px solid rgba(255,255,255,0.4)" }}>
              <I name="check" size={36} />
            </div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 26, lineHeight: 1.2 }}>Payment received!</div>
            <div style={{ fontSize: 14, opacity: 0.95, marginTop: 8 }}>
              {rupee(total)} charged to {company || "your card"}
            </div>
          </div>

          {/* Body — scrollable */}
          <div style={{ padding: "20px 24px", overflowY: "auto", flex: 1 }}>
            {/* GST invoice preview */}
            <div style={{ background: "#F8F9FA", border: "1px solid #E8E2D4", borderRadius: 8, padding: 14, marginBottom: 18 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
                <div style={{ fontSize: 11, color: "#5F6368", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>GST e-invoice issued</div>
                <span style={{ fontSize: 10, background: "#E6F4EA", color: "#188038", padding: "2px 8px", borderRadius: 4, fontWeight: 600 }}>VERIFIED</span>
              </div>
              <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11, color: "#3C4043", lineHeight: 1.8 }}>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F6368" }}>Invoice no.</span>
                  <b style={{ color: "#202124" }}>{invoiceNo}</b>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F6368" }}>IRN</span>
                  <span>{irn}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F6368" }}>HSN</span>
                  <span>998313</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ color: "#5F6368" }}>GSTIN (reseller)</span>
                  <span>27AABCE9876D1Z3</span>
                </div>
                {gstin && (
                  <div style={{ display: "flex", justifyContent: "space-between" }}>
                    <span style={{ color: "#5F6368" }}>Your GSTIN</span>
                    <span>{gstin}</span>
                  </div>
                )}
                <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 6, marginTop: 6, borderTop: "1px solid #E8E2D4" }}>
                  <b style={{ color: "#202124" }}>Total charged</b>
                  <b style={{ color: accent }}>{rupee(total)}</b>
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button style={{ flex: 1, background: "#fff", color: "#1A73E8", border: "1px solid #DADCE0", padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "'Google Sans', sans-serif", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <I name="download" size={12} /> Download PDF
                </button>
                <button style={{ flex: 1, background: "#fff", color: "#1A73E8", border: "1px solid #DADCE0", padding: "8px 12px", borderRadius: 6, fontSize: 12, fontWeight: 500, cursor: "pointer", fontFamily: "'Google Sans', sans-serif", display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}>
                  <I name="mail" size={12} /> Email to me
                </button>
              </div>
            </div>

            {/* Order summary */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: "#5F6368", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 8 }}>Your order</div>
              <div style={{ fontSize: 13, color: "#202124" }}>
                <div style={{ marginBottom: 4 }}>
                  {product.includes("Google Workspace") ? (
                    <><GWInline workspaceColor="#5F6368" workspaceWeight={400} /> {activeTier.name}</>
                  ) : (
                    <>{product} {activeTier.name}</>
                  )}
                </div>
                <div style={{ fontSize: 12, color: "#5F6368" }}>{users} users × {billing === "annual" ? "12 months" : "1 month"}</div>
              </div>
            </div>

            {/* What happens next */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ fontSize: 11, color: "#5F6368", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 }}>What happens next</div>
              <div style={{ display: "grid", gap: 12 }}>
                {[
                  { num: "1", title: "Within 5 minutes", body: `GST e-invoice (${invoiceNo}) emailed to ${email || "you"}` },
                  { num: "2", title: "Within 1 hour",   body: `Admin credentials sent · login at admin.google.com with @${domain || "your-domain"}` },
                  { num: "3", title: "Within 4 hours",  body: "DNS records (MX, SPF, DKIM, DMARC) configured by our team — free setup" },
                  { num: "4", title: "Within 24 hours", body: `Your ${users} ${users === 1 ? "user is" : "users are"} fully provisioned · team goes live` },
                ].map(step => (
                  <div key={step.num} style={{ display: "flex", gap: 12 }}>
                    <div style={{ width: 28, height: 28, borderRadius: "50%", background: "#E8F0FE", color: "#1A73E8", display: "grid", placeItems: "center", fontWeight: 600, fontSize: 13, flexShrink: 0, fontFamily: "'Google Sans', sans-serif" }}>{step.num}</div>
                    <div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#202124" }}>{step.title}</div>
                      <div style={{ fontSize: 12, color: "#5F6368", marginTop: 2, lineHeight: 1.5 }}>{step.body}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {/* Footer actions */}
          <div style={{ background: "#F8F9FA", padding: "14px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #E8E2D4" }}>
            <div style={{ fontSize: 11, color: "#5F6368", display: "flex", alignItems: "center", gap: 6 }}>
              <I name="whatsapp" size={12} style={{ color: "#25D366" }} /> Rahul will WhatsApp updates
            </div>
            <button onClick={onClose} style={{ background: accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 6, fontSize: 13, fontWeight: 500, cursor: "pointer", fontFamily: "'Google Sans', sans-serif" }}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: 720, maxWidth: "100%", maxHeight: "90vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
        <div style={{ background: "#fff", color: "#202124", padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #E8E2D4" }}>
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#5F6368", fontWeight: 600 }}>Self-serve checkout</div>
            <div style={{ fontFamily: "'Google Sans', 'Plus Jakarta Sans', sans-serif", fontSize: 24, fontWeight: 500, marginTop: 4 }}>
              {product.includes("Google Workspace") ? (
                <><GWInline workspaceColor="#5F6368" workspaceWeight={400} /> {activeTier.name}</>
              ) : (
                <>{product} {activeTier.name}</>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "#F1F3F4", color: "#5F6368", border: "none", width: 32, height: 32, borderRadius: 6, cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr", flex: 1, overflowY: "auto" }}>
          {/* Left — form */}
          <div style={{ padding: 24, borderRight: "1px solid #E8E2D4" }}>
            <div style={{ display: "grid", gap: 14 }}>

              {/* BILLING TYPE TOGGLE — at the very top */}
              <div>
                <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 6 }}>Choose billing</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  <button
                    onClick={() => setBilling("monthly")}
                    style={{
                      background: billing === "monthly" ? "#E8F0FE" : "#fff",
                      border: "1.5px solid " + (billing === "monthly" ? accent : "#DADCE0"),
                      borderRadius: 8,
                      padding: "12px 14px",
                      cursor: "pointer",
                      textAlign: "left",
                      position: "relative",
                      fontFamily: "'Google Sans', 'Plus Jakarta Sans', sans-serif",
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#202124", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                      <I name="zap" size={13} style={{ color: billing === "monthly" ? accent : "#5F6368" }} />
                      Flexible Plan
                    </div>
                    <div style={{ fontSize: 11, color: "#5F6368", lineHeight: 1.4 }}>
                      Pay monthly · cancel anytime · adjust users mid-cycle
                    </div>
                    {billing === "monthly" && (
                      <div style={{ position: "absolute", top: 8, right: 8, width: 14, height: 14, borderRadius: "50%", background: accent, color: "#fff", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700 }}>✓</div>
                    )}
                  </button>
                  <button
                    onClick={() => setBilling("annual")}
                    style={{
                      background: billing === "annual" ? "#E8F0FE" : "#fff",
                      border: "1.5px solid " + (billing === "annual" ? accent : "#DADCE0"),
                      borderRadius: 8,
                      padding: "12px 14px",
                      cursor: "pointer",
                      textAlign: "left",
                      position: "relative",
                      fontFamily: "'Google Sans', 'Plus Jakarta Sans', sans-serif",
                    }}>
                    <div style={{ position: "absolute", top: -8, right: 8, background: "#188038", color: "#fff", padding: "2px 8px", borderRadius: 4, fontSize: 9, fontWeight: 700, letterSpacing: "0.04em" }}>SAVE 16%</div>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "#202124", marginBottom: 4, display: "flex", alignItems: "center", gap: 6 }}>
                      <I name="calendar" size={13} style={{ color: billing === "annual" ? accent : "#5F6368" }} />
                      Annual Commitment
                    </div>
                    <div style={{ fontSize: 11, color: "#5F6368", lineHeight: 1.4 }}>
                      12 months upfront · lowest per-user rate
                    </div>
                    {billing === "annual" && (
                      <div style={{ position: "absolute", top: 8, right: 8, width: 14, height: 14, borderRadius: "50%", background: accent, color: "#fff", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700 }}>✓</div>
                    )}
                  </button>
                </div>
              </div>

              {/* Tier selector — only if multiple tiers available */}
              {availableTiers && availableTiers.length > 1 && (
                <div>
                  <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 6 }}>Choose your plan</div>
                  <div style={{ display: "grid", gridTemplateColumns: `repeat(${availableTiers.length}, 1fr)`, gap: 8 }}>
                    {availableTiers.map(t => {
                      const isActive = (t.id || t.name) === (activeTier.id || activeTier.name);
                      const showPrice = billing === "annual" ? (t.promoPrice || t.price) : (t.monthlyPromoPrice || t.monthlyPrice || t.price);
                      return (
                        <button
                          key={t.id || t.name}
                          onClick={() => setSelectedTier(t)}
                          style={{
                            background: isActive ? "#E8F0FE" : "#fff",
                            border: "1.5px solid " + (isActive ? accent : "#DADCE0"),
                            borderRadius: 8,
                            padding: "10px 12px",
                            cursor: "pointer",
                            textAlign: "left",
                            position: "relative",
                            fontFamily: "'Google Sans', 'Plus Jakarta Sans', sans-serif",
                          }}>
                          <div style={{ fontSize: 12, fontWeight: 600, color: "#202124", marginBottom: 2 }}>{t.name.replace("Business ", "")}</div>
                          <div style={{ fontSize: 11, color: "#5F6368" }}>
                            <span style={{ fontWeight: 600, color: "#202124" }}>₹{showPrice.toLocaleString("en-IN")}</span>/user/mo
                          </div>
                          {t.promoLabel && (
                            <div style={{ position: "absolute", top: -8, right: -6, background: "#188038", color: "#fff", padding: "1px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700 }}>20% OFF</div>
                          )}
                          {isActive && (
                            <div style={{ position: "absolute", top: 6, right: 8, width: 14, height: 14, borderRadius: "50%", background: accent, color: "#fff", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700 }}>
                              ✓
                            </div>
                          )}
                        </button>
                      );
                    })}
                  </div>
                  <div style={{ fontSize: 10, color: "#5F6368", marginTop: 6, fontStyle: "italic" }}>
                    Need Enterprise? <a href="#" onClick={(e) => { e.preventDefault(); onClose(); }} style={{ color: accent, fontStyle: "normal" }}>Contact our team via WhatsApp</a>
                  </div>
                </div>
              )}

              <div>
                <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Company name *</div>
                <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Corp Pvt Ltd" style={inputStyle} />
              </div>
              <div>
                <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>
                  Business domain *
                  <span style={{ color: "#6B6457", fontWeight: 400, marginLeft: 6 }}>
                    ({isGoogleProduct ? "Workspace" : "your subscription"} will be provisioned at @this-domain)
                  </span>
                </div>
                <input value={domain} onChange={(e) => setDomain(e.target.value.toLowerCase().trim())} placeholder="acmecorp.com" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }} />
                {domain && !domainValid && (
                  <div style={{ fontSize: 10, color: "#92400E", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                    <I name="alert" size={10} /> Enter a valid domain like <span className="mono">acmecorp.com</span>
                  </div>
                )}
                {!domain && (
                  <div style={{ fontSize: 10, color: "#6B6457", marginTop: 4, fontStyle: "italic" }}>
                    Don't have one? <a href="#" onClick={(e) => e.preventDefault()} style={{ color: accent, fontStyle: "normal" }}>We register .in / .com domains for ₹400–₹1,200/year</a>
                  </div>
                )}
                {domainValid && (
                  <div style={{ fontSize: 10, color: "#166534", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                    <I name="check_circle" size={10} /> Will be set up at @{domain} · DNS verification in 24h
                  </div>
                )}
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Your name *</div>
                  <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rajesh Kumar" style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Business email *</div>
                  <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={domain ? `rajesh@${domain}` : "rajesh@acme.com"} style={inputStyle} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>WhatsApp / Phone *</div>
                  <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" style={inputStyle} />
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>GSTIN (optional)</div>
                  <input value={gstin} onChange={(e) => setGstin(e.target.value)} placeholder="for input tax credit" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace" }} />
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>State (place of supply)</div>
                  <select value={state} onChange={(e) => setState(e.target.value)} style={inputStyle}>
                    <option>Maharashtra (27)</option>
                    <option>Delhi (07)</option>
                    <option>Karnataka (29)</option>
                    <option>Tamil Nadu (33)</option>
                    <option>Gujarat (24)</option>
                    <option>Uttar Pradesh (09)</option>
                    <option>Telangana (36)</option>
                  </select>
                </div>
                <div>
                  <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Users</div>
                  <input type="number" value={users} min={1} onChange={(e) => setUsers(Math.max(1, +e.target.value || 1))} style={inputStyle} />
                </div>
              </div>
              {/* Billing cycle was moved to top of form */}
            </div>
          </div>

          {/* Right — order summary */}
          <div style={{ padding: 24, background: "#FAF8F2" }}>
            <div style={{ fontSize: 11, color: "#6B6457", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 12 }}>Order summary</div>
            <div style={{ background: "#fff", padding: 14, borderRadius: 8, marginBottom: 12, border: "1px solid #E8E2D4" }}>
              <div style={{ fontSize: 12, fontWeight: 600 }}>{product} {activeTier.name}</div>
              <div style={{ fontSize: 11, color: "#6B6457", marginTop: 4 }}>{users} users × ₹{perUserMonth}/mo</div>
              <div style={{ fontSize: 11, color: "#6B6457" }}>{billing === "annual" ? "Annual billing · 12 months" : "Monthly billing"}</div>
            </div>
            <div style={{ display: "grid", gap: 6, fontSize: 12, marginBottom: 12 }}>
              <PdfRow label={billing === "annual" ? "Subtotal (12 months)" : "Subtotal (1 month)"} value={rupee(subtotal)} />
              {billing === "annual" && activeTier && activeTier.monthlyPrice && (
                <div style={{ fontSize: 10, color: "#166534", fontStyle: "italic", marginTop: -3, marginBottom: 2 }}>
                  ✓ Saves {rupee((activeTier.monthlyPromoPrice || activeTier.monthlyPrice) * users * 12 - subtotal)} vs Flexible plan
                </div>
              )}
              <PdfRow label="Taxable amount" value={rupee(taxable)} />
              {interState ? (
                <PdfRow label="IGST (18%)" value={rupee(tax)} />
              ) : (
                <>
                  <PdfRow label="CGST (9%)" value={rupee(cgst)} />
                  <PdfRow label="SGST (9%)" value={rupee(sgst)} />
                </>
              )}
            </div>
            <div style={{ borderTop: "1.5px solid #1A1815", paddingTop: 10, marginBottom: 14, display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
              <span style={{ fontSize: 11, color: "#6B6457", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600 }}>Total</span>
              <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 26, color: accent, fontVariantNumeric: "tabular-nums" }}>{rupee(total)}</span>
            </div>
            {errorMsg && (
              <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", color: "#92400E", padding: "8px 12px", borderRadius: 6, fontSize: 11, marginBottom: 10, display: "flex", alignItems: "flex-start", gap: 6, lineHeight: 1.5 }}>
                <I name="alert" size={12} /> {errorMsg}
              </div>
            )}
            <button
              onClick={handlePay}
              style={{
                width: "100%",
                background: accent,
                color: "#fff",
                border: "none",
                padding: "14px",
                borderRadius: 8,
                fontSize: 14,
                fontWeight: 700,
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                boxShadow: "0 4px 14px " + accent + "55",
                opacity: missing.length > 0 ? 0.85 : 1,
                transition: "opacity 150ms, transform 100ms",
                fontFamily: "'Google Sans', sans-serif",
              }}
              onMouseDown={(e) => e.currentTarget.style.transform = "scale(0.98)"}
              onMouseUp={(e) => e.currentTarget.style.transform = "scale(1)"}
              onMouseLeave={(e) => e.currentTarget.style.transform = "scale(1)"}
            >
              <I name="lock" size={14} /> Pay {rupee(total)} via Razorpay
            </button>
            <div style={{ fontSize: 10, color: "#6B6457", textAlign: "center", marginTop: 10, lineHeight: 1.5 }}>
              UPI · Cards · Net banking · Wallets<br />
              🔒 256-bit SSL · ✓ GST e-invoice issued instantly
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function TrialSignupModal({ tier, availableTiers, product, accent, accentSoft, seats, onClose, onActivate }) {
  const [selectedTier, setSelectedTier] = useState(tier);
  const [company, setCompany] = useState("");
  const [domain, setDomain]   = useState("");
  const [name, setName]   = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [users, setUsers] = useState(Math.min(10, seats));
  const [submitted, setSubmitted] = useState(false);
  const [errorMsg, setErrorMsg]   = useState("");
  const activeTier = selectedTier || tier;
  const personalDomain = /@(gmail|yahoo|hotmail|outlook|rediffmail|aol)\./i.test(email);
  // More forgiving domain check — accept anything with at least one dot and a 2+ char TLD
  const domainValid = /^[a-z0-9][a-z0-9-]*(\.[a-z0-9][a-z0-9-]*)+$/i.test(domain.trim()) && domain.includes(".");

  // What's missing? Used for friendly nudges
  const missing = [];
  if (!company.trim())  missing.push("company name");
  if (!domain.trim())   missing.push("business domain");
  else if (!domainValid) missing.push("valid domain (e.g. acmecorp.com)");
  if (!name.trim())     missing.push("your name");
  if (!email.trim() && !phone.trim()) missing.push("email or phone");

  const handleActivate = () => {
    if (missing.length > 0) {
      setErrorMsg(`Please add: ${missing.join(", ")}`);
      setTimeout(() => setErrorMsg(""), 4000);
      return;
    }
    onActivate({ company, domain, name, email, phone, users });
    setSubmitted(true);
  };

  // Success state — beautiful confirmation after activation
  if (submitted) {
    return (
      <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }} onClick={onClose}>
        <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: 540, maxWidth: "100%", overflow: "hidden" }}>
          {/* Success header */}
          <div style={{ background: "linear-gradient(135deg, #1A73E8 0%, #34A853 100%)", color: "#fff", padding: "32px 24px", textAlign: "center" }}>
            <div style={{ width: 64, height: 64, borderRadius: "50%", background: "rgba(255,255,255,0.2)", display: "grid", placeItems: "center", margin: "0 auto 14px", border: "2px solid rgba(255,255,255,0.4)" }}>
              <I name="check" size={36} />
            </div>
            <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 24, lineHeight: 1.2 }}>Trial activated!</div>
            <div style={{ fontSize: 13, opacity: 0.98, marginTop: 8, background: "rgba(255,255,255,0.95)", color: "#202124", padding: "6px 14px", borderRadius: 999, display: "inline-block", fontFamily: "'Google Sans', sans-serif", fontWeight: 500 }}>
              {product.includes("Google Workspace") ? (
                <><GWInline workspaceColor="#5F6368" workspaceWeight={400} /> {activeTier.name} · 14 days · {users} {users === 1 ? "user" : "users"}</>
              ) : (
                <>{product} {tier.name} · 14 days · {users} {users === 1 ? "user" : "users"}</>
              )}
            </div>
          </div>

          {/* Account details */}
          <div style={{ padding: "20px 24px", background: "#F8F9FA", borderBottom: "1px solid #E8E2D4" }}>
            <div style={{ fontSize: 11, color: "#5F6368", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 10 }}>Your trial details</div>
            <div style={{ display: "grid", gap: 8, fontSize: 13 }}>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#5F6368" }}>Company</span>
                <b style={{ color: "#202124" }}>{company}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#5F6368" }}>Workspace domain</span>
                <b style={{ color: "#202124", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>@{domain || "(set up after signup)"}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#5F6368" }}>Admin email</span>
                <b style={{ color: "#202124", fontFamily: "'JetBrains Mono', monospace", fontSize: 12 }}>{email || "(we'll WhatsApp you)"}</b>
              </div>
              <div style={{ display: "flex", justifyContent: "space-between" }}>
                <span style={{ color: "#5F6368" }}>Trial ends</span>
                <b style={{ color: "#202124" }}>{new Date(Date.now() + 14*86400000).toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" })}</b>
              </div>
            </div>
          </div>

          {/* What happens next */}
          <div style={{ padding: "20px 24px" }}>
            <div style={{ fontSize: 11, color: "#5F6368", textTransform: "uppercase", letterSpacing: "0.08em", fontWeight: 600, marginBottom: 14 }}>What happens next</div>
            <div style={{ display: "grid", gap: 14 }}>
              {[
                { num: "1", title: "Within 1 hour", body: `Admin credentials sent to ${email || phone || "you"}` },
                { num: "2", title: "Today",         body: `We'll WhatsApp you the DNS records to verify @${domain || "your domain"}` },
                { num: "3", title: "Within 24h",    body: "Your Workspace is fully live · ready for your team" },
                { num: "4", title: "Day 14",        body: "Convert to paid or auto-cancel · zero card on file" },
              ].map(step => (
                <div key={step.num} style={{ display: "flex", gap: 12 }}>
                  <div style={{ width: 28, height: 28, borderRadius: "50%", background: accentSoft, color: accent, display: "grid", placeItems: "center", fontWeight: 600, fontSize: 13, flexShrink: 0 }}>{step.num}</div>
                  <div>
                    <div style={{ fontSize: 12, fontWeight: 600, color: "#202124" }}>{step.title}</div>
                    <div style={{ fontSize: 12, color: "#5F6368", marginTop: 2, lineHeight: 1.5 }}>{step.body}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Footer actions */}
          <div style={{ background: "#F8F9FA", padding: "16px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderTop: "1px solid #E8E2D4" }}>
            <div style={{ fontSize: 11, color: "#5F6368", display: "flex", alignItems: "center", gap: 6 }}>
              <I name="whatsapp" size={12} style={{ color: "#25D366" }} /> Rahul will WhatsApp within 2 hours
            </div>
            <button onClick={onClose} style={{ background: accent, color: "#fff", border: "none", padding: "10px 22px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Done
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "grid", placeItems: "center", zIndex: 100, padding: 20 }} onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, width: 520, maxWidth: "100%", overflow: "hidden" }}>
        <div style={{ background: "#fff", color: "#202124", padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center", borderBottom: "1px solid #E8E2D4" }}>
          <div>
            <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.08em", color: "#5F6368", fontWeight: 600 }}>14-day free trial</div>
            <div style={{ fontFamily: "'Google Sans', 'Plus Jakarta Sans', sans-serif", fontSize: 22, fontWeight: 500, marginTop: 4 }}>
              {product.includes("Google Workspace") ? (
                <><GWInline workspaceColor="#5F6368" workspaceWeight={400} /> {activeTier.name}</>
              ) : (
                <>{product} {activeTier.name}</>
              )}
            </div>
          </div>
          <button onClick={onClose} style={{ background: "#F1F3F4", color: "#5F6368", border: "none", width: 32, height: 32, borderRadius: 6, cursor: "pointer", fontSize: 18 }}>×</button>
        </div>

        <div style={{ padding: "16px 24px", background: accentSoft, fontSize: 12, color: "#1A1815", display: "flex", alignItems: "center", gap: 10 }}>
          <I name="check_circle" size={14} style={{ color: accent }} />
          <span><b>No credit card needed.</b> Full access for 14 days. Auto-cancels if not converted — no charges, ever.</span>
        </div>

        <div style={{ padding: 24, display: "grid", gap: 12 }}>

          {/* Tier selector — choose which Workspace plan to trial */}
          {availableTiers && availableTiers.length > 1 && (
            <div>
              <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 6 }}>Choose your plan to trial</div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${availableTiers.length}, 1fr)`, gap: 8 }}>
                {availableTiers.map(t => {
                  const isActive = (t.id || t.name) === (activeTier.id || activeTier.name);
                  const showPrice = t.promoPrice || t.price;
                  return (
                    <button
                      key={t.id || t.name}
                      onClick={() => setSelectedTier(t)}
                      style={{
                        background: isActive ? "#E8F0FE" : "#fff",
                        border: "1.5px solid " + (isActive ? accent : "#DADCE0"),
                        borderRadius: 8,
                        padding: "10px 12px",
                        cursor: "pointer",
                        textAlign: "left",
                        position: "relative",
                        fontFamily: "'Google Sans', 'Plus Jakarta Sans', sans-serif",
                      }}>
                      <div style={{ fontSize: 12, fontWeight: 600, color: "#202124", marginBottom: 2 }}>{t.name.replace("Business ", "")}</div>
                      <div style={{ fontSize: 11, color: "#5F6368" }}>
                        Trial of <span style={{ fontWeight: 600, color: "#202124" }}>₹{showPrice.toLocaleString("en-IN")}</span>/user/mo plan
                      </div>
                      {t.promoLabel && (
                        <div style={{ position: "absolute", top: -8, right: -6, background: "#188038", color: "#fff", padding: "1px 6px", borderRadius: 4, fontSize: 9, fontWeight: 700 }}>20% OFF</div>
                      )}
                      {isActive && (
                        <div style={{ position: "absolute", top: 6, right: 8, width: 14, height: 14, borderRadius: "50%", background: accent, color: "#fff", display: "grid", placeItems: "center", fontSize: 9, fontWeight: 700 }}>
                          ✓
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
              <div style={{ fontSize: 10, color: "#5F6368", marginTop: 6, fontStyle: "italic" }}>
                Try any plan free for 14 days — switch tiers or upgrade anytime during the trial.
              </div>
            </div>
          )}

          <div>
            <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Company name *</div>
            <input value={company} onChange={(e) => setCompany(e.target.value)} placeholder="Acme Corp Pvt Ltd" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>
              Business domain *
              <span style={{ color: "#6B6457", fontWeight: 400, marginLeft: 6 }}>(your Workspace will be set up at @this-domain)</span>
            </div>
            <input value={domain} onChange={(e) => setDomain(e.target.value.toLowerCase().trim())} placeholder="acmecorp.com" style={{ ...inputStyle, fontFamily: "'JetBrains Mono', monospace", fontSize: 13 }} />
            {domain && !domainValid && (
              <div style={{ fontSize: 10, color: "#92400E", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <I name="alert" size={10} /> Enter a valid domain like <span className="mono">acmecorp.com</span> or <span className="mono">acme.in</span>
              </div>
            )}
            {!domain && (
              <div style={{ fontSize: 10, color: "#6B6457", marginTop: 4, fontStyle: "italic" }}>
                Don't have a domain yet? <a href="#" onClick={(e) => e.preventDefault()} style={{ color: accent, fontStyle: "normal" }}>We register .in / .com domains for ₹400–₹1,200/year</a>
              </div>
            )}
            {domainValid && (
              <div style={{ fontSize: 10, color: "#166534", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <I name="check_circle" size={10} /> Trial emails will be @{domain} · DNS verification after signup
              </div>
            )}
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Your name *</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Rajesh Kumar" style={inputStyle} />
          </div>
          <div>
            <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Business email * <span style={{ color: "#6B6457", fontWeight: 400 }}>(used to provision trial)</span></div>
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder={domain ? `rajesh@${domain}` : "rajesh@acme.com"} style={inputStyle} />
            {personalDomain && (
              <div style={{ fontSize: 10, color: "#92400E", marginTop: 4, display: "flex", alignItems: "center", gap: 4 }}>
                <I name="alert" size={10} /> Please use your business email (not Gmail/Yahoo) — trial requires a custom domain
              </div>
            )}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
            <div>
              <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>WhatsApp / Phone *</div>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" style={inputStyle} />
            </div>
            <div>
              <div style={{ fontSize: 11, color: "#6B6457", fontWeight: 600, marginBottom: 4 }}>Trial users (max 10)</div>
              <input type="number" min={1} max={10} value={users} onChange={(e) => setUsers(Math.min(10, Math.max(1, +e.target.value || 1)))} style={inputStyle} />
            </div>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 8, marginTop: 4 }}>
            {[
              { icon: "check", title: "Full features", sub: "Same as paid plan" },
              { icon: "clock", title: "14 days", sub: "Then decide" },
              { icon: "x", title: "No card", sub: "Zero risk" },
            ].map(b => (
              <div key={b.title} style={{ background: "#FAF8F2", padding: 10, borderRadius: 6, textAlign: "center" }}>
                <I name={b.icon} size={14} style={{ color: accent }} />
                <div style={{ fontSize: 11, fontWeight: 600, marginTop: 2 }}>{b.title}</div>
                <div style={{ fontSize: 10, color: "#6B6457" }}>{b.sub}</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 10, color: "#6B6457", lineHeight: 1.5, marginTop: 4 }}>
            By starting, you agree to our trial terms — convert to paid after 14 days or cancel anytime. DPDP Act 2023 compliant — your data is stored in Mumbai.
          </div>
        </div>

        {/* Inline error message — shown after click if fields are missing */}
        {errorMsg && (
          <div style={{ background: "#FEF3C7", border: "1px solid #FCD34D", color: "#92400E", padding: "10px 16px", margin: "0 24px", borderRadius: 8, fontSize: 12, display: "flex", alignItems: "center", gap: 8 }}>
            <I name="alert" size={14} /> {errorMsg}
          </div>
        )}

        <div style={{ display: "flex", gap: 8, padding: "12px 24px 24px", justifyContent: "flex-end", alignItems: "center" }}>
          <button onClick={onClose} style={{ background: "transparent", color: "#1A1815", border: "none", padding: "10px 16px", fontSize: 13, cursor: "pointer" }}>
            Cancel
          </button>
          <button
            onClick={handleActivate}
            style={{
              background: accent,
              color: "#fff",
              border: "none",
              padding: "12px 22px",
              borderRadius: 8,
              fontSize: 14,
              fontWeight: 600,
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              boxShadow: "0 2px 8px " + accent + "44",
              opacity: missing.length > 0 ? 0.85 : 1,
              transition: "opacity 150ms, transform 100ms",
            }}
            onMouseDown={(e) => e.currentTarget.style.transform = "scale(0.98)"}
            onMouseUp={(e) => e.currentTarget.style.transform = "scale(1)"}
            onMouseLeave={(e) => e.currentTarget.style.transform = "scale(1)"}
          >
            <I name="spark" size={14} /> Activate my 14-day trial
          </button>
        </div>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS["buy-workspace"] = () => <BuyCloudScreen productKey="workspace" />;
window.SCREENS["buy-m365"]      = () => <BuyCloudScreen productKey="m365" />;
window.SCREENS["buy-zoho"]      = () => <BuyCloudScreen productKey="zoho" />;

// Expose shared components so v2 (clean redesign) can reuse them
Object.assign(window, {
  PremierPartnerBadge,
  GoogleWorkspaceLogo,
  GWInline,
  GeminiSpark,
  GoogleAppImg,
  GmailGeminiMock,
  WORKSPACE_APPS,
  GOOGLE_ICONS,
  TrialSignupModal,
  BuyNowModal,
  PRODUCT_CONFIGS,
});
