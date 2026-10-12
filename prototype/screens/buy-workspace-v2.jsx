/* eslint-disable */
// Buy Workspace V2 — visitor-focused clean redesign
// Single clear CTA, linear story, minimal cognitive load
// Route: #/buy-workspace-v2

// Google's reseller-available pricing tiers (Business Base excluded — vendor-direct only)
// Features have inline icon keys for "same-to-same" Google pricing card visual
const GOOGLE_PRICING_TIERS = [
  {
    id: "google-starter",
    name: "Business Starter",
    price: 270,
    promoPrice: null,
    monthlyPrice: 325,
    monthlyPromoPrice: null,
    promoLabel: null,
    maxUsers: 300,
    cta: "Start a trial",
    introHeader: "Starter includes:",
    features: [
      { icon: "drive",    text: "30 GB pooled storage per person" },
      { icon: "gmail",    text: "Custom business email @yourcompany" },
      { icon: "gemini",   text: "Gemini AI in Gmail" },
      { icon: "gemini",   text: "Gemini app access + NotebookLM" },
      { icon: "meet",     text: "100-participant video meetings" },
      { icon: "calendar", text: "Workspace Studio automation + Google Vids" },
      { icon: "shield",   text: "Security and management controls" },
      { icon: "users",    text: "Standard support · up to 300 users" },
    ],
  },
  {
    id: "google-standard",
    name: "Business Standard",
    price: 1080,
    promoPrice: 864,
    monthlyPrice: 1300,
    monthlyPromoPrice: 1040,
    promoLabel: "20% off",
    promoTerms: "Promotional rate applies to first 20 users for 12 months",
    maxUsers: 300,
    cta: "Start a trial",
    mostPopular: true,
    introHeader: "All of Starter, and:",
    features: [
      { icon: "drive",    text: "2 TB pooled storage per person · 65× more" },
      { icon: "gmail",    text: "Custom business email @yourcompany" },
      { icon: "gemini",   text: "Gemini in Docs, Meet, Sheets, Slides" },
      { icon: "gemini",   text: "Expanded NotebookLM access" },
      { icon: "meet",     text: "150-participant meetings with recording" },
      { icon: "meet",     text: "Noise cancellation + auto-transcripts" },
      { icon: "calendar", text: "Appointment booking" },
      { icon: "docs",     text: "eSignature in Docs and PDFs" },
      { icon: "drive",    text: "Google Workspace Migrate tool" },
    ],
  },
  {
    id: "google-enterprise",
    name: "Enterprise",
    price: null,
    customPricing: true,
    customLabel: "Let's talk",
    maxUsers: null,
    cta: "Contact sales",
    introHeader: "All features mentioned, with:",
    features: [
      { icon: "drive",    text: "5 TB pooled storage per person" },
      { icon: "gmail",    text: "Custom business email @yourcompany" },
      { icon: "meet",     text: "Video meeting with livestreaming · 1,000 participants" },
      { icon: "shield",   text: "S/MIME encryption" },
      { icon: "shield",   text: "Data Loss Prevention (DLP)" },
      { icon: "shield",   text: "Context-aware access policies" },
      { icon: "shield",   text: "Enterprise data regions" },
      { icon: "users",    text: "Cloud Identity Premium" },
      { icon: "shield",   text: "Endpoint management + AI Classification" },
      { icon: "users",    text: "Enhanced support for mission-critical issues" },
    ],
  },
];

// Comparison table data — Productivity, AI, Security categories
const COMPARE_CATEGORIES = [
  {
    name: "Productivity and collaboration",
    icon: "gmail",
    rows: [
      { feature: "Custom email for your business",                 vals: [true, true, true] },
      { feature: "Customer email with phishing and spam protection", vals: [true, true, true] },
      { feature: "Ad-free email experience",                         vals: [true, true, true] },
      { feature: "Pooled storage per user",                          vals: ["30 GB", "2 TB", "5 TB"] },
      { feature: "Shared drives for teams",                          vals: [false, true, true] },
      { feature: "Vault retention + eDiscovery",                     vals: [false, false, true] },
      { feature: "Video meetings · max participants",                vals: ["100", "150", "1,000"] },
      { feature: "Meeting recording saved to Drive",                 vals: [false, true, true] },
      { feature: "Noise cancellation",                               vals: [false, true, true] },
      { feature: "Livestreaming meetings",                           vals: [false, false, true] },
      { feature: "Appointment booking + Bookings",                   vals: [false, true, true] },
    ],
  },
  {
    name: "AI · Gemini in Workspace",
    icon: "gemini",
    rows: [
      { feature: "Gemini in Gmail · help me write + summarize",      vals: [true, true, true] },
      { feature: "Gemini in Docs · drafts and rewrites",             vals: [false, true, true] },
      { feature: "Gemini in Meet · auto notes + action items",       vals: [false, true, true] },
      { feature: "Gemini in Sheets · formulas + analysis",           vals: [false, true, true] },
      { feature: "Gemini in Slides · image generation",              vals: [false, true, true] },
      { feature: "Gemini app · standalone access",                   vals: ["Basic", "Expanded", "Expanded"] },
      { feature: "NotebookLM · AI research assistant",               vals: ["Basic", "Expanded", "Expanded"] },
      { feature: "AI Classification + sensitivity labels",           vals: [false, false, true] },
    ],
  },
  {
    name: "Security and management",
    icon: "shield",
    rows: [
      { feature: "2-step verification",                              vals: [true, true, true] },
      { feature: "Admin console + management controls",              vals: [true, true, true] },
      { feature: "Group-based policy controls",                      vals: [false, true, true] },
      { feature: "Endpoint management for mobile + desktop",         vals: ["Basic", "Advanced", "Enterprise"] },
      { feature: "S/MIME encryption for email",                      vals: [false, false, true] },
      { feature: "Data Loss Prevention (DLP)",                       vals: [false, false, true] },
      { feature: "Context-aware access",                             vals: [false, false, true] },
      { feature: "Vault retention + eDiscovery",                     vals: [false, false, true] },
      { feature: "Cloud Identity Premium",                           vals: [false, false, true] },
    ],
  },
];

// Google Chat icon — inline SVG (4-color speech bubble) with clean proportions
function GoogleChatIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
      {/* Green silhouette: rounded square body + bottom-left tail */}
      <path d="M 12 6 H 88 Q 94 6 94 12 V 64 Q 94 70 88 70 H 38 L 16 92 L 24 70 H 12 Q 6 70 6 64 V 12 Q 6 6 12 6 Z" fill="#34A853"/>
      {/* Blue — top-left quadrant (covers left + rounded top-left corner) */}
      <path d="M 12 6 Q 6 6 6 12 V 48 H 38 V 6 Z" fill="#4285F4"/>
      {/* Yellow — top-middle band */}
      <rect x="38" y="6" width="42" height="24" fill="#FBBC04"/>
      {/* Red — top-right corner accent (small triangle) */}
      <path d="M 80 6 H 88 Q 94 6 94 12 V 22 Z" fill="#EA4335"/>
      {/* White interior speech area */}
      <rect x="38" y="30" width="42" height="18" fill="#FFFFFF"/>
    </svg>
  );
}

// Google Docs icon — inline SVG (custom style with blue document + "Docs" label band)
function GoogleDocsIcon({ size = 48 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg" style={{ display: "block" }}>
      {/* Document body — blue with folded top-right corner */}
      <path d="M 18 6 Q 18 4 20 4 H 66 L 82 20 V 94 Q 82 96 80 96 H 20 Q 18 96 18 94 Z" fill="#4285F4"/>
      {/* Folded corner — dark indigo/purple */}
      <path d="M 66 4 V 20 H 82 Z" fill="#3730A3"/>
      {/* Horizontal text lines */}
      <rect x="28" y="32" width="22" height="3.5" rx="1.5" fill="#FFFFFF"/>
      <rect x="28" y="42" width="44" height="3.5" rx="1.5" fill="#FFFFFF"/>
      <rect x="28" y="52" width="44" height="3.5" rx="1.5" fill="#FFFFFF"/>
      <rect x="28" y="62" width="44" height="3.5" rx="1.5" fill="#FFFFFF"/>
      {/* Bottom "Docs" label band — overlays document bottom */}
      <path d="M 18 76 H 82 V 94 Q 82 96 80 96 H 20 Q 18 96 18 94 Z" fill="#3730A3"/>
      <text x="50" y="91" fontSize="13" fontWeight="800" fill="#FFFFFF" textAnchor="middle" fontFamily="'Plus Jakarta Sans', system-ui, sans-serif" letterSpacing="-0.02em">Docs</text>
    </svg>
  );
}

