# CLAUDE.md — ResellerOS Production Project Memory

> **Session start, every time:** read [`../docs/TEAM-PROTOCOL.md`](../docs/TEAM-PROTOCOL.md) — your
> tasks and other people's changes live on the shared board, ownership in [`../OWNERS.json`](../OWNERS.json).

This file is read by Claude Code on every session. It contains all conventions, decisions, and rules. **Follow these without exception.**

> ### ⚠️ There is a second rulebook: [`../AGENTS.md`](../AGENTS.md)
>
> Two agents work in this repo — **Claude Code** reads this file, **Antigravity** reads
> `AGENTS.md` at the repo root. `AGENTS.md` holds the short list of rules that cost real
> money if got wrong, and it is written to be read by both.
>
> **Where the two disagree, `AGENTS.md` wins.** Not because it is more important, but
> because it is newer and was written after this file was found to contain a false rule:
> §13 claimed money is stored in paise when the database stores whole rupees (corrected
> 14 Aug 2026, verified against live data).
>
> **If you change a rule here, change it there too.** Two rulebooks that drift apart are
> worse than one that is merely long — the second agent will follow the stale copy and
> nobody will see it happen.
>
> **Canonical (S25):** `AGENTS.md` for rules, this file for conventions and patterns — see
> the note at the top of `AGENTS.md`. Decisions + the comment convention: `../docs/adr/`.

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
9. **UI / design work:** follow the project's existing design system FIRST — tokens in `globals.css`, `tailwind.config.ts`, primitives in `components/ui/`, responsive rules (§20). Don't invent new design or hardcode colors. After building any new screen/component, run `design-critique`, `accessibility-review` **and `layout-audit`**; **"design done" = all three pass**, just as "code done" = test green.
   - **`layout-audit` was added 29 Aug 2026** after a `/leads` redesign: five defects, and **four were invisible to the other two skills**, which had both been run. They check whether colours are tokens and whether a control is keyboard-reachable. Neither notices that the column carrying today's work is behind a horizontal scroll, or that a sticky column is sitting on top of its neighbour, or that a width is defined in two places that have drifted.
   - **Never review a layout from an empty state.** That same morning `/leads` was opened while logged out — dev mode bypasses the middleware, so the page rendered with its toolbar and empty state while all 30 leads were invisible. A redesign was one step away from being written for a screen nobody had actually seen. `layout-audit` §0 refuses to start on zero rows, and so should you.
   - **A skill that quotes a count goes stale.** Both older skills were re-measured that day and both had drifted — `design-critique` still named a missing type scale as the codebase's largest problem (it had been added; 1,963 call sites moved onto it), and `accessibility-review`'s `aria-pressed` gap had closed from 1-on-`/leads` to 10. Re-measure before reporting any number from any of the three.

**The goal (compass):** make the money-spine **lead → quote → pay → subscription → invoice → renewal** provably correct (test-backed) → confident soft launch → first paying customer. *Correct first, beautiful second, big third.*

**Map:** `docs/PROJECT-KNOWLEDGE.md` (whole system — ⚠️ audited only to migration `0050`, see its banner) · `docs/MONEY-FLOW-TEST-MATRIX.md` (**transaction**-level money bugs + launch line) · `docs/ACCOUNTING-AUDIT.md` (**statement**-level: P&L / Balance Sheet correctness) · `docs/UX-AUDIT.md` (interaction / behaviour — incl. §24 compliance measured at 1-of-278) · `TASKS.md` (live status — **the HANDOFF block at the top of `## Active` says what is half-done; read it before starting anything**).

**Two operational docs added 18 Aug 2026, both written from measurement:**
`docs/NEW-SESSION.md` — the 2-minute checklist Pardeep runs when opening a session, and the
paste-ready first message that makes you read the handoff and state your understanding
*before* working. It exists because five goals ran in one session and, after compaction, I
twice mis-remembered my own earlier work and asserted a blocker I had never tested.
`docs/WORKING-ENVIRONMENT.md` — the machine-level fixes (Defender exclusion, the malformed
`SUPABASE_ACCESS_TOKEN`, permission rules) with the measured cost of each. Note its first
section: I blamed the Stop-hook test gate for the slowness and it turned out to be **9
seconds**. Measure before you propose removing a safeguard.

