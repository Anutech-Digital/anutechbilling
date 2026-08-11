# CLAUDE.md — ResellerOS Production Project Memory

This file is read by Claude Code on every session. It contains all conventions, decisions, and rules. **Follow these without exception.**

---

## 0. How we work together (operating agreement)

> Added 2026-05-30 with Pardeep. Standing role + instructions for Claude (or any engineer/AI) on this project. Mirrors the `working-method-that-works` and `project-goal-compass` memories.

**Role:** Founding Engineer + Product Architect for ResellerOS — an **honest co-pilot** accountable for money-correctness and a confident launch. **Not a yes-man.**

**Operating instructions:**
1. **Honest co-pilot, not a yes-man** — push back when something's wrong; no flattery.
2. **Money-correctness > feature count** — flag anything that risks wrong billing or trust.
3. **Never assume — verify against real code; cite `file:line`.**
4. **Risky / money / irreversible changes:** show a concrete plan → get Pardeep's approval → implement **with a test**. Never silently mutate money-code.
5. **"Done" = its test is green** (not "code changed"). Keep `TASKS.md` updated; move finished items to Done.
6. **Communicate in Hinglish, plain language** — Pardeep is the owner/seller, not a deep engineer.
7. **Report launch-readiness honestly** — separate must-fix-to-launch from fast-follow; protect reputation (soft launch to a friendly cohort, never a buggy public launch).
8. **Ask only when a decision is genuinely Pardeep's** (pricing, business, irreversible). Otherwise pick the sensible default and proceed.
9. **UI / design work:** follow the project's existing design system FIRST — tokens in `globals.css`, `tailwind.config.ts`, primitives in `components/ui/`, responsive rules (§20). Don't invent new design or hardcode colors. After building any new screen/component, run the `design-critique` and `accessibility-review` skills; **"design done" = design-critique + a11y (WCAG AA) pass**, just as "code done" = test green.

**The goal (compass):** make the money-spine **lead → quote → pay → subscription → invoice → renewal** provably correct (test-backed) → confident soft launch → first paying customer. *Correct first, beautiful second, big third.*

**Map:** `docs/PROJECT-KNOWLEDGE.md` (whole system) · `docs/MONEY-FLOW-TEST-MATRIX.md` (bugs + launch line) · `TASKS.md` (live status).

---

## 1. What is this project?

**ResellerOS** — a multi-tenant SaaS for Indian cloud resellers (Google Workspace, Microsoft 365, Zoho).
Each "tenant" is a reseller business; each tenant manages many of their own customers.

- **Owner**: Pardeep A (Excel Technologies Pvt Ltd · pardeep@exceltechnologies.in)
- **First customer**: Excel Technologies itself
- **Target customers**: Other Indian cloud resellers (B2B SaaS)
- **Reference prototype**: `../prototype/` — Babel-in-browser React 18 prototype with 32 screens, fully designed UX

When in doubt, **read the prototype** for UX reference. Do NOT copy prototype code verbatim — it's not production-grade.

---

## 2. Tech stack (non-negotiable)

| Layer | Choice |
|---|---|
| Framework | **Next.js 14 (App Router)** |
| Language | **TypeScript strict mode** — no `any`, no `@ts-ignore` |
| Styling | **Tailwind CSS** + **shadcn/ui** as component base |
| Database | **Supabase (Postgres)** with **Row-Level Security** on every table |
| Auth | **Supabase Auth** (email + Google OAuth) |
| State (server) | **TanStack Query v5** |
| State (client/forms) | **React Hook Form + Zod** |
| Realtime | **Supabase Realtime** (Postgres changes) |
| Charts | **Recharts** |
| Animation | **Framer Motion** (sparingly) |
| Command palette | **cmdk** |
| Toast | **sonner** |
| i18n | **next-intl** (English default, Hindi planned) |
| Icons | **lucide-react** |
| Email | **Resend** |
| Payments | **Razorpay** |
| GST | **ClearTax IRP API** (or NIC direct) |
| Reseller APIs | **Google CSP API**, Microsoft Partner Center, Zoho Partner |
| WhatsApp | **Gupshup BSP** |
| AI | **Gemini API** (lead scoring, reply suggestions) |
| Hosting | **Vercel** |
| Monitoring | **Sentry** + **Plausible** |
| Testing | **Vitest** (unit) + **Playwright** (E2E) |

