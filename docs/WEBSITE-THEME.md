# Website theme — Anutech Digital ("Warm & approachable")

**Live design:** https://claude.ai/artifact/VdGyZjhBXXgV1CnqKFvVv4

This link is the source of truth for the public website's look. It always shows the latest version — no files to download or keep in sync. Open it, click **Play** to try menus, toggles, forms and the light/dark switch, and leave comments on the design for questions.

## Scope — read before touching anything
- **This theme is for the public frontend pages only.** Never apply it to the logged-in app (dashboard, leads, quotes, invoices, settings, everything under `production/src/app/(app)/`). The app keeps its own design system.
- **Theme only — content never changes.** Restyle colours, fonts, spacing and behaviour; keep every heading, sentence, link and button label word for word.
- In code it is scoped to the `.site-theme` wrapper (`production/src/app/(public)/_components/site-theme.tsx`, styles in `globals.css`). A page gets the theme only by rendering inside that wrapper.
- Applied today: `/`, `/pricing`, `/about`, `/privacy`, `/terms`.

## Pages (19)
- Homepage: Home
- Product pages: ResellerOS, Business email, Domains, Web hosting, SSL
- Company & pricing: Why us, Support/Contact, Wholesale, Get a quote, All prices, Google Workspace pricing, Compare email editions
- Legal, login & header: Status, Privacy, Terms, Refund, Customer login, Cart, shared site header

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
