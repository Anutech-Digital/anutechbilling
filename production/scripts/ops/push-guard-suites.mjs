/**
 * Push guard suites (R-385, 7 Oct 2026) — the fast tests `worker-lock.mjs push` runs after the
 * rebase, next to tsc. A failure refuses the push.
 *
 * 7 Oct: workers broke CI twice with tests OUTSIDE their own area — tests that scan the whole
 * repo source (a11y label ratchet, the invoice-link "View invoice" guard). `vitest related` does
 * not find them because they import nothing from the changed file; they read it with
 * readFileSync/readdirSync. So these run on every push. Measured 7 Oct: 49 files, ~40 s.
 * R-1817 (24 Oct): 70 files, 43–124 s (machine load); gemini.test.ts alone was 33–55 s of real
 * retry/breaker timers — its two repo scans now live in gemini-one-door.test.ts. Keep each listed
 * file a pure scan; a suite that sleeps or renders belongs in CI, not here.
 *
 * Adding one: a *ratchet*, a migration/deploy/security scan, or a cross-area src/ walker belongs
 * here; a slow scan that pins ONE feature's own wiring goes in CI_ONLY_GUARD_SUITES (R-2443).
 * tests/push-guard-suites.test.ts fails if a listed file is gone or a *ratchet* test is missing.
 * Paths are relative to production/.
 *
 * R-2443 (3 Nov 2026): 89 files took 105–137 s on the busy laptop and every push holds the
 * shared lock that long. Measured (same window, 3 rounds each): all 89 files 70/88/81 s; fewer
 * forks is SLOWER (8 forks 61–119 s, 5 forks 71–120 s vs the default 45–49 s), and --no-isolate
 * breaks pdf-text.test.ts — so the list got shorter instead. One worker, no contention: the test
 * bodies are only ~42 s in total; the rest is each file's fork + imports, and under the full fork
 * pool a whole-src walker swells ~13x (quote-sent-stage-wiring 3 s alone, 40 s in the pool). The
 * ten slow feature-wiring files moved to CI_ONLY_GUARD_SUITES below: CI's `npm run test` (vitest
 * run, every file in src/ + tests/, 2 shards) still runs them on every push, and the worker's FAST
 * GATE (docs/WORKER-STEPS.md) runs that list by name before push (most of the names do not match
 * the wiring or scan name globs). A file that turned CI red after skipping push (R-1592, R-1973) stays here.
 * Run it: `node scripts/ops/push-guard-suites.mjs --ci-only` prints the paths, one per line.
 *
 * R-2564 (7 Nov 2026): every push still took 85–169 s. Cause: ~20 of these files each walked src/
 * (4,900 files + Prisma's 36 MB generated client) or supabase/migrations (600 files) on their own —
 * on Windows the file opens are the cost, a dozen times over in the fork pool. Now a repo-wide scan
 * reads through src/lib/testing/source-cache.ts (`readSource`: size+mtime+ctime checked on EVERY
 * read, so never stale; one shared cache file per checkout in the OS temp folder) and skips the
 * generated client (src/lib/testing/prisma-generated.ts, pinned to the schema's output). Same tests,
 * same strictness. The five a11y guards build the a11y-count report in-process (a11yReport) instead of
 * spawning node five times. Measured alternating runs, 5–6 worker locks + tsc running: before
 * 202.5/169.0/64.2 s, after 48.8/35.0/26.2 s (light load: 55/57/49 → 28/27/28 s; cold cache 44.6 s).
 * A NEW whole-tree scan: read with readSource(), not readFileSync.
 *
 * R-2571 (7 Nov 2026): +6 migration/security scans (cloudsql-auth-shim etc.) — CI went red on one the
 * push did not run. The six alone: 50 s → 14 s with readSource. Whole guard step (88 files + lint
 * ratchet), 7 Nov with 64/44/21 node processes running: 32.0/29.5/28.4 s; a fresh worktree whose caches the
 * fast gate has not warmed yet: 85.7 s once.
 */
