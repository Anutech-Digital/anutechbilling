/**
 * Push guard suites (R-385, 7 Oct 2026) — the fast tests `worker-lock.mjs push` runs after the
 * rebase, next to tsc. A failure refuses the push.
 *
 * 7 Oct: workers broke CI twice with tests OUTSIDE their own area — tests that scan the whole
 * repo source (a11y label ratchet, the invoice-link "View invoice" guard). `vitest related` does
 * not find them because they import nothing from the changed file; they read it with
 * readFileSync/readdirSync. So these run on every push. Measured 7 Oct: 49 files, ~40 s.
 *
 * Adding one: a test that walks src/ (readdirSync/glob) or is a *ratchet* belongs here.
 * tests/push-guard-suites.test.ts fails if a listed file is gone or a *ratchet* test is missing.
 * Paths are relative to production/.
 */
export const PUSH_GUARD_SUITES = [
  // ── ratchets ──
  "src/lib/a11y/a11y-ratchet.test.tsx",
  "src/lib/a11y/a11y-r303.test.ts",
  "src/lib/a11y/a11y-r309.test.ts",
  "src/lib/a11y/billing-screens-a11y.test.ts",
  "src/lib/errors/toast-error-ratchet.test.ts",
  "src/app/(app)/accounting/load-error-ratchet.test.ts",
  "src/components/features/accounting/rupee-ratchet.test.ts",
  "src/app/api/admin-client-ratchet.test.ts",
  // ── migration scans ──
  "tests/rls-initplan-migrations.test.ts",
  "src/lib/security/definer-hardening-holds.test.ts",
  "src/lib/security/invoker-function-grants.test.ts", // R-401: Cloud SQL gives no PUBLIC EXECUTE
  "src/lib/security/service-role-policies.test.ts", // R-450: Cloud SQL gives service_role no BYPASSRLS
  // ── repo-source scans (readdirSync / glob over src) ──
  "src/app/(app)/quotes/invoice-link.test.ts",
  "src/app/(app)/accounting/cash-flow/cash-flow-copy-english.test.ts",
  "src/app/(app)/assessments/ui-copy-english.test.ts",
  "src/app/(app)/leads/card-list-scroll.test.ts",
  "src/app/(app)/marketing/marketing-copy-english.test.ts",
  "src/app/api/public/_lib/db-error.test.ts",
  "src/app/api/v1/scope-gate.test.ts",
  "src/components/providers/no-native-confirm.test.ts",
  "src/components/ui/button-hover.test.tsx",
  "src/lib/ai/autonomy-chokepoint.test.ts",
  "src/lib/ai/gemini.test.ts",
  "src/lib/app-url-fallback.test.ts",
  "src/lib/auth/no-passwords-in-source.test.ts",
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
