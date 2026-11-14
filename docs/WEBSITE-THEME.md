# Website theme — Anutech Digital ("Warm & approachable")

**Live design:** https://claude.ai/artifact/VdGyZjhBXXgV1CnqKFvVv4

This link is the source of truth for the public website's look. It always shows the latest version — no files to download or keep in sync. Open it, click **Play** to try menus, toggles, forms and the light/dark switch, and leave comments on the design for questions.

## Scope — read before touching anything
- **This theme is for the public frontend pages only** — the storefront in `production/src/site`, `production/src/app/(marketing)/` and the ResellerOS product page `production/src/app/(product)/`. Never apply it to the logged-in app (dashboard, leads, quotes, invoices, settings, everything under `production/src/app/(app)/`). The app keeps its own design system.
- **Content never changes; layout and colours are free to change** (owner, 14 Nov 2026: "Only content cannot be changed. Layout and colour combo are free to change."). Keep every heading, sentence, price, link and button label word for word; rearrange, restyle and decorate freely.

## The switch: Classic ↔ Warm
- **Settings → Branding → Website theme**, visible only to the **owner** of the workspace that owns the website (`BUY_PAGE_TENANT_ID`). Classic = the website as before (Anutech blue, Archivo); Warm = this design. Switch back and forth any time; the pages refresh at once.
- Stored in `tenants.website_theme` (`classic` default | `warm`), migration `20261113102122_website_theme_switch`. Until that migration is on a database, the website stays Classic and the card says the update is pending.
- Rules and reading: `production/src/lib/website-theme.ts`, `website-theme.server.ts` (cached read), `api/settings/website-theme` (owner-only switch).

## How Warm is built
- **CSS over the existing pages — no second copy of any page.** `src/site/site-warm.css` (tokens, shared site classes, Home) and one file per page group in `src/site/warm/` (`chrome`, `email`, `company`, `legal-shop`, `domains`, `hosting`, `product`, `switch`). Every selector starts with `.anutech-site[data-site-theme="warm"]` (product page: `.anutech-product[…]`), so Classic is untouched.
- **Pages outside the website's layouts** — Workspace/Support checkouts and thank-you pages, the ad landing pages (`/lp/…`), ResellerOS `/pricing`, `/about`, `/privacy`, `/terms`, `/privacy/request`, `/unsubscribe`, and "page not found" on Anutech's own domains — are wrapped in `WarmScope` (`src/site/components/chrome/WarmScope.tsx`): one `display: contents` wrapper (so Classic lays out exactly as before) carrying the same switch. Their styles are `src/site/warm/extra-*.css`, every selector under `.w-scope[data-site-theme="warm"]`; most re-point the app's colour variables (`--paper`, `--ink`, `--amber`…) to the warm palette on the page's own root element. Designed first as the "Shop & extra pages" artboards in the canvas.
- **Never themed:** pages shared by every reseller — `/quote/[id]/accept`, `/quote/view/[token]`, `/enquiry`, `/project-quote/[id]` — show other resellers' customers; and the logged-in app's own "not found".
- **Guards** (`src/site/site-warm-scope.test.ts`): every selector scoped; nothing hidden except `::before`/`::after` decorations and the theme's own `.w-` controls; every warm file loaded where its pages render; components' `var(--hv-…, <classic>)` colours always keep their Classic fallback.
- **Colours** go through `--w-*` tokens; **dark** redefines them ("Dark variant of the warm tokens") — on the visitor's choice (header switch, `localStorage anutech-theme`, `data-theme` on `<html>`) or, with no choice, the device setting.
- **Photos** from the design are in `public/site/warm/<design id>` and only load on Warm.
- **Brand colours stay their own:** WhatsApp buttons are WhatsApp green (#25D366, dark text for contrast) and WhatsApp text links green, on every page — `src/site/warm/whatsapp.css`, loaded last (owner, 14 Nov 2026). Google's wordmark colours stay too. Placeholder data in the design artboards is not filled in: the theme is design and layout only.
- **Warm-only extras:** the light/dark switch in the header (`ThemeSwitch.tsx`), back-to-top with a progress ring (`BackToTop.tsx`, desktop only — R-230/R-1498 keep phones to one floating launcher).
- **Inline styles:** the server writes `margin-top:10px`, the browser rewrites to `margin-top: 10px` (and hex to `rgb()`) after a client update — a rule matching an inline style must match both spellings.
- **Warm-only additions** (class `w-only`, hidden on Classic by `src/site/warm-only.css`): the design's badges, small labels and icons, the legal pages' "On this page" list (Privacy, Terms), slideshow progress dots, the Domains extension chips (working search buttons). Badges only where the live text says the same thing. Not added: invented figures (ResellerOS "Renewals due / MRR" card), tier names that would mislabel products ("Essentials", "Advanced"), the Customer login page (lives in DMS).

## Pages (19 + 10 extra)
- Homepage: Home
- Product pages: ResellerOS, Business email, Domains, Web hosting, SSL
- Company & pricing: Why us, Support/Contact, Wholesale, Get a quote, All prices, Google Workspace pricing, Compare email editions
- Legal, login & header: Status, Privacy, Terms, Refund, Customer login, Cart, shared site header
- Shop & extra pages: Buy Workspace, Order thank-you, Buy support plan, Ad landing, ResellerOS pricing / about / privacy & terms, Privacy request, Unsubscribe, Page not found

## Tokens
| Role | Light | Dark |
|---|---|---|
| Page background | #F5F7F4 | #232C29 |
| Surface / card | #FFFFFF | #2F3A35 |
| Ink | #17241F | #E9F0EC |
| Muted text | #4B5A53 | #AFC0B8 |
| Primary (teal) | #0E6B5C | #5ED0B3 |
| Accent (marigold) — main CTAs | #F4B740 | #F4B740 |
| Forest — dark panels | #12312A | #24493F |
| Mint | #DCEFE8 | #2F4F46 |
| Border | #E2E7E2 | #45534D |

Fonts: Plus Jakarta Sans (headings 700–800), Inter (body 400–600). Radius: cards 20–24px, buttons 12–14px, pills 999px. Primary CTA marigold with dark text; secondary outlined teal.

## Behaviour to keep
- Theme toggle in header: follows device setting first, remembers choice in localStorage `anutech-theme`, sets `data-theme` on `<html>`.
- Hero slideshows (Home, Hosting, Domains, Email, ResellerOS): crossfade with slow zoom, ~7s per image, dark green tint; first image only with prefers-reduced-motion.
- Header: full nav with dropdowns ≥1340px; drawer below; login moves into drawer under 640px.
- Back-to-top button with scroll-progress ring after ~480px.
- Hover lift on buttons and cards (hover devices only); FAQ answers slide open.
- Mobile (<640px): intros and heroes centred; forms, tables and lists left-aligned.

## Content still to fill from the live site
- FAQ answers marked "[Answer from the live site]".
- Full legal text (Privacy, Terms, Refund are summaries).
- Microsoft 365 and Zoho comparison rows; monthly rates for M365, Zoho, priority support and managed admin (estimated at +20%).
- Customer login sign-in method.
