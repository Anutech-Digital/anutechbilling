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
 * Adding one: a test that walks src/ (readdirSync/glob) or is a *ratchet* belongs here.
 * tests/push-guard-suites.test.ts fails if a listed file is gone or a *ratchet* test is missing.
 * Paths are relative to production/.
 */
export const PUSH_GUARD_SUITES = [
  // ── ratchets ──
  "src/lib/a11y/a11y-ratchet.test.tsx",
  "tests/gen-deploy-db.test.ts",
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
  "src/app/api/admin-client-ratchet.test.ts",
  "src/app/api/role-gate-ratchet.test.ts", // R-732
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
  // ── repo-source scans (readdirSync / glob over src) ──
  "src/app/(app)/quotes/invoice-link.test.ts",
  "src/app/(app)/accounting/cash-flow/cash-flow-copy-english.test.ts",
  "src/app/(app)/assessments/ui-copy-english.test.ts",
  "src/app/(app)/today/ui-copy-english.test.ts", // R-1731: whole-app Hinglish scan + allow-list that only shrinks
  "src/app/(app)/leads/card-list-scroll.test.ts",
  "src/app/(app)/marketing/marketing-copy-english.test.ts",
  "src/app/api/public/_lib/db-error.test.ts",
  "src/app/api/v1/scope-gate.test.ts",
  "src/components/providers/no-native-confirm.test.ts",
  "src/components/ui/button-hover.test.tsx",
  "src/lib/ai/autonomy-chokepoint.test.ts",
  "src/lib/ai/gemini-one-door.test.ts", // R-1817: only the scans; gemini.test.ts (~35 s of real retry timers) runs in CI
  "src/lib/app-url-fallback.test.ts",
  // R-1592 (18 Oct): repo-wide scans only CI ran — dd34789d (R-1598) broke the R-723 raw-host scan
  // past the push gate and CI stayed red ~2 h.
  "src/lib/app-url.test.ts",
  "src/lib/nav-route-guard.test.ts",
  "src/lib/queries/__tests__/money-read-scan.test.ts",
  "tests/secret-scan.test.ts",
  "src/lib/auth/no-passwords-in-source.test.ts",
  "src/lib/security/no-public-admin-env.test.ts", // R-730: admin allowlists never NEXT_PUBLIC_
  "src/lib/email/no-hardcoded-recipient.test.ts",
  "src/lib/feedback/internal-links.test.ts",
  "src/lib/feedback/route-map.test.ts",
  "src/lib/inbound/api-auth.wiring.test.ts",
  "src/lib/inbound/round-trip.test.tsx",
  "src/lib/keyboard/shortcuts.test.ts",
  "src/lib/leads/quote-sent-stage-wiring.test.ts",
  "src/lib/leads/unbounded-reads.wiring.test.ts",
  "src/lib/nav-links-resolve.test.ts",
  "src/lib/nav-s30.test.ts",
  "src/lib/nav.test.ts",
  "src/lib/ops/cron-report.wiring.test.ts",
  "src/lib/pdf/logo-wiring.test.ts",
  "src/lib/pdf/pdf-money.test.ts",
  "src/lib/pdf/pdf-text.test.ts",
  "src/lib/queries/no-seed-tenant.test.ts",
  "src/lib/quotes/auto-quote-wiring.test.ts",
  "src/lib/ui/grid-flow-col-reset.test.ts",
  "src/site/busy-feedback.test.ts",
  "src/site/cart-lines-priceable.test.ts",
  "src/site/lib/data/quote-catalog.test.ts",
  "src/site/lib/site-invariants.test.ts",
  "src/site/lib/sla.test.ts",
  "src/site/lib/whatsapp-one-source.test.ts",
  "src/site/plus-price-hidden.test.ts",
  "src/site/silent-disabled-buttons.test.ts",
  "src/site/support-page.test.ts",
  // ── repo-wide file scans ──
  "tests/ops/deploy-targets.test.ts", // R-1604: only live + staging deploy targets
];

/** Soft budget: the push prints a warning above this so the list gets trimmed, not ignored. */
export const PUSH_GUARD_BUDGET_MS = 90_000;

/** Failed test files from a vitest --reporter=json result (paths relative to production/). */
export function failedSuites(json, root) {
  const norm = (p) => String(p).replace(/\\/g, "/");
  const r = norm(root).replace(/\/+$/, "") + "/";
  return (json?.testResults ?? [])
    .filter((t) => t.status !== "passed")
    .map((t) => { const n = norm(t.name); return n.toLowerCase().startsWith(r.toLowerCase()) ? n.slice(r.length) : n; });
}