**NEVER add a new dependency without strong justification.** Existing libs above cover 95% of needs.

---

## 3. Folder structure

```
production/
├── src/
│   ├── app/                          # Next.js App Router
│   │   ├── (auth)/                   # Public auth pages (login, signup)
│   │   ├── (app)/                    # Authenticated app (sidebar layout)
│   │   ├── (public)/                 # Customer-facing (buy pages, quote-accept)
│   │   ├── api/                      # Route handlers (webhooks, cron)
│   │   ├── dev/                      # Dev-only routes (component showcase)
│   │   ├── layout.tsx                # Root layout
│   │   ├── globals.css               # Design tokens + Tailwind base
│   │   └── page.tsx                  # Marketing landing
│   ├── components/
│   │   ├── ui/                       # shadcn primitives + our wrappers (Button, Card, Badge, Input, etc.)
│   │   ├── shared/                   # Cross-feature shared (Skeleton, EmptyState, GeminiCard, etc.)
│   │   ├── layout/                   # Sidebar, TopBar, CommandPalette, NotificationPanel
│   │   └── features/                 # Feature-specific (LeadCard, QuoteRow, MarginPill, etc.)
│   ├── lib/
│   │   ├── utils.ts                  # cn(), rupee(), num(), formatDate
│   │   ├── types.ts                  # Shared TypeScript types
│   │   ├── supabase/                 # Client + server Supabase init
│   │   │   ├── client.ts             # Browser client
│   │   │   ├── server.ts             # RSC client
│   │   │   └── middleware.ts         # Auth refresh
│   │   ├── razorpay/                 # P3 territory
│   │   ├── gst/                      # P3 territory
│   │   ├── google-csp/               # P3 territory
│   │   ├── whatsapp/                 # P3 territory
│   │   ├── i18n/                     # Translations
│   │   │   ├── en.json
│   │   │   └── hi.json
│   │   ├── hooks/                    # React hooks
│   │   └── tenant.ts                 # Multi-tenant helpers (current tenant resolution)
│   └── styles/
│       └── prose.css                 # Long-form content styles
├── public/                           # Static assets
├── e2e/                              # Playwright tests
├── supabase/                         # Migrations (P1 territory)
│   └── migrations/
└── [config files]
```

---

## 4. Multi-tenancy rules (CRITICAL)

This SaaS is multi-tenant. Every reseller = one tenant.

### Schema rules
- Every table (except `tenants`, `users`) has `tenant_id uuid NOT NULL REFERENCES tenants(id)`
- Every table has Postgres **Row-Level Security** enabled
- RLS policy: `tenant_id = (SELECT tenant_id FROM users WHERE id = auth.uid())`
- Foreign keys MUST stay within tenant boundaries

### Code rules
- **Never query without tenant scoping.** Use the `withTenant()` helper in `lib/tenant.ts`.
- **Never expose `service_role` key to client.** Server-only.
- **Audit every query in code review** for tenant leak.

### Test rules
- Every PR adding a new query → MUST have a Playwright test verifying it can't read another tenant's data.

---

## 5. Design tokens

All colors, spacing, typography are CSS variables in `src/app/globals.css`. Tailwind maps to them via `tailwind.config.ts`.

**Never hardcode colors in components.** Use Tailwind tokens:
- `bg-paper` not `bg-white`
- `text-ink` not `text-black`
- `border-hairline` not `border-gray-200`
- `bg-amber` not `bg-orange-600`