export const PUSH_GUARD_SUITES = [
  // ── ratchets ──
  "src/lib/a11y/a11y-ratchet.test.tsx",
  "tests/gen-deploy-db.test.ts",
  "tests/migrations-deploy-user-ratchet.test.ts", // R-2118: auth.* DDL in a deployed migration runs as postgres
  "tests/deploy-peek-conflict-ratchet.test.ts", // R-2106: no earlier peek needs an object a later peek needs absent
  "src/lib/errors/toast-error-r300.test.ts",
  "src/lib/a11y/a11y-r303.test.ts",
  "src/lib/a11y/a11y-r309.test.ts",
  "src/lib/a11y/billing-screens-a11y.test.ts",
  "src/lib/a11y/ink4-contrast-ratchet.test.ts", // R-1135: no real text in ink-4 (2.4:1)
  "src/lib/errors/toast-error-ratchet.test.ts",
  "src/server/postgrest/contact-mask-columns.test.ts", // R-1820: every phone/email column of leads/customers/contacts/customer_groups is masked
  "src/app/(app)/accounting/load-error-ratchet.test.ts",
  "src/components/features/accounting/rupee-ratchet.test.ts",
  "src/lib/accounting/rupee-hand-rolled-ratchet.test.ts", // R-1138: no new "₹" + toLocaleString("en-IN")
  "src/lib/checkout/live-key-staging-ratchet.test.ts", // R-2155: no Razorpay order/link/verify without the staging live-key guard
  "src/app/api/admin-client-ratchet.test.ts",
  "src/app/api/role-gate-ratchet.test.ts", // R-732
  "src/app/api/personal-gate-ratchet.test.ts", // R-2117: every route under a personal /api prefix is listed + owner-pinned
  "src/app/(app)/page-widths-ratchet.test.ts", // R-1489: §20 page widths
  "src/lib/quotes/discount-copies-ratchet.test.ts", // R-1133: no new hand-written quote discount
  "tests/ops/gen-api-doc.test.ts", // R-1665: docs/API.md regenerated when a route changes
  "src/lib/accounting/sale-documents.guard.test.ts", // R-1739: every invoices reader says if it counts sales
  "src/lib/queries/query-error-ratchet.test.ts", // R-1806/R-1807: a failed read shows an error, not ₹0 / empty
  "src/lib/errors/raw-error-message-ratchet.test.ts", // R-1656/R-1813: no raw Postgres/RPC text on screen
  "src/lib/dates/server-dates-ist.test.ts", // R-1660: no server-side date formatted without timeZone (emails in UTC)
  // ── migration scans ──
  "tests/rls-initplan-migrations.test.ts",
  "src/lib/security/definer-hardening-holds.test.ts",
  "src/lib/security/invoker-function-grants.test.ts", // R-401: Cloud SQL gives no PUBLIC EXECUTE
  "src/lib/security/service-role-policies.test.ts", // R-450: Cloud SQL gives service_role no BYPASSRLS
  // R-2571 (7 Nov 2026): R-2570's migration added a raw `auth.role() is null … session_user not in (…)`
  // list; cloudsql-auth-shim-scan caught it only in CI (red, every push stopped). Every src/lib/security
  // test that reads supabase/migrations now runs here (tests/push-guard-suites.test.ts pins that). All
  // read through readSource(); none needs a DB.
  "src/lib/security/cloudsql-auth-shim-scan.test.ts", // R-2487: no new raw auth.role() trusted-server list
  "src/lib/security/direct-login-role-scan.test.ts", // R-2485: no new raw current_user role check
  "src/lib/security/invoker-helper-grants-r2389.test.ts", // R-2389: invoker helpers stay granted to authenticated
  "src/lib/security/secret-columns.test.ts", // R-833: no browser role reads a secret column
  "src/lib/security/contact-logging-scan.test.ts", // R-1610: no unmasked email/phone in a server log
  "src/server/db/migrations-frozen.test.ts", // a new supabase/migrations file must reach the deploy-db scripts
  // ── repo-source scans (readdirSync / glob over src) ──
  "src/app/(app)/quotes/invoice-link.test.ts",
  "src/app/(app)/accounting/cash-flow/cash-flow-copy-english.test.ts",
  "src/app/(app)/assessments/ui-copy-english.test.ts",
  "src/app/(app)/today/ui-copy-english.test.ts", // R-1731: whole-app Hinglish scan + allow-list that only shrinks
  "src/app/(app)/leads/card-list-scroll.test.ts",
  "src/app/(app)/marketing/marketing-copy-english.test.ts",
  "src/app/api/public/_lib/db-error.test.ts",
  "src/app/api/v1/scope-gate.test.ts",
  "src/lib/ai/autonomy-chokepoint.test.ts",
  "src/lib/ai/gemini-one-door.test.ts", // R-1817: only the scans; gemini.test.ts (~35 s of real retry timers) runs in CI
  "src/lib/automation/cron-tenant-gate-scan.test.ts", // R-1818: every company-scoped cron asks cronTenantAllowed()
  // R-1592 (18 Oct): repo-wide scans only CI ran — dd34789d (R-1598) broke the R-723 raw-host scan
  // past the push gate and CI stayed red ~2 h.
  "src/lib/app-url.test.ts",
  "src/lib/nav-route-guard.test.ts",
  "src/lib/queries/__tests__/money-read-scan.test.ts",
  "tests/secret-scan.test.ts",
  "tests/radix-single-copy.test.ts", // R-1822: one copy of each Radix package (two = Esc/dropdown-in-dialog freeze)
  "src/lib/auth/no-passwords-in-source.test.ts",
  "src/lib/security/no-public-admin-env.test.ts", // R-730: admin allowlists never NEXT_PUBLIC_
  "src/lib/email/no-hardcoded-recipient.test.ts",
  "src/lib/feedback/internal-links.test.ts",
  "src/lib/feedback/route-map.test.ts",
  "src/lib/inbound/api-auth.wiring.test.ts",
  "src/lib/nav-links-resolve.test.ts",
  "src/lib/nav-coverage.test.ts", // R-2443: 3 Nov 6bdaeb0e (R-2445) went red in CI on it — a new page not in the menu; ~20 ms
  "src/lib/nav-s30.test.ts",
  "src/lib/nav.test.ts",
  "src/lib/ops/cron-report.wiring.test.ts",
  "src/lib/pdf/logo-wiring.test.ts",
  "src/lib/pdf/pdf-money.test.ts",
  "src/lib/pdf/pdf-text.test.ts",
  "src/lib/queries/no-seed-tenant.test.ts",
  "src/lib/ui/grid-flow-col-reset.test.ts",
  "src/site/busy-feedback.test.ts",
  "src/site/lib/data/quote-catalog.test.ts",
  "src/site/lib/site-invariants.test.ts",
  "src/site/lib/sla.test.ts",
  "src/site/plus-price-hidden.test.ts",
  "src/site/silent-disabled-buttons.test.ts",
  "src/site/support-page.test.ts",
  // R-1973 (26 Oct): src/site scans CI ran but the push did not — 8ca1bcbe went red on
  // page-metadata (R-1479 "no two indexable routes share a title"). All ten together ~5 s.
  "src/site/page-metadata.test.ts",
  "src/site/about-link-and-titles.test.ts",
  "src/site/anchor-links.test.ts",
  "src/site/claims-truth.test.ts",
  "src/site/honest-claims.test.ts",
  "src/site/box-padding.test.ts",
  "src/site/phone-width.test.ts",
  "src/site/site-price-display.test.ts",
  "src/site/lib/public-metadata-r1631.test.ts",
  "src/site/lib/site-split.test.ts",
  // ── repo-wide file scans ──
  "tests/ops/deploy-targets.test.ts", // R-1604: only live + staging deploy targets
  "tests/ops/dev-local-resend.test.ts", // R-2106: dev:local never lets a send key (Resend/SMTP/…) through; cron:local secret = dev-local's
  // R-2564: every scan above reads through this cache — it must never serve old text, and the skip is exactly Prisma's output
  "src/lib/testing/source-cache.test.ts",
  "src/lib/testing/prisma-generated.test.ts",
];

