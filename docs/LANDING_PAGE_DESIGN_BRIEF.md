# ResellerOS — Marketing Landing Page Design Brief

**For: Claude Design (claude.ai with Artifacts)**
**Output expected: A single React HTML artifact with Tailwind styles that I can review, iterate on visually, then port to production.**

Copy everything between the `═══` markers below and paste it into a new Claude conversation. Ask Claude to "build this as a single HTML/React artifact I can preview."

---

═══════════════════════════════════════════════════════════

# Brief — design a marketing landing page for "ResellerOS"

I run a multi-tenant SaaS called **ResellerOS** — an operating system for Indian cloud resellers (people who resell Google Workspace, Microsoft 365, and Zoho to other businesses). I'm the first customer (Client A Pvt Ltd, Mumbai). Now I'm targeting other resellers.

My current landing page is text-heavy and doesn't communicate the product's depth visually. **I want you to design a substantially better, more visual landing page.** Output as a single React HTML artifact with Tailwind CSS so I can preview it.

## 1. Audience

- **Primary**: Indian cloud-reseller business owners (35-55 yrs old, B2B SaaS, ₹1-50cr annual revenue, run their company across 5-7 disconnected tools today)
- **Mindset**: Skeptical of "AI-powered all-in-one" buzzwords. Wants to see specific, India-aware capabilities (GST, GSTIN, IFSC, HSN, ₹).
- **Mobile usage**: High — they check vendor sites from phones. Mobile layout matters as much as desktop.

## 2. Brand identity — must match these tokens exactly

This is critical. The product UI already uses these. The landing should feel like the same product, not a generic SaaS template.

**Colors** (use Tailwind arbitrary values or extend config):
- Paper / background: `#FAFAF9` (warm off-white, not pure white)
- Paper-2 / subtle: `#F5F5F4`
- Ink / primary text: `#1C1917`
- Ink-2 / body: `#44403C`
- Ink-3 / muted: `#A8A29E`
- Hairline / border: `#E7E5E4`
- Amber / accent: `#C2410C` (Tailwind amber-700-ish, used for primary CTAs)
- Amber-soft: `#FED7AA` (pale orange used for icon tiles, info blocks)
- Amber-ink: `#7C2D12` (dark amber for text on amber-soft)
- Success / emerald: `#059669`
- Danger / rose: `#E11D48`
- Info / indigo: `#4F46E5`

**Typography**:
- Serif headlines: `"DM Serif Display"` — used for h1, h2, KPI numbers. Editorial feel.
- Sans body: `"Plus Jakarta Sans"` — clean, modern, slightly geometric.
- Mono: `"JetBrains Mono"` — used sparingly for trust signals, KPI labels, ref codes.

Load all 3 from Google Fonts.

**Voice/tone**:
- Editorial, restrained, confident — NOT loud SaaS startup
- Honest specifics over hype ("CGST §31 compliant" > "Powerful AI-driven invoicing")
- No emoji except 🇮🇳 (Mumbai flag in trust ribbon)
- No exclamation marks
- Indian English (lakh/crore formatting, ₹ symbol, +91 phone format)

## 3. Page structure — 9 sections, in order

### Section 1 — Top navigation
Sticky header. Left: "ResellerOS" wordmark in DM Serif Display. Right: "About" / "Sign in" / "Start free" (amber primary button). Border-bottom hairline.

### Section 2 — Hero
- Eyebrow badge (indigo dot + text): "For Indian cloud resellers"
- Headline (DM Serif, 5xl on desktop): **"One OS for your reseller business."** Followed by a softer second line in `text-ink-3`: **"No more juggling seven tools."**
- Subhead (text-lg): "ResellerOS handles leads, quotes, GST invoices, renewals, banking, and customer portal — purpose-built for Google Workspace, Microsoft 365, and Zoho resellers in India."
- Dual CTA: amber primary "Start free trial →" + ghost outline "Sign in"
- Microcopy: "14-day trial · No credit card · ₹0 to get started"
- **VISUAL: This is where the current page is weak. ADD A PRODUCT MOCKUP.** Show a stylized browser frame containing the dashboard — sidebar on the left (with section labels like "Leads / Quotes / Invoices / Renewals / Banking"), top bar with breadcrumb, main area showing a KPI strip ("MRR ₹69.4K" / "Pipeline ₹96.3K" / "Customers 4") and a quote table with rows like "Q-2026-27-0005 · Manoj · ₹2.4L · Sent". Use light shadows + the design tokens above. Make it look like a real product, not Lorem Ipsum.

