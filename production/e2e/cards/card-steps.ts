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

/** True only inside `node scripts/ops/card-tests.mjs`. */
export const CARD_TESTS_ON = process.env.CARD_TESTS === "1";

/** Call at the top of every card spec's describe. */
export function onlyInCardTests() {
  test.skip(!CARD_TESTS_ON, "Card test — runs only via `node scripts/ops/card-tests.mjs <card>` on localhost (uses the local test login).");
}

/** The roles the Local test login box offers (src/app/api/dev/test-login/rules.ts). */
export type LocalRole = "owner" | "manager" | "accountant" | "sales" | "owner2";

/** Sign this page's browser context in as a seeded local test role (cookies land in the context). */
export async function loginLocal(page: Page, role: LocalRole): Promise<void> {
  const res = await page.request.post("/api/dev/test-login", { data: { role } });
  if (!res.ok()) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
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
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
}

/** Pathname of the page's current URL. */
export function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}