---

## 1. What is this project?

**ResellerOS** — a multi-tenant SaaS for Indian cloud resellers (Google Workspace, Microsoft 365, Zoho).
Each "tenant" is a reseller business; each tenant manages many of their own customers.

- **Owner / platform company**: **ANUTECH DIGITAL PVT LTD** · primary email `pardeep@anutech.in` ·
  GSTIN `07ABDCA0298H1ZP` (Delhi, 07) · directors **Pardeep Sharma** and **Deepak Sharma**.
  This is tenant `fbb976f1-9090-4f10-9726-0901bd144e42`, `tier = 'distributor'`. **Every other
  tenant is a tenant company under it** — see §4a.
  ⚠️ Corrected 2026-08-14. This entry previously said "Excel Technologies Pvt Ltd ·
  pardeep@exceltechnologies.in". Excel Technologies is historical: the same tenant row was
  created by `pardeep@exceltechnologies.in` on 26 May 2026 and later renamed. Two traces of
  that identity were left in the code:
  - `doc_code` was `ET` (set by `0054_tenant_scoped_document_ids.sql:23`) — **now `ADPL`**,
    changed 14 Aug 2026. It was free to change because this tenant had issued **zero**
    documents (every `document_series.last_number` was 0 and there were no invoices, quotes,
    POs, or credit/debit notes). After the first document it would have split the GST series
    under CGST Rule 46 and become a compliance decision, not a rename — which is why
    `scripts/set-doc-code.mjs` refuses once anything has been issued. Next invoice:
    `INV-ADPL-2026-27-0001`.
  - The dev-login demo list in `(auth)/login/page.tsx:27-31` still names Excel Technologies.
    Dev-only and harmless, but it is why the wrong name keeps resurfacing.
- **First customer**: ANUTECH DIGITAL PVT LTD itself
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
| i18n | **None — by decision.** Pardeep, 1 Sep 2026: "hindi ui nahi karna hai". UI is English + Hinglish; next-intl was a dead dep (zero imports ever) and was uninstalled the same day. Do not re-propose Hindi/i18n. |
| Icons | **lucide-react** |
| Email | **SMTP** as the platform sender (`lib/email/smtp-transport.ts`), then **Resend**; a tenant's own Gmail wins. Every recipient is mailed — no allow-list (AGENTS.md §0). |
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

## 4a. Who owns which tenant (added 2026-08-14)

**ANUTECH DIGITAL PVT LTD** (`fbb976f1…`, `tier='distributor'`) is the platform company.
Every other tenant is a tenant company under it. The hierarchy columns already exist —
`tenants.parent_tenant_id` + `tenants.tier` from `0040_reseller_hierarchy.sql` — but as of
14 Aug 2026 **no child tenant actually has `parent_tenant_id` set**. Setting it is a
commercial statement ("this tenant buys wholesale from that distributor",
`0040_reseller_hierarchy.sql:12`), so it is Pardeep's call, not a cleanup.

