# Workspace Rules & Directives

## 1. Top Progress Bar & UI Responsiveness Mandate
- The top animated Progress Bar with dynamic percentage badge (`production/src/components/shared/top-progress-bar.tsx`) is a **permanent, mandatory UX feature**.
- Every internal page transition and link click MUST trigger instant visual feedback with the animated percentage badge. Never disable or remove it.

## 2. Zero-Hang Local Development & Fail-Fast Supabase Engine
- Synchronous, un-timeouted `fetch` calls against local ports (e.g. `127.0.0.1:54321`) are **strictly prohibited**.
- Both `production/src/lib/supabase/server.ts` and `client.ts` MUST always use `createSupabaseFetch()` from `fetch-wrapper.ts`.
- In `NEXT_PUBLIC_DEMO_MODE=true`, auth queries (`/auth/v1/user`, `/rest/v1/users`) MUST resolve immediately (0ms mock path), and any unreachable database queries must fail fast within 300ms. Pages must never hang or wait on 20-second TCP retries.

## 3. Host-Native Dev Server Execution (Windows Sandbox Rule)
- When starting dev servers (`npm run dev`) for the user to test in their local browser, ALWAYS run outside the sandbox (`BypassSandbox: true`) so that Windows network loopback connects directly to Chrome with zero container/proxy latency.

## 4. Multi-Tenant Financial Spine & Ledger Rules
- **Rule 1 (Whole Rupees):** All financial values in database columns MUST be stored in whole Rupees, never paise. Local calculations may use paise integers for division rounding, but storage and display input is whole Rupees.
- **Data Integrity:** The parent-child chain (`Lead -> Deal -> Quote -> Payment -> Invoice -> Subscription`) must be preserved. Invoices are permanent records; adjustments use credit notes.

## 5. 2-Tier Cloud Infrastructure Directive (Zero VM)
- Production architecture is strictly 2-Tier: **Cloud Run (Stateless Next.js) + Cloud SQL (Managed PostgreSQL)**.
- Never deploy, provision, or rely on Google Compute Engine (GCE) Virtual Machines.

## 6. GitHub Pushing & Branch Synchronization Rule
- Whenever code changes, feature updates, or bug fixes are completed:
  1. Stage, commit with descriptive messages.
  2. Push to the active development repository remote (`modular` on `https://github.com/Anutech-Digital/reselleros-modular.git`):
     ```bash
     git add .
     git commit -m "<descriptive message>"
     git push modular HEAD:main
     ```
  3. And sync with `anutech` remote (`https://github.com/pardeepwebmaster/anutechbilling.git`):
     ```bash
     git push anutech HEAD:main
     ```
