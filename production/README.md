# ResellerOS — Production

The operating system for Indian cloud resellers (Google Workspace, Microsoft 365, Zoho):
leads → quotes → subscriptions → GST invoices → payments → accounting, multi-tenant.

**Status (Sep 2026):** live in production for ANUTECH DIGITAL PVT LTD. ~150 pages, ~190 API
routes, 124 timestamped migrations on top of `supabase/baseline.sql`, ~440 unit-test files
(Vitest) and 85 SQL regression tests. Wrong numbers here become wrong invoices to real
customers — read [`../AGENTS.md`](../AGENTS.md) before your first change.

---

## 🚀 Quick start for a new developer

### What you need first

| | Why |
|---|---|
| **Node.js 20+** | [nodejs.org](https://nodejs.org/) — LTS version |
| **Docker Desktop** | [docker.com](https://docker.com/products/docker-desktop) — your database runs inside it. On Windows, run `wsl --install` in an **Administrator** Command Prompt first, then restart. |

Docker must be **running** — open Docker Desktop and wait for it to say *Engine running*.

### Then two commands

```bash
cd production/
npm install
npm run setup
```

`npm run setup` checks your prerequisites, starts a **local database on your own
machine**, and loads the production schema into it (baseline + migrations, no customer
data). If something is missing it stops and tells you what, rather than failing later with
a Postgres error.

Your database is yours alone. ⚠️ A `.env.local` copied from someone else may point at
**production** — check `NEXT_PUBLIC_SUPABASE_URL` before running anything.

**`npm run dev:local` (S8)** removes that risk without touching `.env.local`: it points the
app at the local Supabase from `supabase status` (and refuses anything that is not
localhost), and blanks every other `.env.local` key except a short allowlist — Razorpay,
Resend, Gupshup, Vapi/Retell, Google reseller, GST IRP, Gemini are all off, so nothing leaves
the laptop. The topbar shows a **Local** badge. See `scripts/dev-local.mjs`.

### Daily

```bash
npm run dev:local    # the app on YOUR local DB, live keys off → http://localhost:3001  (use this)
npm run dev          # the app with whatever .env.local says    → http://localhost:3000
npm run db:studio    # browse your DB   → http://localhost:54323
npm run db:stop      # stop the DB      (it keeps running otherwise)
```

### Before pushing

```bash
npm run gate         # build, typecheck, unit tests, lint — in the right order
npm run lint:ratchet # lint warnings may not grow (lint-baseline.json)
```

CI (`.github/workflows/ci.yml`) runs all of these plus a migration-order check, and every
step is blocking. Lint **errors** fail; lint **warnings** fail only when a rule has more
than its baseline — fix some, run `node scripts/lint-ratchet.mjs --update`, commit the
smaller numbers.

### How code reaches production

- Each person works on their own branch (`OWNERS.json`: `manager-pardeep`, `billing-abhishek`,
  `website-pawan`) and pushes only to it. Cross-area needs go on the team board — see
  [`../docs/TEAM-PROTOCOL.md`](../docs/TEAM-PROTOCOL.md).
- A push to the `deploy` branch triggers Cloud Build (`../cloudbuild.yaml`): **gate** (npm ci,
  tsc, vitest) → Docker build → Cloud Run `resellersos` in `asia-southeast1`. A red gate
  never deploys.
- Something broke after a deploy: [`../docs/ROLLBACK.md`](../docs/ROLLBACK.md).

### Database changes

```bash
npm run migration:new -- add_customer_credit_limit
```

Timestamp-named, so two people writing a migration on the same day cannot collide. Never
edit a migration that is already on a shared branch — write a new one (CI fails on an
edited, renamed or out-of-order migration). Migrations are applied to production by a human.

⚠️ **Do not build a database from `supabase/migrations-archive/`.** Those files are the
real history of production, but they cannot build a database from empty. A fresh database
comes from `supabase/baseline.sql`, which `npm run setup` handles for you.

**DB types are generated (S21).** After a migration, regenerate and commit them in the same
commit:

```bash
node scripts/check-db-types.mjs --write   # needs the local supabase stack (npx supabase start)
node scripts/check-db-types.mjs           # check only: exit 1 if the committed types are stale
```

It builds a throwaway database (`types_check_<pid>`) in the local docker Postgres from
`baseline.sql` + every migration, runs the stack's own postgres-meta generator, diffs against
`src/lib/supabase/database.generated.ts` (never edit that by hand), and drops the database. It
never touches the shared local `postgres` database beyond a schema-only read of `auth`/`storage`,
and never uses `--linked`. Not wired into CI — CI has no docker supabase stack.
Import types from `@/lib/supabase/database.types` as before: that file is a thin overlay for what
the generator cannot express (CHECK-constrained text unions, jsonb shapes, RPC return shapes).
`OverlayCheck` in it fails `tsc` if an overlay entry names a column/table/function that no
longer exists.

---

## 📂 What's in this folder

```
production/
├── CLAUDE.md             # Long-form conventions for Claude Code (rules: ../AGENTS.md wins)
├── src/app/              # Next.js App Router: (app) staff screens, (public), (auth), api/
├── src/components/       # ui/ primitives, layout/, features/<area>/
├── src/lib/              # domain logic per area (accounting, gst, invoices, payments…)
├── supabase/
│   ├── baseline.sql      # schema a fresh DB is built from
│   ├── migrations/       # YYYYMMDDHHMMSS_name.sql, applied in order
│   ├── tests/            # SQL regression tests (npm run test:sql -- --local)
│   └── cloudsql/         # the Cloud SQL + self-hosted Supabase setup (ADR 0001)
├── scripts/              # gate, lint ratchet, migration checks, backups, ops tools
├── e2e/                  # Playwright
└── Dockerfile            # the image Cloud Build ships
```

Decisions and their reasons: [`../docs/adr/`](../docs/adr/).

---

## 🔧 Stack at a glance

| Layer | Choice |
|---|---|
| Framework | Next.js 14 App Router, TypeScript strict |
| UI | Tailwind CSS + shadcn/ui (Radix) primitives |
| Data | Postgres 17 on **Cloud SQL**, reached through a **self-hosted Supabase data plane** (PostgREST, GoTrue, Storage) at `api.anutech.in` — [ADR 0001](../docs/adr/0001-database-on-cloud-sql.md) |
| Auth | GoTrue (Supabase Auth): email + Google OAuth; tenant isolation by RLS |
| State | TanStack Query v5; React Hook Form + Zod |
| Payments | Razorpay |
| Hosting | Google Cloud Run (`asia-southeast1`), built by Cloud Build |
| Monitoring | Sentry, Cloud Monitoring uptime check on `/api/version` |
| Testing | Vitest (unit), SQL regression tests, Playwright (E2E) |

Hosting & domain management is **not** in this repo — it is DMS, a separate app
(see `../AGENTS.md` §0).

---

## 🧹 Housekeeping notes

**Unused dependencies removed (29 Sep 2026, S25).** `@radix-ui/react-progress`,
`@radix-ui/react-scroll-area`, `@radix-ui/react-toggle`, `@testing-library/jest-dom`,
`@vitejs/plugin-react` and `prettier-plugin-tailwindcss` were imported nowhere (`src/`, `scripts/`,
`e2e/`, `tests/`, configs) and are gone from `package.json` and `package-lock.json`.
`@tanstack/react-query-devtools` stays on purpose: dev-only, and `query-provider.tsx` keeps it
so the query inspector can be re-added with one import. Want Tailwind class sorting? Add a
Prettier config and `npm i -D prettier-plugin-tailwindcss`.

---

## 🆘 Troubleshooting

| Problem | Solution |
|---|---|
| `npm install` fails | Make sure Node.js 20+, try `npm cache clean --force` then retry |
| `Cannot find module '@/...'` | Restart TS server in VS Code: Cmd+Shift+P → "Restart TS Server" |
| Tailwind classes not working | Restart dev server (`Ctrl+C` then `npm run dev`) |
| `tsc` errors in `.next/types` during a build | Don't run `tsc` and `next build` at the same time — `npm run gate` orders them |
| Type errors | Run `npm run typecheck` — fix all errors before committing |

---

## 📚 Learn the stack (recommended reading)

- [Next.js App Router docs](https://nextjs.org/docs/app)
- [shadcn/ui](https://ui.shadcn.com/)
- [TanStack Query](https://tanstack.com/query/latest)
- [Tailwind CSS](https://tailwindcss.com/docs)
- [Supabase docs](https://supabase.com/docs)

---

## 📞 Who owns what

See [`../OWNERS.json`](../OWNERS.json): **Pardeep** — accounting, compliance, CRM/leads,
marketing, payroll, infra & CI; **Abhishek** — billing & subscriptions (customers, quotes,
invoices, payments); **Pawan** — customer-facing pages, checkout, public API. Shared files
(migrations, `package.json`, layout, the rulebooks) — smallest change that works, plus a
`changes` note on the board.

---

## 📜 License

Proprietary. © 2026 Client A Pvt Ltd. All rights reserved.