### Section 3 — Trust ribbon
Thin horizontal band with `bg-paper-2`. Single line of small mono-font text, separated by dots:
"Built in Mumbai 🇮🇳 · GST + HSN 998313 compliant · DPDP Act 2023 ready · Hosted on Google Cloud Mumbai"

### Section 4 — Pain section (the "before" state)
Centered amber-warning badge: "If this sounds familiar"
H2: **"You're running a reseller business across seven apps."**
4 cards in a 2×2 grid (md+) / stacked (mobile). Each card has a rose × icon on the left and the pain bullet on the right:
- "Spreadsheet for leads. WhatsApp for follow-ups. Memory for what was said."
- "Tally / Zoho Books for invoices. Re-typing customer details every quote."
- "Bank reconciliation on paper. Renewal reminders that get missed."
- "GST filings that become a quarterly crisis. Margins that stay fuzzy."

### Section 5 — Module showcase (the "after" state)
**VISUAL: Show actual product screenshots or polished mockups for 3-4 key modules.** This is the second biggest visual upgrade after the hero.

Background: `bg-paper-2/40` with top + bottom hairline borders.
Centered emerald badge: "What's inside"
H2: **"17 modules. One database. Built to talk to each other."**
Subhead: "Every module shares context — a lead becomes a quote becomes an invoice becomes a subscription becomes a renewal, with zero re-typing."

Then alternating left-right rows (image + text → text + image → image + text):
1. **Lead → Deal pipeline** with a Kanban screenshot mockup (4 columns: New / Contacted / Quote Sent / Won, with sample deal cards showing company names + ₹ values)
2. **GST-compliant quote builder** with a quote builder mockup (line items table, totals breakdown showing CGST + SGST split, "Send via email" button)
3. **Renewal automation** with a timeline/calendar mockup (T-30 / T-15 / T-7 / T-0 cadence visualised, auto-reminders shown)
4. **Banking + reconcile** with a transactions table mockup + match suggestion pill

Below the 4 detailed rows, add a compact grid (3 cols × 4 rows) of the remaining 8 modules as small cards with amber-soft icon tiles + 1-line descriptions:
- Online orders + Razorpay
- Accounting layer (P&L, MRR/ARR)
- TDS receivable
- Customer portal
- WhatsApp + email
- Procurement (PO matching)
- Partner channel (distributor → reseller)
- GSTIN verification

### Section 6 — Why pick us
H2: **"Why pick ResellerOS over a generic CRM"**
3-column grid of cards on desktop, stacked on mobile. Each card has a serif title + body copy:
1. **"Built by a reseller"** — "12+ years running Client A — a Mumbai-based GW/M365/Zoho reseller. Every workflow comes from real operational pain, not feature-list bingo."
2. **"GST-first by design"** — "HSN 998313, CGST §31 invoice numbering, intra/inter-state tax split, advance receipts — built into the schema, not bolted on as plugins."
3. **"No drift from Client A"** — "Client A is our first customer. If a feature doesn't work for us in production, it doesn't ship. Zero theoretical features."

**Add a small visual treatment to each card** — e.g., a numeric icon, or a relevant lucide-react icon in amber-soft tile.

### Section 7 — Founder section (NEW — currently missing)
Replace stock "team photos" with an honest founder card.
- Section background: `bg-paper`, two-column layout.
- Left: Big serif quote treatment — "I built the OS I wished I'd had on day one." in DM Serif Display, ~3xl. Below the quote: "Pardeep A · Founder" in sans + "Client A Pvt Ltd · Mumbai" in mono.
- Right: A simple founder card — circular avatar with initials "PA" on amber-soft background, bio paragraph (~50 words): "12+ years running Client A. Built ResellerOS from the real constraints of operating his own business — payments missed, renewals slipped, GST filings done at the eleventh hour. Now sharing the tool with other resellers."
- CTA below: "Read the full story →" linking to /about