/**
 * R-2443: guard files that run ONLY in CI (still on every push — ci.yml `npm run test`), not
 * inside `worker-lock push`. Each is one feature's wiring or a unit test, slow under the push's
 * fork pool, and none was the cause of a red CI the push should have caught (all came in with the
 * first bulk list, R-385). Move a file back to PUSH_GUARD_SUITES if it ever turns CI red after a
 * push. tests/push-guard-suites.test.ts pins: these exist, are not in the push list, and CI runs them.
 */
export const CI_ONLY_GUARD_SUITES = [
  "src/lib/inbound/round-trip.test.tsx", // not a scan — imports QuotePDF (@react-pdf), ~28 s of imports; `vitest related` finds it
  "src/lib/leads/quote-sent-stage-wiring.test.ts", // 40 s in the pool (3 s alone) — two whole-src walks
  "src/lib/quotes/auto-quote-wiring.test.ts", // 25 s in the pool
  "src/lib/leads/unbounded-reads.wiring.test.ts", // 15 s in the pool
  "src/site/cart-lines-priceable.test.ts", // 19 s in the pool
  "src/site/lib/whatsapp-one-source.test.ts", // 13 s in the pool
  "src/lib/app-url-fallback.test.ts", // 13 s in the pool (the R-1592 raw-host scan app-url.test.ts stays on push)
  "src/components/providers/no-native-confirm.test.ts", // 14 s in the pool
  "src/lib/keyboard/shortcuts.test.ts", // 8 s in the pool
  "src/components/ui/button-hover.test.tsx", // jsdom render, 8 s in the pool
];

