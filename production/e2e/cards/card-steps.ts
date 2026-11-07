/**
 * card-steps.ts — shared helpers for CARD TESTS (R-2550, 7 Nov 2026).
 *
 * Pardeep: "test ek baar likho, hamesha chalao". A board card's howToCheck becomes one spec
 * here (e2e/cards/<card id>.spec.ts), ONE test per howToCheck step, and
 * `node scripts/ops/card-tests.mjs <card id>` runs it against the localhost app in about a minute.
 *
 * Logins: the same "Local test login" buttons the /login page shows on localhost (R-281) —
 * POST /api/dev/test-login { role }. The SERVER picks the seeded E2E test account and its
 * password; this runner never sees or needs a password, and the route answers 404 anywhere but
 * `npm run dev:local` on localhost. So a card test cannot sign in to staging or live at all.
 *
 * Card specs run ONLY through card-tests.mjs (it sets CARD_TESTS=1). The normal E2E suite
 * (`npm run test:e2e`, GitHub's E2E job against staging) also collects e2e/cards/*.spec.ts —
 * there every card spec skips, because the local test login does not exist there.
 */
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { TestLoginRole } from "../../src/app/api/dev/test-login/rules";

/** True only inside `node scripts/ops/card-tests.mjs`. */
export const CARD_TESTS_ON = process.env.CARD_TESTS === "1";

/** Call at the top of every card spec's describe. */
export function onlyInCardTests() {
  test.skip(!CARD_TESTS_ON, "Card test — runs only via `node scripts/ops/card-tests.mjs <card>` on localhost (uses the local test login).");
}

/** The roles the Local test login box offers (src/app/api/dev/test-login/rules.ts). */
export type LocalRole = TestLoginRole;

/** Logins seeded only when their password is in .env.test (e2e-roles.mjs E2E_LOCAL_EXTRA_ROLES). */
const LOCAL_ONLY_ROLES: ReadonlySet<LocalRole> = new Set<LocalRole>(["owner2", "billing", "support"]);

/** Sign this page's browser context in as a seeded local test role (cookies land in the context). */
export async function loginLocal(page: Page, role: LocalRole): Promise<void> {
  // 60 s, not the config's 10 s action timeout: sign-in on a busy local dev server can take longer.
  const res = await page.request.post("/api/dev/test-login", { data: { role }, timeout: 60_000 });
  if (!res.ok()) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // R-2553: owner2 / billing / support are optional local-only logins. Not seeded on this machine
    // (412: no password in .env.test) → the step is SKIPPED with the fix, not shown as a red ✗.
    if (res.status() === 412 && LOCAL_ONLY_ROLES.has(role)) {
      test.skip(true, `Local test login "${role}" is not seeded here: ${body.error ?? "no password"} ` +
        "(add it to production/.env.test, then E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs — local DB only).");
    }
    throw new Error(
      `Local test login as ${role} answered ${res.status()}${body.error ? `: ${body.error}` : ""} — ` +
        "is localhost running with `npm run dev:local` and are the E2E test users seeded?",
    );
  }
}

/** A fresh browser context signed in as `role`. Close it when done. */
export async function pageAs(browser: Browser, baseURL: string | undefined, role: LocalRole): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await loginLocal(page, role);
  return page;
}

/** Open an app page like the owner would: not bounced to /login, no error boundary. */
export async function openAppPage(page: Page, path: string, heading?: RegExp): Promise<void> {
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/login/);
  if (heading) await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({ timeout: 60_000 });
  // Let the page's own data requests finish first — an error boundary or a row can appear after the heading.
  // Capped at 15 s: pages that poll never go idle, and the steps wait for their own data anyway.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => { /* polling page: judge what is there */ });
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
}

/**
 * Which of `names` appear on the page as a WHOLE element text (exact match) — not as a piece of
 * a longer name ("Ravi" inside "Ravi Traders" does not count).
 */
export async function namesShown(page: Page, names: readonly string[]): Promise<string[]> {
  const shown: string[] = [];
  for (const n of names) {
    if ((await page.locator("main").getByText(n, { exact: true }).count()) > 0) shown.push(n);
  }
  return shown;
}

/** Pathname of the page's current URL. */
export function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}