// Feature row icon source — uses GOOGLE_ICONS where possible
function getRowIcon(key, size = 16) {
  const url = GOOGLE_ICONS[key];
  if (url) {
    const app = WORKSPACE_APPS.find(a => a.key === key);
    return <GoogleAppImg src={url} alt={key} size={size} fallbackColor={app?.color || "#1A73E8"} />;
  }
  // Built-in icons for non-product items
  if (key === "gemini") return <GeminiSpark size={size} />;
  if (key === "shield") return <I name="shield" size={size} style={{ color: "#188038" }} />;
  if (key === "users")  return <I name="users" size={size} style={{ color: "#5F6368" }} />;
  return <I name="check" size={size} style={{ color: "#1A73E8" }} />;
}

function BuyWorkspaceV2() {
  const cfg = PRODUCT_CONFIGS.workspace;
  const [showTrial, setShowTrial] = useState(false);
  const [showBuyNow, setShowBuyNow] = useState(false);
  // Default to Google's actual Most Popular tier (Standard ₹864 promo / ₹1,080)
  const [tier, setTier] = useState(GOOGLE_PRICING_TIERS.find(t => t.mostPopular) || GOOGLE_PRICING_TIERS[1]);
  const { toast } = useToast();

  // Theme tokens
  const bg     = "#FAF8F2";
  const card   = "#fff";
  const ink    = "#1A1815";
  const ink3   = "#6B6457";
  const hair   = "#E8E2D4";
  const accent = cfg.accent;

  const openTrial  = (t) => { setTier(t); setShowTrial(true); };
  const openBuyNow = (t) => { setTier(t); setShowBuyNow(true); };
  const onWhatsApp = () => toast("Opening WhatsApp · +91 98765 11111");

  return (
    <div style={{ background: bg, color: ink, minHeight: "100vh", fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif" }}>

      {/* MINIMAL TOP NAV — logo + tiny partner pill + one CTA */}
      <div style={{ background: card, borderBottom: "1px solid " + hair, position: "sticky", top: 0, zIndex: 50 }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", padding: "14px 24px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{ width: 32, height: 32, background: ink, color: bg, borderRadius: 6, display: "grid", placeItems: "center", fontFamily: "'DM Serif Display', serif", fontSize: 18 }}>R</div>
              <div>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 16, lineHeight: 1 }}>Demo Co</div>
                <div style={{ fontSize: 9, color: ink3, marginTop: 2 }}>Cloud Reseller · India</div>
              </div>
            </div>
            <div style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "linear-gradient(135deg, #1A1815 0%, #2D2418 100%)", color: "#FCD34D", padding: "4px 10px", borderRadius: 999, fontSize: 10, fontWeight: 600, border: "1px solid #FBBF24" }}>
              <span style={{ fontSize: 11 }}>★</span> Google Premier Partner
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button onClick={() => openBuyNow(tier)} style={{ background: card, color: ink, border: "1.5px solid " + hair, padding: "8px 14px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Buy now
            </button>
            <button onClick={() => openTrial(tier)} style={{ background: accent, color: "#fff", border: "none", padding: "9px 18px", borderRadius: 8, fontSize: 13, fontWeight: 600, cursor: "pointer" }}>
              Start free trial
            </button>
          </div>
        </div>
      </div>

      {/* HERO — replicates the FES Cloud composition with people at desk + floating Google app icons */}
      <div style={{
        position: "relative",
        padding: "72px 24px 80px",
        backgroundImage: "linear-gradient(90deg, rgba(250,248,242,0.96) 0%, rgba(250,248,242,0.82) 28%, rgba(250,248,242,0.35) 52%, rgba(250,248,242,0.05) 72%), url('./assets/hero-workspace-bg.jpg'), url('https://images.unsplash.com/photo-1573164574572-cb89e39749b4?w=1920&q=85&auto=format&fit=crop')",
        backgroundSize: "cover, cover, cover",
        backgroundPosition: "center, center right, center right",
        backgroundRepeat: "no-repeat",
        backgroundColor: bg,
        overflow: "hidden",
        minHeight: 580,
      }}>
        {/* Soft side-fade — already baked into the gradient layer above */}
        <div style={{ position: "absolute", inset: 0, zIndex: 1, pointerEvents: "none" }} />
        {/* Color-tint overlay using Google's brand colors (subtle) */}
        <div style={{
          position: "absolute",
          inset: 0,
          background: "radial-gradient(circle at 80% 30%, rgba(66,133,244,0.06) 0%, transparent 50%), radial-gradient(circle at 20% 70%, rgba(234,67,53,0.04) 0%, transparent 50%)",
          zIndex: 1,
          pointerEvents: "none",
        }} />

        {/* Floating Google app icons — varied sizes for depth (Sheets/Slides removed, Chat added) */}
        {[
          { key: "drive",    src: GOOGLE_ICONS.drive,    color: "#FBBC04", top: "8%",  right: "32%", size: 60, anim: "float-1 6s ease-in-out infinite",   delay: "0s"   },
          { key: "meet",     src: GOOGLE_ICONS.meet,     color: "#00897B", top: "4%",  right: "19%", size: 52, anim: "float-2 7s ease-in-out infinite",   delay: "0.4s" },
          { key: "chat",     src: "https://upload.wikimedia.org/wikipedia/commons/8/82/Google_Chat_Logo_05.2026.png", color: "#34A853", top: "16%", right: "9%",  size: 54, anim: "float-3 8s ease-in-out infinite",   delay: "1.2s" },
          { key: "gmail",    src: GOOGLE_ICONS.gmail,    color: "#EA4335", top: "32%", right: "26%", size: 64, anim: "float-1 6.5s ease-in-out infinite", delay: "0.8s" },
          { key: "docs",     src: null,                  color: "#4285F4", top: "26%", right: "13%", size: 54, anim: "float-2 7.5s ease-in-out infinite", delay: "0.2s" },
          { key: "calendar", src: GOOGLE_ICONS.calendar, color: "#1A73E8", top: "54%", right: "32%", size: 58, anim: "float-3 7s ease-in-out infinite",   delay: "1s"   },
          { key: "gemini",   src: null,                  color: "#9333EA", top: "46%", right: "12%", size: 56, anim: "float-1 7.2s ease-in-out infinite", delay: "0.6s" },
        ].map(ic => (
          <div key={ic.key} style={{
            position: "absolute",
            top: ic.top,
            right: ic.right,
            zIndex: 2,
            pointerEvents: "none",
            animation: ic.anim,
            animationDelay: ic.delay,
          }}>
            <div style={{
              width: ic.size,
              height: ic.size,
              background: "#fff",
              borderRadius: "50%",
              display: "grid",
              placeItems: "center",
              boxShadow: "0 12px 32px rgba(60,64,67,0.18), 0 2px 6px rgba(60,64,67,0.10)",
            }}>
              {ic.key === "gemini"
                ? <GeminiSpark size={Math.round(ic.size * 0.58)} />
                : ic.key === "docs"
                  ? <GoogleDocsIcon size={Math.round(ic.size * 0.66)} />
                  : <GoogleAppImg src={ic.src} alt={ic.key} size={Math.round(ic.size * 0.58)} fallbackColor={ic.color} />
              }
            </div>
          </div>
        ))}

        <div style={{ position: "relative", zIndex: 3, maxWidth: 1120, margin: "0 auto", display: "grid", gridTemplateColumns: "1.2fr 1fr", gap: 56, alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, color: ink3, textTransform: "uppercase", letterSpacing: "0.12em", fontWeight: 600, marginBottom: 14 }}>
              Authorised Google Premier Partner
            </div>
            <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 56, lineHeight: 1.02, margin: 0, marginBottom: 18, letterSpacing: "-0.015em" }}>
              <GWInline workspaceColor="#5F6368" workspaceWeight={400} />, live in 24 hours.
            </h1>
            <p style={{ fontSize: 18, lineHeight: 1.55, color: ink3, marginBottom: 28, maxWidth: 540 }}>
              Same price as Google direct. With free hands-on migration, dedicated Hindi support, and a real account manager — not a ticket queue.
            </p>

            {/* Price preview — pulled from cheapest reseller-available tier (Business Starter) */}
            <div style={{ display: "inline-flex", alignItems: "baseline", gap: 4, marginBottom: 24 }}>
              <span style={{ fontSize: 14, color: ink3 }}>From</span>
              <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 36, color: accent, lineHeight: 1 }}>₹270</span>
              <span style={{ fontSize: 14, color: ink3 }}>/user/month</span>
              <span style={{ fontSize: 12, color: ink3, marginLeft: 6, fontStyle: "italic" }}>(annual)</span>
            </div>

            {/* Two clear paths: try first OR buy now */}
            <div style={{ display: "flex", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
              <button onClick={() => openTrial(tier)} style={{ background: accent, color: "#fff", border: "none", padding: "16px 28px", borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer", boxShadow: "0 6px 20px " + accent + "44", display: "inline-flex", alignItems: "center", gap: 8 }}>
                Start free 14-day trial <I name="arrow_right" size={16} />
              </button>
              <button onClick={() => openBuyNow(tier)} style={{ background: card, color: ink, border: "1.5px solid " + ink, padding: "16px 28px", borderRadius: 10, fontSize: 15, fontWeight: 600, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 8 }}>
                <I name="cart" size={16} /> Buy directly
              </button>
            </div>

            {/* Clarify the difference between the two paths */}
            <div style={{ fontSize: 12, color: ink3, marginBottom: 18, lineHeight: 1.6, maxWidth: 540 }}>
              <b style={{ color: ink }}>Not sure yet?</b> Start with 14-day trial — no card needed.<br/>
              <b style={{ color: ink }}>Ready to commit?</b> Buy directly via Razorpay — provisioned in 24 hours.
            </div>

            {/* WhatsApp as tertiary text link */}
            <div style={{ marginBottom: 18 }}>
              <button onClick={onWhatsApp} style={{ background: "transparent", color: ink, border: "none", padding: 0, cursor: "pointer", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 3, display: "inline-flex", alignItems: "center", gap: 6 }}>
                <I name="whatsapp" size={14} style={{ color: "#25D366" }} /> Or ask on WhatsApp first
              </button>
            </div>

            {/* Trust line */}
            <div style={{ fontSize: 12, color: ink3, display: "flex", flexWrap: "wrap", gap: 18, alignItems: "center" }}>
              <span><b style={{ color: ink }}>★ 4.8</b> from 247 businesses</span>
              <span>·</span>
              <span>No credit card needed</span>
              <span>·</span>
              <span>Cancel anytime</span>
            </div>
          </div>

          {/* Right column — Premier Partner badge gets prominent display with gold accent + verified tagline */}
          <div style={{ position: "relative", minHeight: 460, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "flex-end", gap: 16 }}>
            {/* Premier Partner badge — big, with golden glow ring, and "Verified" pill */}
            <div style={{
              position: "relative",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: 12,
            }}>
              {/* Golden glow ring behind badge */}
              <div style={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                width: 200,
                height: 200,
                borderRadius: "50%",
                background: "radial-gradient(circle, rgba(251,188,4,0.28) 0%, rgba(251,188,4,0.10) 40%, transparent 70%)",
                filter: "blur(8px)",
                zIndex: 0,
                pointerEvents: "none",
              }} />

              {/* Badge with golden ring + drop shadow */}
              <div style={{
                position: "relative",
                background: "linear-gradient(135deg, #FBBC04 0%, #F59E0B 50%, #FBBC04 100%)",
                borderRadius: "50%",
                padding: 4,
                boxShadow: "0 18px 48px rgba(60,64,67,0.32), 0 6px 14px rgba(245,158,11,0.30), 0 0 0 1px rgba(245,158,11,0.15)",
                transform: "rotate(4deg)",
                zIndex: 1,
              }}>
                <div style={{
                  background: "#fff",
                  borderRadius: "50%",
                  padding: 3,
                }}>
                  <PremierPartnerBadge size={140} type="workspace" />
                </div>
              </div>

              {/* "Verified" pill below the badge */}
              <div style={{
                position: "relative",
                zIndex: 1,
                background: "#fff",
                border: "1px solid #E8E2D4",
                borderRadius: 999,
                padding: "6px 14px",
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
                fontSize: 11,
                fontWeight: 600,
                color: "#1A1815",
                boxShadow: "0 6px 16px rgba(60,64,67,0.10)",
                transform: "rotate(-2deg)",
              }}>
                <svg width="14" height="14" viewBox="0 0 24 24">
                  <path fill="#34A853" d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm-2 16l-4-4 1.41-1.41L10 14.17l6.59-6.59L18 9l-8 8z"/>
                </svg>
                <span>Verified at <b>cloud.google.com</b></span>
              </div>

              {/* "Top 1%" tagline */}
              <div style={{
                position: "relative",
                zIndex: 1,
                fontSize: 11,
                color: "#6B6457",
                fontStyle: "italic",
                textAlign: "center",
                letterSpacing: "0.02em",
              }}>
                Top 1% of Google's Indian partners
              </div>
            </div>
          </div>

          {/* DEAD-CODE BLOCK REMOVED — was display:none monitor mockup; replaced by background photo */}
          {false && (
            <div style={{ position: "relative", width: "100%", maxWidth: 500, perspective: "1400px" }}>

              {/* Ambient screen glow — subtle blue light spilling from monitor */}
              <div style={{
                position: "absolute",
                top: "5%",
                left: "-6%",
                right: "-6%",
                bottom: "-2%",
                background: "radial-gradient(ellipse at 50% 50%, rgba(66,133,244,0.18) 0%, rgba(66,133,244,0.06) 35%, transparent 65%)",
                filter: "blur(20px)",
                zIndex: 0,
                pointerEvents: "none",
              }} />

              {/* Monitor bezel (thin matte black, modern InfinityEdge style) */}
              <div style={{
                background: "linear-gradient(180deg, #232323 0%, #161616 50%, #0E0E0E 100%)",
                borderRadius: "10px 10px 4px 4px",
                padding: "8px 8px 22px",
                boxShadow: "0 40px 80px rgba(0,0,0,0.45), 0 16px 32px rgba(0,0,0,0.22), inset 0 1px 0 rgba(255,255,255,0.08), inset 0 -1px 0 rgba(0,0,0,0.6)",
                transform: "rotateX(2deg)",
                transformStyle: "preserve-3d",
                position: "relative",
                zIndex: 1,
              }}>
                {/* Webcam dot — top center of bezel */}
                <div style={{ position: "absolute", top: 3, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 3 }}>
                  <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#0a0a0a", border: "0.5px solid #333", boxShadow: "inset 0 0 1px rgba(100,150,255,0.4)" }} />
                </div>

                {/* Screen — recessed feel via inner shadow */}
                <div style={{
                  background: "#F6F8FC",
                  borderRadius: 4,
                  overflow: "hidden",
                  border: "1px solid #050505",
                  boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.04), inset 0 2px 6px rgba(0,0,0,0.4)",
                  position: "relative",
                }}>
                  {/* === CHROME BROWSER === */}
                  {/* Tab bar */}
                  <div style={{ background: "#DEE1E6", padding: "5px 8px 0", display: "flex", alignItems: "flex-end", gap: 2 }}>
                    {/* Active tab — Gmail */}
                    <div style={{
                      background: "#fff",
                      borderRadius: "8px 8px 0 0",
                      padding: "5px 10px 6px",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 9,
                      color: "#202124",
                      fontFamily: "system-ui, sans-serif",
                      fontWeight: 500,
                      maxWidth: 130,
                      borderTop: "2px solid #1A73E8",
                      marginTop: -2,
                    }}>
                      <GoogleAppImg src={GOOGLE_ICONS.gmail} alt="Gmail" size={11} fallbackColor="#EA4335" />
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>Inbox · acmecorp</span>
                      <span style={{ marginLeft: 4, fontSize: 11, color: "#9AA0A6" }}>×</span>
                    </div>
                    {/* Inactive tab — Drive */}
                    <div style={{
                      background: "#CDD0D5",
                      borderRadius: "8px 8px 0 0",
                      padding: "5px 10px 5px",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 9,
                      color: "#5F6368",
                      fontFamily: "system-ui, sans-serif",
                      maxWidth: 100,
                    }}>
                      <GoogleAppImg src={GOOGLE_ICONS.drive} alt="Drive" size={10} fallbackColor="#1A73E8" />
                      <span style={{ whiteSpace: "nowrap" }}>My Drive</span>
                    </div>
                    {/* Inactive tab — Sheets */}
                    <div style={{
                      background: "#CDD0D5",
                      borderRadius: "8px 8px 0 0",
                      padding: "5px 10px 5px",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontSize: 9,
                      color: "#5F6368",
                      fontFamily: "system-ui, sans-serif",
                      maxWidth: 100,
                    }}>
                      <GoogleAppImg src={GOOGLE_ICONS.sheets} alt="Sheets" size={10} fallbackColor="#0F9D58" />
                      <span style={{ whiteSpace: "nowrap" }}>Q1-Sales</span>
                    </div>
                    <span style={{ padding: "0 6px", color: "#5F6368", fontSize: 12, alignSelf: "center", lineHeight: 1 }}>+</span>
                    <div style={{ flex: 1 }} />
                  </div>

                  {/* Address bar */}
                  <div style={{ background: "#fff", padding: "6px 10px", display: "flex", alignItems: "center", gap: 8, borderBottom: "1px solid #E8EAED" }}>
                    <div style={{ display: "flex", gap: 6, color: "#5F6368" }}>
                      <I name="arrow_left" size={10} />
                      <I name="arrow_right" size={10} />
                      <I name="refresh" size={10} />
                    </div>
                    <div style={{
                      flex: 1,
                      background: "#F1F3F4",
                      borderRadius: 14,
                      padding: "3px 10px",
                      fontSize: 9,
                      color: "#5F6368",
                      display: "flex",
                      alignItems: "center",
                      gap: 5,
                      fontFamily: "system-ui, sans-serif",
                    }}>
                      <I name="lock" size={8} style={{ color: "#34A853" }} />
                      <span>mail.google.com</span>
                      <span style={{ color: "#BDC1C6" }}>/u/0/#inbox</span>
                    </div>
                    <div style={{ display: "grid", placeItems: "center", width: 16, height: 16, borderRadius: "50%", background: "#1A73E8", color: "#fff", fontSize: 8, fontWeight: 600 }}>P</div>
                  </div>

                  {/* === GMAIL APP === */}
                  {/* Gmail header bar */}
                  <div style={{ background: "#F6F8FC", padding: "6px 12px", display: "flex", alignItems: "center", gap: 10, borderBottom: "1px solid #E8EAED" }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ width: 12, height: 1.5, background: "#5F6368", borderRadius: 1 }} />
                      <span style={{ width: 12, height: 1.5, background: "#5F6368", borderRadius: 1 }} />
                      <span style={{ width: 12, height: 1.5, background: "#5F6368", borderRadius: 1 }} />
                    </div>
                    {/* Multi-color "Gmail" wordmark */}
                    <span style={{ fontFamily: "'Google Sans', system-ui, sans-serif", fontSize: 13, fontWeight: 500, letterSpacing: "-0.005em" }}>
                      <span style={{ color: "#4285F4" }}>G</span>
                      <span style={{ color: "#EA4335" }}>m</span>
                      <span style={{ color: "#FBBC04" }}>a</span>
                      <span style={{ color: "#4285F4" }}>i</span>
                      <span style={{ color: "#34A853" }}>l</span>
                    </span>
                    {/* Search bar */}
                    <div style={{ flex: 1, background: "#EAF1FB", borderRadius: 8, padding: "4px 10px", display: "flex", alignItems: "center", gap: 6, fontSize: 9, color: "#5F6368", fontFamily: "system-ui, sans-serif" }}>
                      <I name="search" size={9} />
                      <span>Search mail</span>
                    </div>
                    {/* Gemini + apps + avatar */}
                    <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                      <GeminiSpark size={13} />
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 2px)", gap: 1.5 }}>
                        {[0,1,2,3,4,5,6,7,8].map(i => <span key={i} style={{ width: 2, height: 2, borderRadius: "50%", background: "#5F6368" }} />)}
                      </div>
                      <div style={{ width: 16, height: 16, borderRadius: "50%", background: "#C2410C", color: "#fff", display: "grid", placeItems: "center", fontSize: 8, fontWeight: 600 }}>P</div>
                    </div>
                  </div>

                  {/* Gmail body — sidebar + inbox */}
                  <div style={{ display: "grid", gridTemplateColumns: "70px 1fr", background: "#F6F8FC", minHeight: 230 }}>

                    {/* Sidebar */}
                    <div style={{ padding: "8px 6px", display: "flex", flexDirection: "column", gap: 4, borderRight: "1px solid #E8EAED" }}>
                      {/* Compose pill */}
                      <button style={{
                        background: "linear-gradient(180deg, #FCEAE9 0%, #F6D6D2 100%)",
                        color: "#A50E0E",
                        border: "none",
                        padding: "6px 8px",
                        borderRadius: 14,
                        fontSize: 9,
                        fontWeight: 600,
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        cursor: "default",
                        fontFamily: "system-ui, sans-serif",
                        boxShadow: "0 1px 3px rgba(0,0,0,0.08)",
                      }}>
                        <span style={{ fontSize: 12, lineHeight: 1 }}>✏</span>
                        Compose
                      </button>
                      {/* Nav rows */}
                      {[
                        { lbl: "Inbox", count: 12, active: true },
                        { lbl: "Starred", count: null },
                        { lbl: "Sent", count: null },
                        { lbl: "Drafts", count: 3 },
                      ].map(n => (
                        <div key={n.lbl} style={{
                          fontSize: 9,
                          padding: "4px 6px",
                          borderRadius: 10,
                          background: n.active ? "#FCE8E6" : "transparent",
                          color: n.active ? "#A50E0E" : "#3C4043",
                          fontWeight: n.active ? 600 : 400,
                          display: "flex",
                          justifyContent: "space-between",
                          fontFamily: "system-ui, sans-serif",
                        }}>
                          <span>{n.lbl}</span>
                          {n.count && <span style={{ fontSize: 8 }}>{n.count}</span>}
                        </div>
                      ))}
                      {/* Hangouts / Meet panel (mini) */}
                      <div style={{ marginTop: 8, paddingTop: 8, borderTop: "1px solid #E8EAED", display: "flex", flexDirection: "column", gap: 5, alignItems: "center" }}>
                        <GoogleAppImg src={GOOGLE_ICONS.meet} alt="Meet" size={14} fallbackColor="#00897B" />
                        <GoogleAppImg src={GOOGLE_ICONS.calendar} alt="Calendar" size={14} fallbackColor="#4285F4" />
                      </div>
                    </div>

                    {/* Inbox + reading pane */}
                    <div style={{ background: "#fff", display: "flex", flexDirection: "column" }}>
                      {/* Inbox toolbar */}
                      <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 10px", borderBottom: "1px solid #E8EAED", fontSize: 8, color: "#5F6368", fontFamily: "system-ui, sans-serif" }}>
                        <span style={{ width: 10, height: 10, border: "1px solid #5F6368", borderRadius: 2 }} />
                        <I name="refresh" size={9} />
                        <span style={{ flex: 1 }} />
                        <span>1–50 of 247</span>
                        <I name="chevron_left" size={9} />
                        <I name="chevron_right" size={9} />
                      </div>

                      {/* Email list — 3 rows */}
                      {[
                        { sender: "Rajesh K.", snippet: "Re: Workspace upgrade — yes, 25 seats works for us", time: "9:42 AM", unread: true, starred: true },
                        { sender: "Razorpay", snippet: "Payment of ₹86,400 received from Acme Corp · GST inv", time: "8:11 AM", unread: true, starred: false },
                        { sender: "Google Workspace", snippet: "Migration completed · 30/30 mailboxes ready", time: "Mon", unread: false, starred: false },
                      ].map((mail, mi) => (
                        <div key={mi} style={{
                          display: "grid",
                          gridTemplateColumns: "14px 14px 70px 1fr 32px",
                          gap: 6,
                          padding: "5px 10px",
                          fontSize: 9,
                          borderBottom: "1px solid #F1F3F4",
                          fontWeight: mail.unread ? 600 : 400,
                          color: mail.unread ? "#202124" : "#5F6368",
                          alignItems: "center",
                          fontFamily: "system-ui, sans-serif",
                        }}>
                          <span style={{ width: 9, height: 9, border: "1px solid #BDC1C6", borderRadius: 1.5 }} />
                          <span style={{ color: mail.starred ? "#FBBC04" : "#BDC1C6", fontSize: 11, lineHeight: 1 }}>{mail.starred ? "★" : "☆"}</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mail.sender}</span>
                          <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mail.snippet}</span>
                          <span style={{ fontSize: 8, color: mail.unread ? "#202124" : "#5F6368", textAlign: "right" }}>{mail.time}</span>
                        </div>
                      ))}

                      {/* Compose floating window — bottom right */}
                      <div style={{ flex: 1, position: "relative" }}>
                        <div style={{
                          position: "absolute",
                          right: 8,
                          bottom: 8,
                          width: "78%",
                          background: "#fff",
                          border: "1px solid #DADCE0",
                          borderRadius: "6px 6px 0 0",
                          boxShadow: "0 -6px 18px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.02)",
                          overflow: "hidden",
                        }}>
                          {/* Compose header */}
                          <div style={{ background: "#404040", color: "#fff", padding: "4px 10px", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 9, fontFamily: "system-ui, sans-serif" }}>
                            <span style={{ fontWeight: 500 }}>Re: Workspace plan upgrade</span>
                            <span style={{ display: "flex", gap: 6, fontSize: 10, opacity: 0.7 }}>
                              <span>−</span><span>▢</span><span>×</span>
                            </span>
                          </div>
                          {/* Compose to/subject */}
                          <div style={{ padding: "6px 10px 0", fontSize: 9, color: "#202124", fontFamily: "system-ui, sans-serif" }}>
                            <div style={{ display: "flex", gap: 6, borderBottom: "1px solid #F1F3F4", paddingBottom: 3 }}>
                              <span style={{ color: "#5F6368" }}>To</span>
                              <span style={{ background: "#E8F0FE", color: "#1967D2", padding: "1px 6px", borderRadius: 999, fontSize: 8 }}>rajesh@acmecorp.com ×</span>
                            </div>
                          </div>
                          {/* Gemini AI suggestion box */}
                          <div style={{
                            margin: "6px 10px 8px",
                            background: "linear-gradient(135deg, #E8F0FE 0%, #FCE8FC 100%)",
                            border: "1px solid #C5B5F7",
                            borderRadius: 6,
                            padding: 8,
                            fontFamily: "system-ui, sans-serif",
                          }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 4 }}>
                              <GeminiSpark size={10} />
                              <span style={{ fontSize: 8, fontWeight: 700, color: "#5F6368", textTransform: "uppercase", letterSpacing: "0.06em" }}>Help me write</span>
                            </div>
                            <div style={{ fontSize: 8.5, color: "#202124", lineHeight: 1.45, marginBottom: 5 }}>
                              "Thanks Rajesh! For 25 seats, the Standard annual plan saves ₹46,200/year. I'll send the GST quote within 2 hours…"
                            </div>
                            <div style={{ display: "flex", gap: 4 }}>
                              <button style={{ background: "#1A73E8", color: "#fff", border: "none", padding: "2px 8px", borderRadius: 4, fontSize: 8, fontWeight: 600, cursor: "default" }}>Insert</button>
                              <button style={{ background: "transparent", color: "#5F6368", border: "1px solid #DADCE0", padding: "2px 8px", borderRadius: 4, fontSize: 8, cursor: "default" }}>Refine</button>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* === Diagonal screen glare overlay === */}
                  <div style={{
                    position: "absolute",
                    inset: 0,
                    background: "linear-gradient(115deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0) 35%, rgba(255,255,255,0.18) 45%, rgba(255,255,255,0.04) 55%, rgba(255,255,255,0) 65%)",
                    pointerEvents: "none",
                    mixBlendMode: "screen",
                  }} />
                </div>

                {/* Bottom bezel — brand chin with power LED */}
                <div style={{ position: "relative", marginTop: 8, display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                  <span style={{ fontSize: 7.5, color: "#666", letterSpacing: "0.22em", fontFamily: "system-ui, sans-serif", fontWeight: 600 }}>
                    EXCEL · ULTRASHARP
                  </span>
                  {/* Power LED */}
                  <span style={{
                    position: "absolute",
                    right: 8,
                    bottom: 2,
                    width: 4,
                    height: 4,
                    borderRadius: "50%",
                    background: "#34D399",
                    boxShadow: "0 0 6px #34D399, 0 0 12px rgba(52,211,153,0.5)",
                  }} />
                </div>
              </div>

              {/* Monitor neck — narrow vertical column */}
              <div style={{ margin: "0 auto", width: 28, height: 32, background: "linear-gradient(180deg, #1E1E1E 0%, #0E0E0E 100%)", boxShadow: "0 6px 12px rgba(0,0,0,0.3), inset 1px 0 0 rgba(255,255,255,0.04), inset -1px 0 0 rgba(0,0,0,0.4)" }} />

              {/* Monitor base — wide flat stand */}
              <div style={{
                margin: "-3px auto 0",
                width: 200,
                height: 12,
                background: "linear-gradient(180deg, #2A2A2A 0%, #161616 50%, #0A0A0A 100%)",
                borderRadius: "4px 4px 50% 50% / 4px 4px 100% 100%",
                boxShadow: "0 14px 26px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.08)",
              }} />

              {/* Cast shadow on desk surface */}
              <div style={{
                margin: "4px auto 0",
                width: "70%",
                height: 18,
                background: "radial-gradient(ellipse at center, rgba(0,0,0,0.32) 0%, rgba(0,0,0,0.12) 50%, transparent 75%)",
                filter: "blur(2px)",
              }} />

              {/* Premier Partner badge — floating top-right of the monitor */}
              <div style={{
                position: "absolute",
                top: -22,
                right: -18,
                background: "#fff",
                borderRadius: "50%",
                padding: 3,
                boxShadow: "0 8px 22px rgba(60, 64, 67, 0.28)",
                transform: "rotate(8deg)",
                zIndex: 4,
              }}>
                <PremierPartnerBadge size={74} type="workspace" />
              </div>

              {/* Gemini badge — floating bottom-left */}
              <div style={{
                position: "absolute",
                bottom: 70,
                left: -18,
                background: "linear-gradient(135deg, #E8F0FE 0%, #FCE8FC 100%)",
                border: "1px solid #C5B5F7",
                borderRadius: 999,
                padding: "5px 12px",
                fontSize: 10,
                fontWeight: 600,
                color: "#3C4043",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                boxShadow: "0 8px 20px rgba(147, 51, 234, 0.22)",
                transform: "rotate(-3deg)",
                zIndex: 4,
              }}>
                <GeminiSpark size={11} />
                Gemini AI built-in
              </div>

              {/* Live indicator — pulsing dot top-left */}
              <div style={{
                position: "absolute",
                top: 18,
                left: -14,
                background: "#fff",
                borderRadius: 999,
                padding: "3px 9px 3px 8px",
                fontSize: 9,
                fontWeight: 600,
                color: "#34A853",
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                boxShadow: "0 6px 16px rgba(52,168,83,0.22), 0 0 0 1px rgba(52,168,83,0.12)",
                transform: "rotate(-2deg)",
                zIndex: 4,
              }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#34A853", boxShadow: "0 0 8px #34A853" }} />
                LIVE
              </div>
            </div>
          )}
        </div>
      </div>

      {/* WHY US — 3 clear cards (no overlap with rest) */}
      <div style={{ background: card, borderTop: "1px solid " + hair, borderBottom: "1px solid " + hair, padding: "60px 24px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0, lineHeight: 1.15 }}>
              Three reasons to buy from us, not direct.
            </h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 20 }}>
            {[
              {
                num: "01",
                title: "Same price. Zero markup.",
                body: "Google's per-seat price is exactly what you pay — ₹270 Starter · ₹864 Standard (promo) · custom Enterprise. Reseller margin is built into Google's pricing. You save zero by going direct.",
                proof: "Verified at cloud.google.com/find-a-partner",
              },
              {
                num: "02",
                title: "Dedicated Indian support.",
                body: "WhatsApp + phone in Hindi, English, or Marathi from our Mumbai team. Avg response 2 hours. You get a real account manager — not Google's ticket queue.",
                proof: "9 AM–9 PM IST · 247+ customers managed",
              },
              {
                num: "03",
                title: "Free hands-on migration.",
                body: "DNS, MX, SPF, DKIM, DMARC + bulk user import + admin training, all done by us. Migration from M365, Zoho, on-prem Exchange — free for any deal ₹50K+.",
                proof: "Worth ₹50K · zero downtime · weekend deployments",
              },
            ].map(card => (
              <div key={card.num} style={{ padding: 28, background: bg, borderRadius: 14, position: "relative" }}>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 48, color: accent, lineHeight: 1, marginBottom: 14, letterSpacing: "-0.02em" }}>{card.num}</div>
                <div style={{ fontSize: 18, fontWeight: 600, marginBottom: 10, color: ink, fontFamily: "'DM Serif Display', serif" }}>{card.title}</div>
                <div style={{ fontSize: 13, color: ink3, lineHeight: 1.6, marginBottom: 14 }}>{card.body}</div>
                <div style={{ fontSize: 11, color: ink3, fontStyle: "italic", display: "flex", alignItems: "center", gap: 5 }}>
                  <I name="check_circle" size={11} style={{ color: "#166534" }} /> {card.proof}
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* HOW IT WORKS — 3 steps, ultra clear */}
      <div style={{ padding: "60px 24px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 44 }}>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0, lineHeight: 1.15, marginBottom: 8 }}>
              From sign-up to live — three steps.
            </h2>
            <p style={{ fontSize: 14, color: ink3 }}>Total time: under 24 hours from payment to fully deployed.</p>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 0, alignItems: "stretch", position: "relative" }}>
            {[
              { icon: "package", title: "Pick a plan", sub: "Use our pricing below — Starter, Standard, or Plus. Or just start a free trial first.", time: "2 minutes" },
              { icon: "lock",    title: "Pay or trial",  sub: "Razorpay (UPI, card, net banking) — or start a 14-day free trial with no card.",     time: "1 minute" },
              { icon: "rocket",  title: "We set it up",  sub: "We handle DNS, users, training — your team is fully live within 24 hours.",          time: "24 hours" },
            ].map((s, i, arr) => (
              <div key={s.title} style={{ position: "relative", padding: "0 12px" }}>
                <div style={{ background: card, border: "1px solid " + hair, borderRadius: 14, padding: 28, height: "100%" }}>
                  <div style={{ width: 56, height: 56, borderRadius: 14, background: cfg.accentSoft, color: accent, display: "grid", placeItems: "center", marginBottom: 18 }}>
                    <I name={s.icon} size={26} />
                  </div>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginBottom: 8 }}>
                    <span style={{ fontFamily: "'DM Serif Display', serif", fontSize: 22, color: ink3 }}>{i + 1}.</span>
                    <span style={{ fontSize: 18, fontWeight: 600 }}>{s.title}</span>
                  </div>
                  <div style={{ fontSize: 13, color: ink3, lineHeight: 1.6, marginBottom: 14 }}>{s.sub}</div>
                  <div style={{ display: "inline-flex", alignItems: "center", gap: 4, background: cfg.accentSoft, color: accent, padding: "4px 10px", borderRadius: 999, fontSize: 11, fontWeight: 600 }}>
                    <I name="clock" size={10} /> {s.time}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* PRICING — same-to-same as workspace.google.com/pricing */}
      <GooglePricingSection
        openTrial={openTrial}
        onWhatsApp={onWhatsApp}
        accent="#1A73E8"
      />

      {/* TESTIMONIALS — 3 cards, simple */}
      <div style={{ padding: "60px 24px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0, lineHeight: 1.15, marginBottom: 8 }}>
              247+ Indian businesses run on us.
            </h2>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16 }}>
            {[
              { metric: "₹2.4L saved/year",    quote: "Migration in one weekend. Zero downtime. Proper GST invoice every month.",            name: "Dr. Verma", role: "CTO · Echo Pharma · Mumbai · 60 users",       initials: "EV" },
              { metric: "32 mid-cycle adds",   quote: "Pro-rata seat additions saved us so much hassle. Vendor direct couldn't do this.",   name: "Rajesh K", role: "CTO · Acme Corp · Mumbai · 30 users",          initials: "RK" },
              { metric: "2-hour avg response", quote: "WhatsApp pe Hindi mein baat. Vendor tickets 3 din mein resolve hote hain — yahan 2 hours.", name: "Priya M", role: "Ops · Beta Industries · Pune · 15 users",  initials: "PM" },
            ].map((t, i) => (
              <div key={i} style={{ background: card, border: "1px solid " + hair, borderRadius: 14, padding: 24 }}>
                <div style={{ display: "inline-block", background: "#166534", color: "#fff", padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, marginBottom: 14 }}>{t.metric}</div>
                <div style={{ fontFamily: "'DM Serif Display', serif", fontSize: 15, fontStyle: "italic", lineHeight: 1.5, color: ink, marginBottom: 16 }}>
                  "{t.quote}"
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, paddingTop: 14, borderTop: "1px solid " + hair }}>
                  <div style={{ width: 34, height: 34, borderRadius: "50%", background: cfg.accentSoft, color: accent, display: "grid", placeItems: "center", fontWeight: 600, fontSize: 12 }}>{t.initials}</div>
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{t.name}</div>
                    <div style={{ fontSize: 11, color: ink3 }}>{t.role}</div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* FAQ — top 5 only */}
      <div style={{ background: card, borderTop: "1px solid " + hair, padding: "60px 24px" }}>
        <div style={{ maxWidth: 760, margin: "0 auto" }}>
          <div style={{ textAlign: "center", marginBottom: 40 }}>
            <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 32, margin: 0, lineHeight: 1.15 }}>
              Quick answers.
            </h2>
          </div>
          <div className="stack-12">
            {[
              { q: "Is your price same as buying direct from Google?",   a: "Yes — exactly the same. Reseller margin is built into Google's pricing. You don't save by going direct." },
              { q: "What's actually different from buying direct from Google?", a: "Service, not pricing. With us you get: free hands-on migration (worth ₹50K), a real Indian account manager who picks up the phone, WhatsApp support in Hindi/Marathi/English, Razorpay payments (UPI, NEFT, cards — Google's portal is card-heavy), and Premier Partner escalation to Google engineering with a 4-hour SLA." },
              { q: "Don't I get a GST invoice from Google direct too?",  a: "Yes — both Google and we issue full GST e-invoices (HSN 998313, IRN, e-invoice compliant). GST isn't a differentiator. The difference is everything else around the invoice — migration, support, account management." },
              { q: "How fast is setup?",                                a: "Same-day for Starter. 24–48 hours for Standard including DNS, MX, SPF, DKIM, DMARC, user import, and one admin training session — all done by us, not you." },
              { q: "Can I cancel?",                                     a: "Anytime. Pro-rata refund for unused days. No lock-in. Trial period auto-cancels if not converted." },
              { q: "Is my data safe under DPDP Act 2023?",              a: "Yes. Google's India data residency option available + we never store your data on our servers (it stays in your Workspace tenant). Full DPDP compliance." },
            ].map((f, i) => (
              <details key={i} style={{ background: bg, border: "1px solid " + hair, borderRadius: 10, padding: 18 }}>
                <summary style={{ fontSize: 14, fontWeight: 600, cursor: "pointer", listStyle: "none", display: "flex", justifyContent: "space-between", alignItems: "center", color: ink }}>
                  {f.q}
                  <I name="chevron_down" size={14} style={{ color: ink3 }} />
                </summary>
                <div style={{ fontSize: 13, color: ink3, lineHeight: 1.6, marginTop: 12 }}>
                  {f.a}
                </div>
              </details>
            ))}
          </div>
        </div>
      </div>

      {/* FINAL CTA — single bold action */}
      <div style={{ background: "linear-gradient(135deg, #1A1815 0%, #2D2418 100%)", color: bg, padding: "80px 24px" }}>
        <div style={{ maxWidth: 720, margin: "0 auto", textAlign: "center" }}>
          <PremierPartnerBadge size={90} type="workspace" />
          <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: 40, margin: "24px 0 14px", lineHeight: 1.1 }}>
            Ready when you are.
          </h2>
          <p style={{ fontSize: 15, color: "#A6A19B", marginBottom: 32, lineHeight: 1.5 }}>
            Start with a free 14-day trial. No credit card. Convert when ready or cancel — fully your call.
          </p>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap", marginBottom: 14 }}>
            <button onClick={() => openTrial(tier)} style={{ background: accent, color: "#fff", border: "none", padding: "18px 32px", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", boxShadow: "0 8px 24px " + accent + "66", display: "inline-flex", alignItems: "center", gap: 10 }}>
              Start free 14-day trial <I name="arrow_right" size={18} />
            </button>
            <button onClick={() => openBuyNow(tier)} style={{ background: bg, color: ink, border: "none", padding: "18px 32px", borderRadius: 12, fontSize: 16, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 10 }}>
              <I name="cart" size={18} /> Buy now via Razorpay
            </button>
          </div>
          <div style={{ marginBottom: 20 }}>
            <button onClick={onWhatsApp} style={{ background: "transparent", color: bg, border: "1px solid rgba(250,248,242,0.3)", padding: "10px 20px", borderRadius: 8, fontSize: 13, fontWeight: 500, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6 }}>
              <I name="whatsapp" size={14} /> Have questions? WhatsApp us
            </button>
          </div>
          <div style={{ fontSize: 11, color: "#A6A19B", display: "flex", justifyContent: "center", gap: 14, flexWrap: "wrap" }}>
            <span>★ 4.8 from 247 businesses</span>
            <span>·</span>
            <span>No card needed</span>
            <span>·</span>
            <span>DPDP compliant</span>
          </div>
        </div>
      </div>

      {/* MINIMAL FOOTER */}
      <div style={{ background: card, borderTop: "1px solid " + hair, padding: "20px 24px" }}>
        <div style={{ maxWidth: 1120, margin: "0 auto", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12, fontSize: 12, color: ink3 }}>
          <div>© 2026 Demo Co Pvt Ltd · GSTIN 27AABCE9876D1Z3 · Mumbai</div>
          <div style={{ display: "flex", gap: 14 }}>
            <a href="#" style={{ color: ink3 }}>Privacy</a>
            <a href="#" style={{ color: ink3 }}>Terms</a>
            <a href="#" style={{ color: ink3 }}>Refund</a>
            <a href="#" style={{ color: ink3 }}>Contact</a>
          </div>
        </div>
      </div>

      {/* FLOATING WHATSAPP */}
      <button
        onClick={onWhatsApp}
        style={{
          position: "fixed",
          bottom: 24,
          right: 24,
          background: "#25D366",
          color: "#fff",
          border: "none",
          width: 56,
          height: 56,
          borderRadius: "50%",
          cursor: "pointer",
          boxShadow: "0 6px 20px rgba(37, 211, 102, 0.5)",
          display: "grid",
          placeItems: "center",
          zIndex: 90,
        }}
        aria-label="Chat on WhatsApp"
      >
        <I name="whatsapp" size={26} />
      </button>

      {/* TRIAL SIGNUP MODAL — reused from buy-cloud.jsx */}
      {showTrial && (
        <TrialSignupModal
          tier={tier}
          availableTiers={GOOGLE_PRICING_TIERS.filter(t => !t.customPricing)}
          product="Google Workspace"
          accent={accent}
          accentSoft={cfg.accentSoft}
          seats={25}
          onClose={() => setShowTrial(false)}
          onActivate={(data) => {
            toast(`14-day trial activated for ${data.company}`);
          }}
        />
      )}

      {/* BUY NOW MODAL — direct Razorpay checkout, no trial */}
      {showBuyNow && (
        <BuyNowModal
          tier={tier}
          availableTiers={GOOGLE_PRICING_TIERS.filter(t => !t.customPricing)}
          product="Google Workspace"
          accent={accent}
          accentSoft={cfg.accentSoft}
          seats={25}
          onClose={() => setShowBuyNow(false)}
          onPay={(data) => {
            toast(`Payment of ${data.totalLabel} confirmed · GST invoice ${data.invoiceNo} emailed`);
          }}
        />
      )}
    </div>
  );
}

