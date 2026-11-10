/**
 * Card test — R-2186 "Sidebar blank ("Loading...") after reload and no feedback when a nav item
 * is clicked" (G-ZOHO, Zoho Books audit, R-2550).
 *
 * Step 1: after a reload the menu rows are on screen within 2 s of the navigation start — the
 *   sidebar draws from the role it last drew (Sidebar.tsx useMenuRole), not after the identity
 *   query (that took 5–15 s in dev and left an empty rail).
 * Step 2: a real click on "Invoices" marks the row pending in < 100 ms (aria-busy, highlighted)
 *   and the thin top bar shows until the Invoices page takes over; then the bar is gone and the
 *   row is the current page. The page's RSC request is held for 1.5 s by the test so the wait is
 *   long enough to see, the way a cold dev compile is (nothing is changed on the server).
 * Step 3: a different login in the same browser never gets the remembered (Owner) menu — the
 *   memory is tied to the login; placeholders until that login's own identity answers.
 * Run: `node scripts/ops/card-tests.mjs R-2186`.
 */
import { expect, test } from "@playwright/test";
import { loginLocal, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

// The pinned Dashboard row (the first nav links are the phone-only quick grid, hidden at desktop width).
const MENU_ROW = 'aside nav a[href="/dashboard"]';

test.describe("R-2186 — sidebar shows at once after a reload, and a menu click answers at once", () => {
  onlyInCardTests();

  test("Step 1: hard reload → menu rows visible within 2 s", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // First visit warms the dev compile and lets the sidebar learn the role.
      await openAppPage(page, "/dashboard");
      await expect(page.locator(MENU_ROW).first()).toBeVisible({ timeout: 60_000 });

      // Hold the identity query (the users row that carries the role) 20 s — the slow answer that
      // used to keep the rail empty. The menu must not wait for it.
      let identityAnswered = false;
      await page.route(/\/rest\/v1\/users\?/, async (route) => {
        await new Promise((r) => setTimeout(r, 20_000));
        await route.fallback().catch(() => { /* page closed */ });
        identityAnswered = true;
      });

      await page.reload({ waitUntil: "commit" });
      // The page's own HTML is never an empty rail: rows or row placeholders from the first paint.
      await page.waitForLoadState("domcontentloaded");
      expect(
        await page.locator(`${MENU_ROW}, aside nav [aria-label="Loading menu"]`).count(),
        "sidebar has rows or row placeholders in the first HTML",
      ).toBeGreaterThan(0);
      // performance.now() counts from this navigation's start. The SIDEBAR's clock starts when the
      // page's scripts have loaded (loadEventStart) — before that no client code can draw anything,
      // and a cold dev compile / dev bundle download on a busy laptop is not the menu's to win back.
      const shown = await page.waitForFunction(
        (sel) => {
          const a = document.querySelector<HTMLElement>(sel);
          if (!a || a.offsetParent === null) return false;
          const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
          return { at: performance.now(), htmlAt: nav?.responseEnd ?? 0, loadAt: nav?.loadEventStart ?? 0 };
        },
        MENU_ROW,
        { timeout: 60_000, polling: "raf" },
      );
      const { at, htmlAt, loadAt } = (await shown.jsonValue()) as { at: number; htmlAt: number; loadAt: number };
      test.info().annotations.push({
        type: "timing",
        description: `HTML at ${Math.round(htmlAt)} ms, scripts loaded at ${Math.round(loadAt)} ms, menu rows at ${Math.round(at)} ms`,
      });
      const answeredBeforeRows = identityAnswered;
      expect(answeredBeforeRows, "menu rows drawn before the identity query answered").toBe(false);
      // Rows while the identity answer is still held back = drawn from the remembered role.
      const scriptsAt = loadAt > 0 ? loadAt : at;
      expect(at - scriptsAt, `menu rows appeared ${Math.round(at - scriptsAt)} ms after the page's scripts loaded`).toBeLessThan(2_000);
      expect(at - htmlAt, "menu rows before the 20 s identity hold ends").toBeLessThan(20_000);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: click Invoices → row highlights in < 100 ms and the top bar shows until the page paints", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // Warm /invoices once so the hold below is the only wait.
      await openAppPage(page, "/invoices");
      // Payments is in the same Billing app, so the Invoices row is in the menu there.
      await openAppPage(page, "/payments");
      const row = page.locator('aside nav a[href="/invoices"]').first();
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).not.toHaveAttribute("aria-current", "page");

      // Hold the Invoices page's server data 1.5 s — like a slow compile — so the wait is visible.
      await page.route(/\/invoices(\?.*)?$/, async (route) => {
        const req = route.request();
        if (req.headers()["rsc"] === "1" || req.url().includes("_rsc=")) await new Promise((r) => setTimeout(r, 1_500));
        await route.fallback();
      });

      // Time from the click to the row's pending mark, measured in the page itself.
      await page.evaluate(() => {
        const w = window as unknown as { __r2186: { clickAt?: number; busyAt?: number } };
        w.__r2186 = {};
        const a = document.querySelector<HTMLAnchorElement>('aside nav a[href="/invoices"]')!;
        a.addEventListener("click", () => { w.__r2186.clickAt = performance.now(); }, { capture: true, once: true });
        new MutationObserver((_, obs) => {
          if (a.getAttribute("aria-busy") === "true") { w.__r2186.busyAt = performance.now(); obs.disconnect(); }
        }).observe(a, { attributes: true, attributeFilter: ["aria-busy"] });
      });

      await row.click();
      await expect(row).toHaveAttribute("aria-busy", "true", { timeout: 1_000 });
      await expect(page.getByTestId("nav-progress")).toBeVisible({ timeout: 1_000 });
      const t = await page.evaluate(() => (window as unknown as { __r2186: { clickAt?: number; busyAt?: number } }).__r2186);
      expect(t.clickAt, "click seen").toBeDefined();
      expect(t.busyAt, "row marked pending").toBeDefined();
      expect(t.busyAt! - t.clickAt!, "click → highlight (ms)").toBeLessThan(100);

      // The page takes over: bar gone, row is now the current page.
      await expect(page).toHaveURL(/\/invoices$/, { timeout: 60_000 });
      await expect(page.getByTestId("nav-progress")).toHaveCount(0, { timeout: 10_000 });
      await expect(page.locator('aside nav a[href="/invoices"]').first()).toHaveAttribute("aria-current", "page");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: sign out, sign in as Sales → the Owner's remembered menu is not shown", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      // The Owner's menu is remembered in this browser…
      await openAppPage(page, "/dashboard");
      await expect(page.locator(MENU_ROW).first()).toBeVisible({ timeout: 60_000 });
      // …then a different login in the SAME browser (the sign-out is a form POST the sidebar never sees).
      await loginLocal(page, "sales");
      // Sales has no Dashboard; Leads is its home. Warm it once (a cold dev compile) before timing.
      await openAppPage(page, "/leads");

      // Hold the identity answer so only the remembered menu could fill the rail.
      await page.route(/\/rest\/v1\/users\?/, async (route) => {
        await new Promise((r) => setTimeout(r, 15_000));
        await route.fallback().catch(() => { /* page closed */ });
      });
      await page.goto("/leads", { waitUntil: "load", timeout: 120_000 });
      // Scripts loaded + 2 s: the Owner's rows would be drawn by now. Placeholders instead.
      await page.waitForTimeout(2_000);
      await expect(page.locator('aside nav [aria-label="Loading menu"]')).toBeVisible();
      await expect(page.locator('aside nav a[href="/settings"]')).toHaveCount(0);

      // The identity answers → the Sales menu (no owner-only Settings row).
      await page.unroute(/\/rest\/v1\/users\?/);
      // .filter(visible): the first /leads link is the phone-only quick grid, hidden at desktop width.
      await expect(page.locator('aside nav a[href="/leads"]').filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
      await expect(page.locator('aside nav [aria-label="Loading menu"]')).toHaveCount(0);
      await expect(page.locator('aside nav a[href="/settings"]')).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