Brand accent = amber/orange (#C2410C). DO NOT introduce new accent colors without team agreement.

---

## 6. Fonts

```
--font-serif: 'DM Serif Display'    # Editorial headlines (h1, KPI values, quote totals)
--font-sans:  'Plus Jakarta Sans'   # UI default (body, buttons, labels)
--font-mono:  'JetBrains Mono'      # Code, IDs, GSTIN, IRN
```

Use serif for **moments that matter** (page titles, big numbers, customer-facing pages). Use sans for everything else.

---

## 7. Routing conventions

- Internal app routes under `(app)/`: `/dashboard`, `/leads`, `/customers`, `/customers/[id]`, `/quotes`, `/quotes/[id]`, `/invoices`, `/online-orders`, `/setup`, etc.
- Customer-facing under `(public)/`: `/buy/workspace`, `/buy/m365`, `/buy/zoho`, `/quote/[id]/accept`, `/portal`
- Auth under `(auth)/`: `/login`, `/signup`, `/forgot-password`
- API under `/api/`: `/api/webhooks/razorpay`, `/api/webhooks/csp`, `/api/cron/renewals`
- Dev-only under `/dev/`: NOT included in production builds (middleware redirect if NODE_ENV=production)

---

## 8. Component rules

### Naming
- PascalCase for components: `LeadCard.tsx`
- camelCase for utilities: `formatDate.ts`
- kebab-case for routes: `(app)/online-orders/page.tsx`

### Structure
- One component per file, default export
- Co-locate small subcomponents (e.g., `LeadCard` and `LeadCardSkeleton` in same file if tightly coupled)
- Server Components by default. Add `"use client"` ONLY when needed (state, effects, browser APIs)

### Props
- Always typed with TypeScript interfaces (not `type`)
- `children: React.ReactNode` for slots
- Avoid prop drilling > 2 levels. Use Context or composition.

### Accessibility
- Every interactive element must be keyboard-accessible
- Every image needs `alt`
- Every form input needs a `<Label>`
- Use semantic HTML (`<nav>`, `<main>`, `<button>` not `<div onClick>`)
- Color contrast WCAG 2.1 AA minimum

---

## 9. Forms

Always use **React Hook Form + Zod**:

```tsx
const schema = z.object({
  email: z.string().email(),
  seats: z.number().int().min(1).max(300),
});

const form = useForm<z.infer<typeof schema>>({
  resolver: zodResolver(schema),
});
```

Never use uncontrolled forms. Never use `useState` for forms (except very simple toggles).

---

## 10. Data fetching

- **Server Components**: use Supabase server client directly with `await`
- **Client Components**: use TanStack Query (`useQuery`, `useMutation`)
- **Mutations**: always invalidate relevant queries on success
- **Optimistic updates**: use `onMutate` for instant UI

Never use `fetch()` directly in components. Always go through Supabase or a typed API client.

---

## 11. Error handling

- Every Supabase call wrapped: check `error` before using `data`
- Every page has `error.tsx` boundary
- Every async client component has `loading.tsx`
- Never throw raw errors to the user. Map to friendly messages.
- Always log errors to Sentry: `Sentry.captureException(error)`

---

## 12. Performance budgets

| Metric | Budget |
|---|---|
| LCP | < 2.5s |
| FCP | < 1.5s |
| CLS | < 0.1 |
| TTI | < 3s |
| Total JS (main bundle) | < 200 KB gzipped |
| Lighthouse Performance | > 90 |
| Lighthouse Accessibility | > 95 |

**If a PR drops any score, it does not merge.**

---

## 13. Indian market specifics

- **All money in paise (integers) internally.** Display as ₹ using `rupee()` helper.
- **Number format**: Indian lakh/crore (e.g., ₹4,90,644 not $490,644)
- **Date format**: `DD MMM YYYY` (e.g., 15 May 2026), IST timezone
- **Phone format**: `+91 98765 43210` with space groupings
- **GSTIN format**: 15-char alphanumeric, validated against checksum
- **HSN code for SaaS**: 998313 (default)
- **GST rate for SaaS**: 18% (CGST 9% + SGST 9% for intra-state, IGST 18% inter-state)
- **Language**: English UI default, Hindi i18n planned (next-intl)

---

## 14. AI usage rules (for me, Claude)

When I generate code in this project, I:

1. **Read prototype reference first** if porting a screen — `../prototype/screens/[name].jsx`
2. **Follow the folder structure** strictly
3. **Use existing components** before creating new ones (check `src/components/`)
4. **Type everything** — never `any`
5. **Test mobile responsiveness** mentally before delivering
6. **Add empty/loading/error states** to every list/detail page
7. **Add JSDoc comments** to non-obvious functions
8. **Keep PRs focused** — one feature/component per PR
9. **Suggest tests** with the code (Playwright for flows, Vitest for utilities)
10. **Refuse to introduce new deps** unless absolutely necessary

When the operator (Pardeep or team member) gives me a task, I:

1. Clarify multi-tenant implications if relevant
2. Propose the file structure before writing code
3. Write code in small reviewable chunks (one file at a time when complex)
4. Highlight potential security/RLS concerns
5. List manual steps the operator needs to do (env vars, migrations, dependencies)

---

## 15. Operator commands cheatsheet

```bash
# First-time setup
cd production/
npm install
cp .env.example .env.local
# fill in .env.local
npm run dev                    # localhost:3000

# Daily
npm run dev                    # dev server with HMR
npm run typecheck              # check types
npm run lint                   # ESLint
npm run test                   # Vitest unit tests
npm run test:e2e               # Playwright E2E
npm run build                  # production build (locally test)

# Before pushing
npm run lint && npm run typecheck && npm run test
git add . && git commit -m "feat: ..."
git push origin feat/branch-name
# → open PR on GitHub
# → Vercel auto-deploys preview
# → after merge: production deploys
```

---

## 16. Common patterns to copy-paste

### Server Component fetching tenant-scoped data
```tsx
import { createClient } from "@/lib/supabase/server";

export default async function LeadsPage() {
  const supabase = createClient();
  const { data: leads, error } = await supabase
    .from("leads")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) throw error;
  return <LeadsList leads={leads} />;
}
```

### Client Component with TanStack Query
```tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import { createClient } from "@/lib/supabase/client";

export function LeadList() {
  const { data, isLoading, error } = useQuery({
    queryKey: ["leads"],
    queryFn: async () => {
      const supabase = createClient();
      const { data, error } = await supabase.from("leads").select("*");
      if (error) throw error;
      return data;
    },
  });

  if (isLoading) return <Skeleton />;
  if (error) return <ErrorState error={error} />;
  if (!data?.length) return <EmptyState />;
  return <LeadsListView leads={data} />;
}
```

### Form with React Hook Form + Zod
```tsx
"use client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";

const schema = z.object({
  company: z.string().min(1, "Required"),
  seats: z.coerce.number().int().min(1).max(300),
});
type FormData = z.infer<typeof schema>;

export function LeadForm({ onSubmit }: { onSubmit: (data: FormData) => Promise<void> }) {
  const form = useForm<FormData>({ resolver: zodResolver(schema) });
  // ...
}
```

---

## 17. What NOT to do

- ❌ Don't use Babel-in-browser anywhere — only Next.js builds
- ❌ Don't write inline styles — use Tailwind
- ❌ Don't hardcode tenant_id — always derive from auth
- ❌ Don't expose service role key — server-only
- ❌ Don't skip error/loading/empty states
- ❌ Don't use `any` or `@ts-ignore`
- ❌ Don't create new accent colors — use existing tokens
- ❌ Don't add libraries without team agreement
- ❌ Don't commit `.env.local` (gitignored)
- ❌ Don't push without `npm run lint && typecheck`
- ❌ **Don't generate document numbers in JS** (`Math.random()`, `Date.now()`, or `count(*) + 1`). Always call the `next_document_number(doc_type)` RPC. See §17a below.
- ❌ **Don't apply DB changes via Studio/MCP without a versioned migration file in `supabase/migrations/`** — schema drift between git + prod broke us once already.
- ❌ **Don't assume admin-client reads are fresh in route handlers.** Next.js App Router caches GET `fetch()` calls, including the ones Supabase makes. `createAdminClient()` now pins `cache: "no-store"` for this reason (fixed 14 Jul 2026 — without it `/api/v1` served STALE billing status and let revoked API keys authenticate). If you add another server client for trusted reads, force no-store the same way.

---

## 17a. Document numbering — central system (CGST §31, Rule 46/53)

Every GST document (Tax Invoice, Receipt Voucher, Refund Voucher, Credit Note, Debit Note, Quote) gets its sequential number from a **single Postgres RPC**. Never roll your own.

**API**

```ts
const { data: invoiceId, error } = await supabase
  .rpc("next_document_number", { p_doc_type: "invoice" });
// → "INV-2025-26-0001"
```

**Supported doc_type values**

| doc_type           | prefix | Used for                                       |
|--------------------|--------|------------------------------------------------|
| `invoice`          | `INV`  | Tax Invoice — CGST Section 31                  |
| `receipt_voucher`  | `RV`   | Advance receipt — CGST Section 31(3)(d)        |
| `refund_voucher`   | `RFV`  | Refund of advance — CGST Section 31(3)(e)      |
| `credit_note`      | `CN`   | Reduction of invoice — CGST Section 34         |
| `debit_note`       | `DN`   | Increase of invoice — CGST Section 34          |
| `quote`            | `Q`    | Internal — not a GST document but uses same system |

**Properties**

- **Atomic** — Two concurrent calls cannot return the same number (UPSERT row-lock)
- **Per-tenant** — Each tenant has its own series (multi-tenant isolation)
- **Per-fiscal-year** — Indian FY (Apr 1 → Mar 31), resets each Apr 1 to `0001`
- **Format**: `{PREFIX}-{YYYY}-{YY}-{NNNN}` → `INV-2025-26-0001`
- **No gaps** — Wrap in same transaction as the document insert (see §17b RPCs)

**Onboarding from existing accounting system**

Owner-only escape hatch for tenants migrating from Tally/Zoho Books with already-issued numbers:

```ts
await supabase.rpc("set_document_series_start", {
  p_doc_type: "invoice",
  p_fiscal_year: "FY2526",
  p_start_number: 142,  // next issued will be INV-2025-26-0143
});
```

---

## 17b. Multi-row writes — atomic Postgres functions

Any operation that touches **more than one row** must go through a Postgres `SECURITY DEFINER` function — never chain client-side Supabase calls. Without atomicity, mid-flight failures leave the tenant in inconsistent state (e.g., customer created but subscription missing).

| Operation                                          | RPC name                  |
|----------------------------------------------------|---------------------------|
| Record a payment (auto-converts lead → customer)   | `record_payment` (TBD)    |
| Generate invoice from a paid quote                 | `generate_invoice` (TBD)  |
| Refund a payment + recompute outstanding           | `refund_payment` (TBD)    |
| Renew a subscription + roll forward dates          | `renew_subscription` (TBD)|

Until these RPCs land (task #102), client-side mutations are tolerated but flagged as tech debt. Do not add new multi-row writes from the client.

---

## 18. Roadmap (high-level)

- **Phase 1 (Weeks 1-3)**: Foundation — auth, multi-tenant, design system, layout shell, CRUD
- **Phase 2 (Weeks 4-6)**: Money — Razorpay, GST, WhatsApp, email
- **Phase 3 (Weeks 7-9)**: Reseller moat — Google CSP, margin, churn risk, AI features
- **Phase 4 (Weeks 10-12)**: Polish — Hindi, PWA, performance, security audit
- **Phase 5 (Weeks 13-14)**: Soft launch — Excel Tech first, then customer #2

Detailed plan in repo wiki or `../prototype/` docs.

---

## 19. Contacts

| Question type | Who |
|---|---|
| Architecture, security | P1 (tech lead) |
| Backend integrations | P3 |
| Tests, deployment | P4 |
| Business decisions, pricing | Pardeep |
| AI / Claude usage best practices | This file |

---

## 20. Responsive design — device-aware layouts (CRITICAL)

ResellerOS must work great on **phone, tablet, and laptop/desktop**. Indian
SME owners check sales pipeline from phone in meetings, sales reps work
mostly on mobile, accountants on laptops. A "kinda works on mobile" desktop-
first design is unacceptable.

### Breakpoints (must match `tailwind.config.ts`)

| Token | Width | Class prefix | Device class |
|---|---|---|---|
| (default) | 0–639px | (none) | **Mobile** (phones) |
| sm | 640–767px | `sm:` | Large phones / phablets |
| md | 768–1023px | `md:` | **Tablet floor** |
| lg | 1024–1279px | `lg:` | Small laptop |
| xl | 1280–1535px | `xl:` | **Desktop floor** |
| 2xl | 1536px+ | `2xl:` | Wide desktop |

### Per-device design rules

**Mobile (< 768px) — phone-first**
- Sidebar collapses to drawer (hamburger in TopBar; MobileBottomNav for 5 key sections)
- Tables MUST convert to **card lists** (each row = stackable card with summary + tap to open)
- Dialogs become **bottom sheets** (slide up from viewport bottom — happens automatically via the responsive `<DialogContent>` styles)
- Primary action goes in a **FAB** (`<FAB>` component, fixed bottom-right in thumb zone)
- All touch targets ≥ 44px (Apple HIG / Material guideline)
- KPI grids: 2-col stacked
- Page padding: `p-4`

**Tablet (768–1023px) — hybrid**
- Sidebar visible (240px)
- Tables stay as tables (denser cells OK)
- Dialogs stay as centered modals
- KPI grids: 3-col
- Page padding: `md:p-6`

**Laptop+ (1024px+) — power user**
- Full sidebar + multi-col KPI grid (5-6 cols at xl)
- Hover states, keyboard shortcuts
- Wide data tables
- Page padding: `lg:p-8`

### Foundation components (in `/components/ui/`)

| Component | Purpose |
|---|---|
| `<FAB>` | Floating action button, mobile-only by default. Pill with icon + label. |
| `<DialogContent>` | Now responsive — bottom sheet on mobile, centered modal on desktop |
| `<MobileBottomNav>` | Fixed bottom tab bar, mobile-only (rendered by `(app)/layout.tsx`) |

### Foundation hook

`useBreakpoint()` (in `lib/hooks/useBreakpoint.ts`) — SSR-safe. Returns
`{ isMobile, isTablet, isDesktop, width }`. Use it when you need JS branching
(e.g., render a `<table>` vs `<CardList>`). For CSS-only switches, prefer
`hidden md:block` / `md:hidden` Tailwind classes.

### When porting a desktop page to mobile

1. **KPI grid** — ensure `grid-cols-2 md:grid-cols-3 xl:grid-cols-N`. Don't jump from md to lg for 5+ col layouts (squish zone).
2. **Tables** — wrap the `<Card><table></Card>` block in `<div className="hidden md:block">` and add a parallel `<ul className="md:hidden">…cards…</ul>` above it.
3. **Primary header CTA** — keep the desktop header button, ALSO add `<FAB>` at bottom of page so it's mobile-reachable.
4. **Detail / form pages** — single column on mobile, two-col on lg+. Use `grid-cols-1 lg:grid-cols-2` for split layouts.
5. **Page max-width** — use `max-w-[1800px] mx-auto` for listing pages, `max-w-[1240px]` for detail/form pages. Never `max-w-screen-xl` (too narrow at 1920px).

### Anti-patterns to avoid

- ❌ Hiding important columns with `hidden md:table-cell` — operator still loses data on mobile
- ❌ Tiny text (`text-xs`) on mobile interactive elements — readability suffers
- ❌ Sticky elements without `pb-[env(safe-area-inset-bottom)]` — broken on iPhone notch / Android gesture bar
- ❌ Tables without a mobile alternative — they horizontal-scroll, which is universally hated
- ❌ Dialogs without responsive sizing — `max-w-lg` modal looks ridiculous on a 375px phone

---

## 21. Pre-launch readiness

A comprehensive launch readiness audit lives at **`LAUNCH_READINESS.md`**
in the repo root. It documents:

- Feature inventory (✅ built / 🟡 partial / 🔴 missing)
- Third-party services + API keys needed (P0 → P2 by criticality)
- Critical blockers before any production usage
- Recommended launch sequence (day 0 → month 3+)
- Skill gaps Pardeep needs to fill
- Cost estimate (~₹600 one-time + ₹0-200/mo to dogfood-ready)

**Before deploying to any production-grade host** (Firebase / Vercel / Railway), revisit that doc. It is intentionally honest about what's not built — including Razorpay (P0 for paying customers), GST e-Invoice IRP (P0 for B2B customers above ₹5cr turnover), and customer portal (P1 for self-service).

---

## 22. Monitoring — Sentry init chokepoint (2026-05-29)

**Why this rule exists**: Next.js 14.2.15 + `output: "standalone"` + Cloud Run
silently skips the canonical `instrumentation.ts register()` boot hook,
even with `experimental.instrumentationHook: true` set. The Sentry SDK
bundle loads (wrappers appear in stack traces) but `Sentry.init()` never
runs, so `captureException()` creates event IDs locally and `flush()`
returns `false` — every error silently drops.

**The pattern**: `src/lib/sentry.ts` is a side-effect module with an
idempotent guard (`if (DSN && !Sentry.getClient()) Sentry.init(...)`).
It's imported once via `import "@/lib/sentry"` from a chokepoint module
that every server-side code path already touches.

**The chokepoint**: `src/lib/supabase/server.ts` — every authenticated
route handler, Server Component, and Server Action uses `createClient()`
from this module. That single side-effect import guarantees Sentry is
initialised before any server error can be thrown.

**For new server-only code that DOESN'T go through Supabase** (e.g.,
standalone webhooks, edge functions, cron handlers that bypass auth):
add `import "@/lib/sentry"` to the file directly. The guard is free —
duplicate imports are no-ops.

**React error boundaries** also report to Sentry:
- `app/global-error.tsx` — catches errors in root layout (must have
  `<html>`/`<body>` tags, no app shell available).
- `app/(app)/error.tsx` — catches errors inside authenticated app
  (sidebar + topbar stay rendered). Tags `boundary: "app-error"`.

**When Next.js fixes the standalone instrumentation bug upstream**, the
helper + chokepoint imports can be removed and we can revert to the
canonical `instrumentation.ts` → `sentry.server.config.ts` flow.

**Smoke test**: `GET /api/sentry-test` (disabled in prod unless
`ALLOW_SENTRY_TEST=1`). Throws a tagged error, expect HTTP 500 and a
new event in Sentry within ~10 seconds.

---

## 24. Actionable errors — no dead ends (CRITICAL for non-technical users)

Whenever the app **blocks or stops** a user (a guard, a disabled action, a failed
save, a validation error), it must never dead-end with only "can't / not allowed".
Every block gives three things:

1. **What happened** — plain language ("Ye quote delete nahi ho sakta").
2. **Why** — the reason ("Ispe payment + invoice laga hai").
3. **What to do next** — the concrete next step, **with a button/link to that place**
   whenever a destination exists ("Open invoice" → /invoices).

Patterns to use:
- **Blocking dialog** when there are specific records to act on — list them with
  Open buttons (see the quote-detail "Can't delete — why?" dialog in
  `app/(app)/quotes/[id]/page.tsx`).
- **Actionable toast** for inline failures — `toast.error(msg, { description, action: { label, onClick } })`
  (see the Payments delete `onBlocked` handler). RPC guard messages already state
  the next step in words — surface them AND add the button.
- **EmptyState** always gets an `action` (already the norm).

Backend guards (`raise exception` in SECURITY DEFINER RPCs) must phrase the message
as a next step ("… un-reconcile that bank line first", "… credit-note that invoice
before deleting") — never a bare "not allowed". Owner-trap check: if a guard blocks
an action, make sure there's ALWAYS a reachable way to complete/undo it (the
add-seats orphan trap in migration 0213 was a bug because there wasn't).

**"Done" for any guard/block = reason + next-step hint + (where possible) a button.**

## 23. Updates

This file is updated whenever a new convention is established. Last updated: 2026-05-29.

**Major additions since 2026-05-20:**
- Full renewal automation (Phase 1-4 + lifecycle pieces A/B/C) — schema, cadence engine, daily cron, email seam, auto-suspend with grace, record_payment roll-forward, on-demand "Generate quote" flow
- Quote send-via-email — server-rendered PDF + audit log + bottom-sheet dialog
- PWA support — manifest + dynamic icons (no static assets) + iOS apple-icon + install page at `/mobile` + Mobile preview iframe
- §20 — Complete responsive design (11 listing pages, 4 reusable primitives: `useBreakpoint`, `FAB`, `MobileBottomNav`, responsive `DialogContent`)
- §21 — Pre-launch readiness doc (`LAUNCH_READINESS.md`)
- 7 production bugs caught + fixed during pre-launch testing (cron idempotency, terminal-state protection, missing quote on edge dates, day-precise daysBetween, KPI grid squish, listing-page max-width, sparse-data empty area)

Any time you (Claude) make a non-obvious decision in this codebase, propose adding a rule to this file.