// Google's pricing section — same-to-same as workspace.google.com/pricing
function GooglePricingSection({ openTrial, onWhatsApp, accent }) {
  const [userCount, setUserCount] = useState(1);
  const [billing, setBilling] = useState("annual"); // annual | monthly
  const [compareCat, setCompareCat] = useState(0);
  const activeTab = 1; // Standard always visually featured
  const promos = [
    "Now talking with Gemini in Workspace included with our Standard plan",
    "20% off Business Standard — first 20 users for 12 months",
    "Free migration from Microsoft 365 worth ₹50K for deals above ₹50K",
  ];
  const [promoIdx, setPromoIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setPromoIdx(i => (i + 1) % promos.length), 5000);
    return () => clearInterval(t);
  }, []);

  // Google design tokens
  const gInk     = "#202124";
  const gInk3    = "#5F6368";
  const gHair    = "#DADCE0";
  const gPaper   = "#fff";
  const gBg      = "#F8F9FA";
  const gBlue    = "#1A73E8";
  const gBlueSoft = "#E8F0FE";

  const fontSans = "'Google Sans', 'Plus Jakarta Sans', system-ui, sans-serif";

  return (
    <div style={{ background: gPaper, borderTop: "1px solid " + gHair, borderBottom: "1px solid " + gHair, padding: "56px 24px 80px", fontFamily: fontSans }}>
      <div style={{ maxWidth: 1180, margin: "0 auto" }}>
        {/* Section heading */}
        <div style={{ textAlign: "center", marginBottom: 32 }}>
          <h2 style={{ fontFamily: fontSans, fontSize: 36, margin: 0, lineHeight: 1.15, color: gInk, fontWeight: 500, letterSpacing: "-0.005em" }}>
            Plans for your business
          </h2>
          <div style={{ fontSize: 13, color: gInk3, marginTop: 10 }}>
            Annual commitment · Save 16% vs monthly · All plans billed yearly
          </div>
        </div>

        {/* Top control bar — Users counter · App icons · Annual toggle (Google's exact layout) */}
        <div style={{ background: gBg, border: "1px solid " + gHair, borderRadius: 12, padding: "10px 16px", marginBottom: 14, display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 24, alignItems: "center" }}>

          {/* LEFT — Users label + counter + info icon */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: gInk, fontWeight: 500 }}>Users</span>
            <div style={{ display: "flex", alignItems: "center", background: gPaper, border: "1px solid " + gHair, borderRadius: 6, overflow: "hidden" }}>
              <button onClick={() => setUserCount(Math.max(1, userCount - 1))} style={{ width: 26, height: 28, background: "transparent", border: "none", cursor: "pointer", color: gInk, fontSize: 14, fontWeight: 600 }}>−</button>
              <input
                type="number"
                value={userCount}
                min={1}
                max={300}
                onChange={(e) => setUserCount(Math.max(1, Math.min(300, +e.target.value || 1)))}
                style={{ width: 36, textAlign: "center", border: "none", padding: "4px 0", fontSize: 13, fontWeight: 600, color: gInk, fontFamily: fontSans, background: gPaper }}
              />
              <button onClick={() => setUserCount(Math.min(300, userCount + 1))} style={{ width: 26, height: 28, background: "transparent", border: "none", cursor: "pointer", color: gInk, fontSize: 14, fontWeight: 600 }}>+</button>
            </div>
            <span title="Adjust to see per-tier total" style={{ display: "grid", placeItems: "center", width: 18, height: 18, borderRadius: "50%", border: "1px solid " + gHair, color: gInk3, cursor: "help" }}>
              <I name="info" size={10} />
            </span>
          </div>

          {/* CENTER — App icons row (what's in every plan) */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 12 }}>
            {[
              { key: "gmail",    label: "Gmail" },
              { key: "calendar", label: "Calendar" },
              { key: "docs",     label: "Docs" },
              { key: "drive",    label: "Drive" },
              { key: "meet",     label: "Meet" },
              { key: "slides",   label: "Slides" },
            ].map(app => {
              const w = WORKSPACE_APPS.find(a => a.key === app.key);
              return (
                <div key={app.key} title={app.label} style={{ display: "grid", placeItems: "center" }}>
                  <GoogleAppImg src={GOOGLE_ICONS[app.key]} alt={app.label} size={26} fallbackColor={w?.color || "#1A73E8"} />
                </div>
              );
            })}
            <div title="Gemini AI" style={{ display: "grid", placeItems: "center" }}>
              <GeminiSpark size={26} />
            </div>
          </div>

          {/* RIGHT — Annual toggle with savings note */}
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 13, color: gInk, fontWeight: 500 }}>Annual</span>
            <span style={{ fontSize: 12, color: "#34A853", fontWeight: 600 }}>(Save 16% with one-year commitment)</span>
            <button
              onClick={() => setBilling(billing === "annual" ? "monthly" : "annual")}
              role="switch"
              aria-checked={billing === "annual"}
              style={{
                position: "relative",
                width: 36,
                height: 20,
                borderRadius: 999,
                background: billing === "annual" ? gBlue : "#9AA0A6",
                border: "none",
                cursor: "pointer",
                transition: "background 200ms",
                padding: 0,
              }}>
              <span style={{
                position: "absolute",
                top: 2,
                left: billing === "annual" ? 18 : 2,
                width: 16,
                height: 16,
                borderRadius: "50%",
                background: "#fff",
                transition: "left 200ms",
                boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
              }} />
            </button>
          </div>
        </div>

        {/* Promo banner with carousel arrows */}
        <div style={{ background: gBlueSoft, border: "1px solid #C5DBFB", borderRadius: 12, padding: "12px 16px", marginBottom: 28, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <button onClick={() => setPromoIdx((promoIdx - 1 + promos.length) % promos.length)} style={{ background: "transparent", border: "none", cursor: "pointer", color: gBlue, padding: 4, display: "grid", placeItems: "center" }}>
            <I name="chevron_left" size={16} />
          </button>
          <div style={{ flex: 1, textAlign: "center", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
            <GeminiSpark size={14} />
            <span style={{ fontSize: 13, color: gInk, fontWeight: 500 }}>{promos[promoIdx]}</span>
          </div>
          <button onClick={() => setPromoIdx((promoIdx + 1) % promos.length)} style={{ background: "transparent", border: "none", cursor: "pointer", color: gBlue, padding: 4, display: "grid", placeItems: "center" }}>
            <I name="chevron_right" size={16} />
          </button>
        </div>

        {/* Pricing cards — 3 columns */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 16, marginBottom: 18 }}>
          {GOOGLE_PRICING_TIERS.map((t, i) => {
            const isFeatured = activeTab === i;
            const isEnterprise = t.customPricing;
            // Pick price based on billing toggle
            const displayPrice    = isEnterprise ? null : (billing === "annual" ? (t.promoPrice || t.price)    : (t.monthlyPromoPrice || t.monthlyPrice));
            const displayStriked  = isEnterprise ? null : (billing === "annual" ? (t.promoPrice ? t.price : null) : (t.monthlyPromoPrice ? t.monthlyPrice : null));
            const annual          = (billing === "annual" && displayPrice) ? displayPrice * 12 : null;
            const monthly         = displayPrice;

            return (
              <div key={t.id} style={{
                background: gPaper,
                border: isFeatured ? "2px solid " + gBlue : "1px solid " + gHair,
                borderRadius: 12,
                padding: 24,
                position: "relative",
                display: "flex",
                flexDirection: "column",
                boxShadow: isFeatured ? "0 8px 30px rgba(26,115,232,0.12)" : "0 1px 2px rgba(60,64,67,0.08)",
                transition: "all 200ms",
              }}>
                {/* Tier name */}
                <div style={{ fontFamily: fontSans, fontSize: 28, fontWeight: 500, color: gInk, marginBottom: 14, letterSpacing: "-0.005em" }}>
                  {t.name}
                </div>

                {/* Promo pill (green, with ? icon) — appears above price for Standard */}
                {t.promoLabel && (
                  <div style={{ marginBottom: 10 }}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: "#E6F4EA", color: "#188038", padding: "3px 10px", borderRadius: 999, fontSize: 11, fontWeight: 500 }}>
                      {t.promoLabel}
                      <span style={{ display: "grid", placeItems: "center", width: 14, height: 14, borderRadius: "50%", border: "1px solid #188038", fontSize: 9, fontWeight: 600 }}>?</span>
                    </span>
                  </div>
                )}

                {/* Price */}
                {isEnterprise ? (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontFamily: fontSans, fontSize: 28, fontWeight: 500, color: gInk, lineHeight: 1.1 }}>
                      {t.customLabel}
                    </div>
                  </div>
                ) : (
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ fontFamily: fontSans, fontSize: 36, fontWeight: 500, color: gInk, lineHeight: 1, letterSpacing: "-0.01em" }}>
                        ₹{displayPrice.toLocaleString("en-IN")}
                      </span>
                      {displayStriked && (
                        <span style={{ fontSize: 14, color: gInk3, textDecoration: "line-through" }}>
                          ₹{displayStriked.toLocaleString("en-IN")}{billing === "monthly" ? "**" : ""}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 12, color: gInk3, marginTop: 4 }}>/user/month</div>
                    {billing === "annual" && (
                      <div style={{ fontSize: 11, color: gInk, marginTop: 8, fontWeight: 500 }}>
                        ₹{annual.toLocaleString("en-IN")} <span style={{ color: gInk3, fontWeight: 400 }}>/user/year · billed annually</span>
                      </div>
                    )}
                    {billing === "monthly" && (
                      <div style={{ fontSize: 10, color: gInk3, marginTop: 6, fontStyle: "italic" }}>
                        ** Monthly flex · no annual commitment savings
                      </div>
                    )}
                    {t.promoTerms && billing === "annual" && (
                      <div style={{ fontSize: 10, color: gInk3, fontStyle: "italic", marginTop: 6, lineHeight: 1.4 }}>
                        {t.promoTerms}
                      </div>
                    )}
                  </div>
                )}

                {/* Live total based on user count (annual mode only) */}
                {!isEnterprise && billing === "annual" && (
                  <div style={{ background: gBg, padding: "8px 10px", borderRadius: 6, marginBottom: 14, fontSize: 11, color: gInk3 }}>
                    <b style={{ color: gInk }}>{userCount} {userCount === 1 ? "user" : "users"}</b> · ₹{(annual * userCount).toLocaleString("en-IN")}<span style={{ color: gInk3 }}> /year</span>
                  </div>
                )}
                {!isEnterprise && billing === "monthly" && (
                  <div style={{ background: gBg, padding: "8px 10px", borderRadius: 6, marginBottom: 14, fontSize: 11, color: gInk3 }}>
                    <b style={{ color: gInk }}>{userCount} {userCount === 1 ? "user" : "users"}</b> · ₹{(monthly * userCount).toLocaleString("en-IN")}<span style={{ color: gInk3 }}> /month</span>
                  </div>
                )}

                {/* CTA */}
                <button
                  onClick={() => isEnterprise ? onWhatsApp() : openTrial({ id: t.id, name: t.name, price: monthly, bestFor: t.name, features: t.features.map(f => f.text) })}
                  style={{
                    width: "100%",
                    background: isFeatured ? gBlue : gPaper,
                    color: isFeatured ? "#fff" : gBlue,
                    border: isFeatured ? "none" : "1px solid " + gBlue,
                    padding: "10px 16px",
                    borderRadius: 6,
                    fontSize: 14,
                    fontWeight: 500,
                    cursor: "pointer",
                    marginBottom: 20,
                    fontFamily: fontSans,
                  }}>
                  {t.cta}
                </button>

                {/* Feature list with inline icons */}
                <div style={{ borderTop: "1px solid " + gHair, paddingTop: 16, flex: 1 }}>
                  <div style={{ fontSize: 13, fontWeight: 500, color: gInk, marginBottom: 12, fontStyle: t.introHeader.startsWith("All") ? "italic" : "normal", color: t.introHeader.startsWith("All") ? gBlue : gInk }}>
                    {t.introHeader}
                  </div>
                  <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
                    {t.features.map((f, fi) => (
                      <li key={fi} style={{ display: "flex", gap: 10, alignItems: "flex-start", marginBottom: 10 }}>
                        <div style={{ flexShrink: 0, width: 18, height: 18, display: "grid", placeItems: "center" }}>
                          {getRowIcon(f.icon, 18)}
                        </div>
                        <span style={{ fontSize: 12, color: "#3C4043", lineHeight: 1.5 }}>{f.text}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            );
          })}
        </div>

        {/* All plans note */}
        <div style={{ textAlign: "center", fontSize: 12, color: gInk3, marginBottom: 56 }}>
          All plans billed yearly · upgrade or downgrade anytime · GST extra at 18%
        </div>

        {/* ===== COMPARE ALL WORKSPACE FEATURES ===== */}
        <div style={{ borderTop: "1px solid " + gHair, paddingTop: 56 }}>
          <div style={{ textAlign: "center", marginBottom: 28 }}>
            <h3 style={{ fontFamily: fontSans, fontSize: 28, margin: 0, color: gInk, fontWeight: 500 }}>
              Compare all Workspace features
            </h3>
            <div style={{ fontSize: 13, color: gInk3, marginTop: 6 }}>Jump to product</div>
          </div>

          {/* Category tabs */}
          <div style={{ display: "flex", justifyContent: "center", gap: 8, marginBottom: 28, flexWrap: "wrap" }}>
            {COMPARE_CATEGORIES.map((cat, ci) => (
              <button
                key={cat.name}
                onClick={() => setCompareCat(ci)}
                style={{
                  background: compareCat === ci ? gBlueSoft : gPaper,
                  color: compareCat === ci ? gBlue : gInk,
                  border: "1px solid " + (compareCat === ci ? gBlue : gHair),
                  padding: "8px 16px",
                  borderRadius: 999,
                  fontSize: 13,
                  fontWeight: compareCat === ci ? 600 : 500,
                  cursor: "pointer",
                  fontFamily: fontSans,
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                }}>
                <span style={{ width: 14, height: 14, display: "grid", placeItems: "center" }}>{getRowIcon(cat.icon, 14)}</span>
                {cat.name}
              </button>
            ))}
          </div>

          {/* Comparison table */}
          <div style={{ background: gPaper, border: "1px solid " + gHair, borderRadius: 12, overflow: "hidden" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontFamily: fontSans }}>
              <thead>
                <tr style={{ background: gBg }}>
                  <th style={{ padding: "16px 20px", textAlign: "left", fontSize: 11, fontWeight: 600, color: gInk3, textTransform: "uppercase", letterSpacing: "0.06em", width: "40%" }}>
                    {COMPARE_CATEGORIES[compareCat].name}
                  </th>
                  {GOOGLE_PRICING_TIERS.map(t => {
                    const colPrice = t.customPricing ? null : (billing === "annual" ? (t.promoPrice || t.price) : (t.monthlyPromoPrice || t.monthlyPrice));
                    return (
                      <th key={t.id} style={{ padding: "16px 12px", textAlign: "center", fontSize: 13, fontWeight: 500, color: gInk, borderLeft: "1px solid " + gHair }}>
                        <div>{t.name}</div>
                        <div style={{ fontSize: 11, color: gInk3, fontWeight: 400, marginTop: 2 }}>
                          {t.customPricing ? "Custom" : `₹${colPrice.toLocaleString("en-IN")}/mo`}
                        </div>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {COMPARE_CATEGORIES[compareCat].rows.map((row, ri) => (
                  <tr key={ri} style={{ borderTop: "1px solid " + gHair }}>
                    <td style={{ padding: "14px 20px", fontSize: 13, color: gInk }}>{row.feature}</td>
                    {row.vals.map((v, vi) => (
                      <td key={vi} style={{ padding: "14px 12px", textAlign: "center", borderLeft: "1px solid " + gHair, fontSize: 12 }}>
                        {v === true ? (
                          <svg width="18" height="18" viewBox="0 0 24 24">
                            <path fill={gBlue} d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
                          </svg>
                        ) : v === false ? (
                          <span style={{ color: gInk3, fontSize: 16 }}>—</span>
                        ) : (
                          <span style={{ color: gInk, fontWeight: 500 }}>{v}</span>
                        )}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Bottom footnote */}
          <div style={{ marginTop: 24, padding: "16px 20px", background: gBg, borderRadius: 8, fontSize: 12, color: gInk3, lineHeight: 1.6, display: "flex", gap: 10, alignItems: "flex-start" }}>
            <I name="info" size={14} style={{ color: gBlue, flexShrink: 0, marginTop: 2 }} />
            <div>
              <b style={{ color: gInk }}>How users are counted:</b> Each business user (mailbox) needs their own license. Shared aliases don't count. Pricing shown is exclusive of 18% GST.
              Bought through <b style={{ color: gInk }}>Demo Co · Google Premier Partner</b> — same Google pricing, plus free hands-on migration, dedicated Indian support, and direct escalation to Google engineering.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

window.SCREENS = window.SCREENS || {};
window.SCREENS["buy-workspace-v2"] = BuyWorkspaceV2;
window.GOOGLE_PRICING_TIERS = GOOGLE_PRICING_TIERS;