**Never assume a tenant's name tells you whose it is.** New tenants are auto-named from the
signer-in's email domain (`(auth)/callback/route.ts:23`), so a wrongly-created tenant is
named *exactly* like the company it should have joined. On 11 Aug 2026 that produced a
private "Excel Technologies" tenant holding 3 real customers and a ₹21,240 payment, and
nobody noticed for two days because the sidebar showed the expected company name. When
diagnosing "the app looks empty", check `tenant_id`, never the tenant name.

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
- Customer-facing under `(public)/`: `/buy/workspace`, `/quote/[id]/accept`, `/terms`, `/privacy`. There is no `/buy/m365` or `/buy/zoho` (Microsoft 365 and Zoho are quoted, not bought online) and no `/portal` (deleted 19 Sep 2026; DMS owns the customer panel). The shop's own pages are under `(marketing)/`: `/`, `/hosting`, `/domains`, `/cart`, `/checkout`, `/contact`, `/terms-and-conditions`, `/refund`, `/privacy-policy`.
- Auth under `(auth)/`: `/login`, `/signup`, `/forgot-password`
- API under `/api/`: `/api/webhooks/razorpay`, `/api/webhooks/csp`, `/api/cron/renewals`
- Dev-only under `/dev/`: 404'd in production by `middleware.ts` unless `ALLOW_DEV_PAGES=1`.
  ⚠️ **This line was false until 23 Aug 2026.** It claimed a "middleware redirect if
  NODE_ENV=production" that did not exist anywhere in the file. Measured against the live
  service with no session: `GET /dev/pdf-test` returned **200** — a page rendering a sample
  tax invoice from hardcoded fixtures, including the fabricated GSTIN `27AABCE9876D1Z3`
  that `lib/invoices/supplier-identity.ts` exists to keep off real documents, served
  publicly under the company's own domain. Found while adding a dev page that deliberately
  crashes the browser, which in a public directory would have been a crash-on-demand
  endpoint for anybody. The gate is real now, fails closed (`!== "1"`), and runs before the
  auth work — a dev page should not exist in production for anybody, signed in or not.

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

- **⚠️ MONEY IS STORED IN WHOLE RUPEES (integers), NOT paise.** Corrected 14 Aug 2026 —
  this line previously said "All money in paise", which is false and is the most
  dangerous kind of false: acting on it puts a `× 100` or `÷ 100` into money code.
  **Verified against the live DB**, not inferred: `items` row "Google Workspace Business
  Starter" holds `msrp = 270`, `wholesale = 110`. Those are ₹270 and ₹110 per seat per
  month. As paise they would be ₹2.70 and ₹1.10, which is not a real price for anything.
  - `rupee(490644)` → `"₹4,90,644"` — it takes **rupees**. Its own docstring in
    `utils.ts:42` still claims "internally we store paise", and contradicts itself in the
    next clause ("but most UI calls pass rupees"). Treat the docstring as wrong too.
  - `rupeeFromPaise()` exists and is correct for genuinely-paise values — but almost
    nothing in this schema is paise. Check the column before reaching for it.
  - **Paise DO appear inside calculations**, deliberately: `lib/subscriptions/proration.ts`
    and `margin.ts` convert to integer paise so a division rounds once instead of drifting,
    then convert back. That is a local unit for arithmetic, not the storage unit.
  - Rule of thumb: if it came out of the database or is going into it, it is rupees.
- **Number format**: Indian lakh/crore (e.g., ₹4,90,644 not $490,644)
- **Date format**: `DD MMM YYYY` (e.g., 15 May 2026), IST timezone
- **Phone format**: `+91 98765 43210` with space groupings
- **GSTIN format**: 15-char alphanumeric, validated against checksum
- **HSN code for SaaS**: 998313 (default)
- **GST rate for SaaS**: 18% (CGST 9% + SGST 9% for intra-state, IGST 18% inter-state)
- **Language**: English UI + Hinglish copy — Hindi i18n CANCELLED by owner decision (1 Sep 2026); do not re-propose

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
- ❌ **Don't assume Supabase reads are fresh — on EITHER side.** Both clients now pin `cache: "no-store"`, for two different reasons, and any new client you add must do the same.
  - **Server** (`createAdminClient()`, fixed 14 Jul 2026): Next.js App Router caches GET `fetch()` calls, including the ones Supabase makes. Without no-store `/api/v1` served STALE billing status and let revoked API keys authenticate.
  - **Browser** (`createClient()`, fixed 14 Aug 2026): Supabase REST sends **no `Cache-Control`** and **no `Vary: Origin`**, and it **echoes the request Origin** into `Access-Control-Allow-Origin`. So (a) the browser may heuristically cache a balance or payment status and serve it instead of the DB, and (b) — the one that will waste your afternoon — a response cached while on `http://localhost:3000` is replayed to the deployed origin still carrying `Access-Control-Allow-Origin: http://localhost:3000`, so **every** client-side query fails CORS and the page dies in the error boundary. The build is fine; the cache is poisoned. Only a machine that visits both origins can reach it, which is why it never shows up in monitoring and always looks like "the deploy is broken".
  - **Debugging tip when a deployed page dies but the build is clean:** in the page console, `fetch(sameUrl, {cache:'default'})` vs `{cache:'reload'}`. If only `reload` succeeds, it is the cache, not your code.

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

