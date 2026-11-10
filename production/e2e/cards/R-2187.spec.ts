/**
 * Card test — R-2187 "Dark mode ignores the OS setting when the user has made no choice" (R-2550).
 *
 * Before: ThemeProvider's defaultTheme was "light", so a laptop in dark mode still opened the app
 * light. Now the default is "system" (follows prefers-color-scheme, live), the header theme button
 * offers System / Light / Dark, and a Light/Dark pick wins over the OS.
 *
 * The OS setting is page.emulateMedia({ colorScheme }) — the same media query Windows dark mode
 * answers. Every <html> class the page ever had is recorded from the first byte (init script +
 * MutationObserver), so "no flash of light" is checked, not only the final state.
 * Run: `node scripts/ops/card-tests.mjs R-2187`.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

/** Records every class <html> gets, from the moment the document starts. */
const RECORD_HTML_CLASSES = () => {
  const w = window as unknown as { __htmlClasses: string[] };
  w.__htmlClasses = [];
  const take = () => w.__htmlClasses.push(document.documentElement.className);
  new MutationObserver(take).observe(document, { attributes: true, attributeFilter: ["class"], subtree: true });
};

const htmlClasses = (page: Page) =>
  page.evaluate(() => (window as unknown as { __htmlClasses: string[] }).__htmlClasses.filter(Boolean));
const isDark = (page: Page) => page.evaluate(() => document.documentElement.classList.contains("dark"));
const storedTheme = (page: Page) => page.evaluate(() => localStorage.getItem("theme"));

async function openThemeMenu(page: Page) {
  await page.locator('[data-topbar="theme"]').click();
  await expect(page.getByRole("menuitemradio", { name: "System" })).toBeVisible();
}

test.describe("R-2187 — theme follows the OS until the user picks Light or Dark", () => {
  onlyInCardTests();

  test("Step 1: OS in dark mode, no stored theme → the app opens dark (no light flash)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/dashboard");
      await page.evaluate(() => localStorage.removeItem("theme"));
      await page.addInitScript(RECORD_HTML_CLASSES);
      await openAppPage(page, "/dashboard");
      expect(await isDark(page)).toBe(true);
      const seen = await htmlClasses(page);
      expect(seen.length, "next-themes set a class on <html>").toBeGreaterThan(0);
      expect(seen.filter((c) => /\blight\b/.test(c)), `never light on the way: ${seen.join(" | ")}`).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: header theme button shows System / Light / Dark; Light wins over a dark OS, also after reload", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto("/dashboard");
      await page.evaluate(() => localStorage.removeItem("theme"));
      await openAppPage(page, "/dashboard");

      await openThemeMenu(page);
      const items = page.getByRole("menuitemradio");
      await expect(items).toHaveText(["System", "Light", "Dark"]);
      await expect(page.getByRole("menuitemradio", { name: "System" })).toHaveAttribute("aria-checked", "true");

      await page.getByRole("menuitemradio", { name: "Light" }).click();
      await expect.poll(() => isDark(page)).toBe(false);
      expect(await storedTheme(page)).toBe("light");

      await page.addInitScript(RECORD_HTML_CLASSES);
      await page.reload();
      await expect.poll(() => isDark(page)).toBe(false);
      const seen = await htmlClasses(page);
      expect(seen.filter((c) => /\bdark\b/.test(c)), `never dark after picking Light: ${seen.join(" | ")}`).toEqual([]);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: back on System → follows the OS live (dark → light → dark without reload)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await page.emulateMedia({ colorScheme: "light" });
      await page.goto("/dashboard");
      await page.evaluate(() => localStorage.setItem("theme", "dark"));
      await openAppPage(page, "/dashboard");
      expect(await isDark(page)).toBe(true);

      await openThemeMenu(page);
      await page.getByRole("menuitemradio", { name: "System" }).click();
      await expect.poll(() => isDark(page)).toBe(false); // OS is light
      expect(await storedTheme(page)).toBe("system");

      await page.emulateMedia({ colorScheme: "dark" });
      await expect.poll(() => isDark(page)).toBe(true);
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => isDark(page)).toBe(false);
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: outside the app (login, buy page) an OS in dark mode keeps the page light", async ({ browser, baseURL }) => {
    // Logged out, fresh browser: what a new visitor with a dark laptop sees.
    const context = await browser.newContext({ baseURL, colorScheme: "dark", viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
      for (const path of ["/login", "/buy/support"]) {
        await page.goto(path);
        await page.waitForLoadState("domcontentloaded");
        await expect.poll(() => isDark(page), { message: `${path} must stay light` }).toBe(false);
      }
    } finally {
      await context.close();
    }
  });
});