### Section 8 — Beta pricing
Background: `bg-amber-soft/20` (very pale amber), full-width band, centered text.
Amber badge: "Beta pricing"
H2: **"Free during beta."**
Body: "We're onboarding the first 10 paying resellers personally. Starter / Growth / Pro tiers launch once we hit ₹15K MRR."
Mono microcopy: "All features included · No seat limits · You decide when to start paying"

### Section 9 — Final CTA + Footer
H2: **"Ready to leave the seven-tool circus?"**
Body: "Create your tenant, import your existing customers via CSV, and run your first GST-compliant invoice in under 10 minutes."
Dual CTA (lg size): amber primary "Start free trial →" + outline "Read the founder story"

Footer (hairline-bordered):
Left: "ResellerOS · Client A Pvt Ltd · Mumbai · Made in India" in mono-12.
Right: Nav links to About, Privacy, Terms, Contact (`mailto:hello@resellersos.in`)

## 4. Visual direction

**This is what makes-or-breaks the design:**

- **Product mockups, not stock photos.** Use stylized browser frames containing realistic-looking product screenshots. Show actual Indian data: ₹ amounts (e.g., ₹69,400 MRR, ₹2.4L pipeline), Indian company names (Client A, Manoj's Co, etc.), Mumbai timezone dates.
- **No generic SaaS gradients.** The brand is editorial + restrained. Use subtle textures, hairline borders, paper-2 backgrounds — not vibrant rainbow gradients.
- **Use CSS-only illustrations** where appropriate. SVG line icons (lucide-react style), simple geometric shapes, no external images needed.
- **Restrained motion.** No parallax. No big scroll animations. Maybe subtle on-scroll fade-ins for cards, that's it.
- **High whitespace, editorial layout.** Long max-widths (max-w-6xl page, max-w-2xl for centered paragraphs).
- **Use serif headlines liberally.** This is a key brand signal vs. generic Inter-everywhere SaaS pages.

## 5. References (study these aesthetics)

- **linear.app** — editorial typography, restrained colors, product mockups in hero
- **resend.com** — clean, single-product focus, real screenshots
- **vercel.com** — bold serif headlines, ample whitespace
- **notion.so** — section pacing, alternating layout for feature showcase
- **avoid**: Mailchimp-style cartoon illustrations, Hubspot-style "marketing brochure" feel

## 6. Output requirements

- Single React component, default export, no external dependencies beyond Tailwind + lucide-react
- All sections in one file, no images (use SVG/CSS only)
- Fully responsive (mobile-first, breakpoint at md: 768px and lg: 1024px)
- Server-component-friendly (no useState/useEffect in the page — interactivity okay only via Tailwind hover/focus)
- Tailwind classes inline, no separate CSS file
- Working CTAs (use # placeholders for /signup, /login, /about, /privacy, /terms, /buy/workspace)
- Comments explaining each section so I can later port section-by-section to my codebase

## 7. What I'll do with the output

I'll preview your artifact, iterate with you on what to tweak, then I'll have my coding agent port it into my Next.js 14 App Router production codebase (replacing `src/app/page.tsx`). I'll do the porting — you focus on the design.

═══════════════════════════════════════════════════════════

---

## How to use this brief

1. Open **claude.ai** (or any Claude chat with Artifacts enabled)
2. Start a new conversation
3. Paste everything between the `═══` markers above (one chunk, ~600 lines)
4. Add at the end: "Build this as a single React artifact I can preview."
5. Claude will generate an HTML mockup in the right sidebar
6. Iterate: ask for changes ("make the hero mockup more detailed", "change the founder section to a horizontal layout", etc.)
7. Once happy, paste the final artifact code back to me and I'll port it into production

## What I changed in the brief vs. current page

- **Added: product mockups in hero + module showcase** — biggest visual upgrade
- **Added: founder section** — currently missing; adds trust
- **Reorganised: module section** — alternating image-text rows (4 detailed) + compact grid (8 small) instead of flat 12-item grid
- **Kept: copy, voice, design tokens, section order** — these are working

## Maintenance

This file lives at `docs/LANDING_PAGE_DESIGN_BRIEF.md` in the repo. If you ever need to redesign again, refine this brief instead of starting from scratch.