| Operation                                          | RPC name — status (corrected 1 Sep 2026; this table had drifted badly) |
|----------------------------------------------------|---------------------------|
| Record a payment (auto-converts lead → customer)   | `record_payment` ✅ SHIPPED — the spine's backbone (~550 lines; overpayment credit atomic since 20260901110000) |
| Generate invoice from a paid quote                 | `generate_invoice` ✅ SHIPPED (archive 0058; GST split frozen at issue) |
| Refund a payment + recompute outstanding           | `refund_payment` ✅ SHIPPED (20260901120000 — RFV voucher + quote/sub recompute + credit-close in one txn; refuses when a GST invoice exists → credit note first) |
| Renew a subscription + roll forward dates          | folded INSIDE `record_payment` by design — a paid renewal quote rolls the sub forward; no separate RPC exists or is planned |

The audit that corrected this table (1 Sep 2026) also measured 150 distinct functions in migrations+baseline — this table lists the money-spine four only. Do not add new multi-row money writes from the client. Bank reconciliation — the old worst offender (`bank.ts`, 6 chained writes in two hand-kept copies) — was folded into the atomic `reconcile_bank_txn` RPC on 1 Sep 2026 (migration `20260901160000`, test `supabase/tests/reconcile_bank_txn.test.sql`); both hooks (`useReconcileTransaction`, `useAutoReconcile`→`applyReconcile`) now call it, so they cannot drift. The one still outstanding is the post-RPC writes in `record-payment-dialog.tsx` (bank account / domain / TAN patches).

---

## 18. Roadmap (high-level)

- **Phase 1 (Weeks 1-3)**: Foundation — auth, multi-tenant, design system, layout shell, CRUD
- **Phase 2 (Weeks 4-6)**: Money — Razorpay, GST, WhatsApp, email
- **Phase 3 (Weeks 7-9)**: Reseller moat — Google CSP, margin, churn risk, AI features
- **Phase 4 (Weeks 10-12)**: Polish — PWA, performance, security audit (Hindi cancelled 1 Sep 2026)
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

**Machine-enforced since 1 Sep 2026:** `src/lib/errors/toast-error-ratchet.test.ts` counts
every `toast.error(...)` that carries neither `description:` nor `action:` and fails the suite
if the count ever RISES above its measured baseline (450 of 481 on 1 Sep — twenty days of
"migrate opportunistically" had moved exactly one). New error toasts must ship §24-complete;
fixing an old one means lowering the baseline in that test so it can never climb back.

**The customer site follows the same rule for presses and waits (30 Sep 2026)**, each pinned by a
scan test:
- **No silently disabled button.** A press with details missing says what is missing instead of
  doing nothing, and a disabled button looks disabled (`src/site/silent-disabled-buttons.test.ts`).
- **A wait shows progress.** A page that POSTs and makes the customer wait renders `<BusyPanel>`
  (`components/ui/busy-panel.tsx`): what is being done, a seconds count, and a "taking longer than
  usual" line (`src/site/busy-feedback.test.ts`).
- **Success only when it happened.** A form says "check your inbox" only when the server reports the
  email was sent, and a failure says nothing was saved and to try again (`src/site/honest-submit.test.ts`).
- **A stop at checkout is a pop-up with the fix (1 Oct 2026).** A refused trial or order, a missing
  domain or state, or a failed payment opens `<CheckoutNotice>` (`site/components/cart/`): what happened,
  a reassurance line, and the buttons that solve it — e.g. a repeat trial offers "Buy Starter — ₹…",
  "Ask for more trial time", "Not me — check my details". The wording and buttons per case live in
  `site/lib/checkout-problem.ts` (tested); a failed payment never says "nothing was charged". The checkout's
  waits use `<BusyPanel variant="modal">`, a centred card, so the form under it does not move.