/** Soft budget: the push prints a warning above this so the list gets trimmed, not ignored. R-2443: 90 → 60 s. */
export const PUSH_GUARD_BUDGET_MS = 60_000;

/** A vitest json `name` (absolute path) relative to production/ (`root`), forward slashes. */
function relToRoot(name, root) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const r = norm(root).replace(/\/+$/, "") + "/";
  const n = norm(name);
  return n.toLowerCase().startsWith(r.toLowerCase()) ? n.slice(r.length) : n;
}

/**
 * R-2443: the files with the longest TEST time in a vitest --reporter=json result (endTime −
 * startTime: the tests themselves — a file's fork, imports and top-level code are not in the
 * report), so an over-budget push names where to look first. [{ file, ms }], slowest first.
 */
export function slowestSuites(json, root, n = 5) {
  return (json?.testResults ?? [])
    .map((t) => {
      const ms = Number(t.endTime) - Number(t.startTime);
      return { file: relToRoot(t.name, root), ms: Number.isFinite(ms) && ms > 0 ? ms : 0 };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n);
}

/** Failed test files from a vitest --reporter=json result (paths relative to production/). */
export function failedSuites(json, root) {
  return (json?.testResults ?? [])
    .filter((t) => t.status !== "passed")
    .map((t) => relToRoot(t.name, root));
}

/* R-2443: `node scripts/ops/push-guard-suites.mjs --ci-only` prints the CI-only list for the fast gate. */
if (process.argv[1] && /push-guard-suites\.mjs$/.test(process.argv[1].replace(/\\/g, "/")) && process.argv.includes("--ci-only")) {
  console.log(CI_ONLY_GUARD_SUITES.join("\n"));
}