- **A pop-up that locks page scrolling uses `lib/ui/scroll-lock.ts` (3 Oct 2026).** Never save-and-restore
  `body.style.overflow` yourself: the progress card and Razorpay both did, Razorpay put back the card's
  "hidden", and `/done` arrived unscrollable after a payment. The lock is counted; the checkout calls
  `settlePageScroll()` after Razorpay closes, and `/done` settles on arrival
  (`src/lib/ui/scroll-lock.test.ts`).

---

## 25. Session hygiene — working with Claude (added 2026-08-12)

> Added after a full-codebase audit session. Every rule here exists because it
> actually cost something in that session, not because it sounds sensible.

**1. Docs are hypotheses. Code is truth.**
Docs in this repo go stale faster than anyone updates them. `docs/PROJECT-KNOWLEDGE.md`
claimed 27 migrations when there were **196**; it also still listed payment
idempotency as "the biggest spine risk" long after `0051` fixed it. Never quote a
count, a module list, or a bug status from a doc — verify it, then cite `file:line`.
**And when you find a doc wrong: fix it or stamp it stale in the same session.**
Working around a stale doc leaves the trap armed for the next reader.

**2. What "green" means here.**
```bash
npm run typecheck && npm run test && npm run lint && npm run build   # lint warnings OK, errors not
```
⚠️ **`npm run build` is in that list because the other three DO NOT CATCH IT.**
Corrected 16 Aug 2026, after a deploy attempt found the build had been broken for
some time while all three passed. `next.config` sets `experimental.typedRoutes`,
and Next generates the route types **at build time** — so `tsc --noEmit` type-checks
against types that do not exist yet and happily passes a `<Link href="/leads?view=all">`
that the build rejects. Vitest never renders it and ESLint does not type-check.

The cost of leaving it out is not a red tick, it is a deploy that cannot happen:
production could not be released at all, and nothing in the gate said so. `build`
is slow (~2 min) — run it before a deploy and before calling a branch done, not
after every turn.
⚠️ **CI does not gate feature branches.** `.github/workflows/ci.yml` triggers only on
pushes to `master` / `v3-dev` and on PRs — so on a long-lived session branch **the
local gate is the only gate.** This is exactly how 4 unit tests sat broken for months:
nobody was careless, there was simply no door.

**There is now a door:** a `Stop` hook in `.claude/settings.json` (committed, team-wide)
runs `npm run test` at the end of every Claude turn and surfaces a warning if anything
fails. It is deliberately **non-blocking** — it makes a red suite impossible to *miss*,
without trapping a turn in a fix-loop over a pre-existing failure. `typecheck` and
`lint` are still manual (typecheck is ~40s; too slow to run every turn).

Also: the SQL regression tests in `supabase/tests/` are **not in CI and not in the
hook**. ⚠️ **Corrected 29 Aug 2026** — this said "28" and there are **42**, and there was no
way to run them together at all, so they had never been run as a suite. There is now:

```bash
cd production && npm run test:sql          # sab 42 · ~3.5 min · production par, sab rollback
cd production && npm run test:sql payment  # naam se chhaan kar
```

It refuses to start unless every file has `rollback` and no `commit`, and it runs a **canary**
first — a file that must fail. Canary green means `raise exception` is not being surfaced and
every pass below it would be a lie, so the run aborts instead of reporting 42/42.

First suite run: **39/42**. All three reds were in the tests, not the product —
`create_project_direct_invoice` had an assertion that had never executed (`r.quote_id` on a
record with no such field, so the block died at 42703 one line before the end),
`subscriptions_item_id` pinned itself to a catalog row somebody has since deleted, and
`sandbox_tenant_isolation`'s control read a table its tenant has zero rows in. All three fixed
and mutation-checked; the suite is 42/42.

Still not in CI: that needs DB credentials in GitHub Actions, which is a decision, not a
cleanup. Run it by hand before any DB/RPC change lands.

*Note for hook authoring on this machine: `jq` is NOT installed, so the usual
`jq`-based hook recipes will silently fail. Use `grep`/`printf`, or `node -e`.*

**3. Say which kind of verified.**
Three different things, never blur them:
- **test-verified** — a test asserts it
- **browser-verified** — actually observed in the running app
- **reasoned-only** — inferred from reading code/migrations

"Reasoned-only" is a perfectly good answer. Calling it "verified" is not. If something
couldn't be checked, say so plainly and say why (no DB access, dev server wouldn't
compile) rather than leaving a confident impression.

**4. The dev server is slow — plan for it.**
First compile ~36s; heavy pages (`/customers/[id]`) can take minutes or stall
outright. If browser verification is part of the task, start the server early. If it
stalls, **say so and move on** — don't spend the session waiting on it.

**5. Cost before build.**
For anything risky, irreversible, or money-touching: put the **price and the cheaper
alternative on the table first**, then the plan. Lesson from this session — a full
cross-tenant-membership plan got written before anyone noticed the change wouldn't
even deliver the one feature (group view) that motivated it, and that two logins
would. Design was right; timing was wrong. That should surface in sentence one, not
after the plan.

**6. Applying a migration through the Supabase SQL editor — two hard rules.**
Learned the slow way: one migration took five attempts, and every "apply kar
diya" along the way was honest.
- **Run DDL in small batches, never a whole migration file.** The editor runs a
  pasted script as ONE transaction, so if any later statement fails — a `do $$`
  block, an index, a `comment on` — *everything* rolls back, including the
  `ALTER` that succeeded. The screen shows an error nobody connects to "nothing
  applied".
- **NEVER put a verification `SELECT` in the same run as the DDL.** It executes
  inside that same uncommitted transaction, sees the new columns, and returns
  rows — so it reports success for a change that is about to disappear. Run the
  DDL alone, then verify in a **separate** run.

Also: `current_database()` is `postgres` on *every* Supabase project, so it
cannot tell two projects apart. Use the project ref in the dashboard URL, or a
row-count fingerprint.

**7. Prod DB access is the highest-leverage thing to hand Claude.**
Half the tenancy analysis in that session was *reasoned-only* because there was no way
to query prod. Given this repo's own history of git-vs-prod drift (`0003` consolidated
19 ad-hoc prod changes; `0146` captured more), inference is not proof. Read-only DB
access — or just running the SQL and pasting the output — converts careful guesses into
facts.

## 23. Updates

This file is updated whenever a new convention is established. Last updated: **2026-08-12**.

**Added 2026-08-12:**
- **§25 — Session hygiene.** From a full-codebase audit: docs-are-stale discipline, what "green" means (and that **CI does not gate feature branches** — the local gate is the only gate), the test-verified / browser-verified / reasoned-only distinction, dev-server slowness, cost-before-build, and why read-only prod DB access is the highest-leverage thing to provide.
- Stale-audit banner added to `docs/PROJECT-KNOWLEDGE.md` (it stopped at migration `0050`; there are now 196).

**Major additions since 2026-05-20:**
- Full renewal automation (Phase 1-4 + lifecycle pieces A/B/C) — schema, cadence engine, daily cron, email seam, auto-suspend with grace, record_payment roll-forward, on-demand "Generate quote" flow
- Quote send-via-email — server-rendered PDF + audit log + bottom-sheet dialog
- PWA support — manifest + dynamic icons (no static assets) + iOS apple-icon + install page at `/mobile` + Mobile preview iframe
- §20 — Complete responsive design (11 listing pages, 4 reusable primitives: `useBreakpoint`, `FAB`, `MobileBottomNav`, responsive `DialogContent`)
- §21 — Pre-launch readiness doc (`LAUNCH_READINESS.md`)
- 7 production bugs caught + fixed during pre-launch testing (cron idempotency, terminal-state protection, missing quote on edge dates, day-precise daysBetween, KPI grid squish, listing-page max-width, sparse-data empty area)

Any time you (Claude) make a non-obvious decision in this codebase, propose adding a rule to this file.
