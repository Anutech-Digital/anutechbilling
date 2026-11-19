/**
 * Card test — R-2939 "Tasks sub-tabs (Overview · List · Calendar · Team) on every Tasks page +
 * Tasks moved up in the sidebar".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2939` (no migration, no planted data — the tabs and
 * the sidebar row do not depend on any task existing).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, onlyOne, openAppPage, pageAs, pathOf } from "./card-steps";

/** The sidebar's own menu (desktop rail) — not the Tasks tab strip, which is a <nav> too. */
const sidebar = (page: Page): Locator => page.locator("aside nav");
/** The tab strip at the top of a Tasks page. */
const tabs = (page: Page): Locator => page.getByRole("navigation", { name: "Tasks views" });

const TABS = [
  { label: "Overview", path: "/tasks/overview", heading: /Tasks overview/ },
  { label: "List", path: "/tasks", heading: /^Tasks$/ },
  { label: "Calendar", path: "/tasks/calendar", heading: /Task calendar/ },
  { label: "Team", path: "/reports/team-tasks", heading: /Team tasks/ },
] as const;

/** The labels of the tabs shown, left to right — waits for the strip first. */
async function tabLabels(page: Page): Promise<string[]> {
  const strip = await onlyOne(tabs(page), "the Tasks tab strip");
  await expect(strip.getByRole("link", { name: "List", exact: true })).toBeVisible({ timeout: 60_000 });
  return (await strip.getByRole("link").allInnerTexts()).map((t) => t.trim());
}

test.describe("R-2939 — Tasks tabs on every Tasks page, Tasks at the top of the sidebar", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let owner: Page;
  let sales: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    owner = await pageAs(browser, baseURL, "owner");
    await owner.setViewportSize({ width: 1280, height: 800 });
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await owner?.context().close();
    await sales?.context().close();
  });

  test("Step 1: Owner — Tasks is at the top of the sidebar, right after Today, and opens the list", async () => {
    await openAppPage(owner, "/today");
    const menu = sidebar(owner);
    const tasksRow = menu.locator('a[href="/tasks"]').filter({ hasText: "Tasks" });
    await expect(tasksRow.first()).toBeVisible({ timeout: 60_000 });
    // Its place: the row straight after Today, before Dashboard.
    // Row links only — a count badge is its own link to a filtered view (…?tab=…), skip those.
    const hrefs = (await menu.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))
      .filter((h) => !h.includes("?"));
    const today = hrefs.indexOf("/today");
    expect(today, "Today is in the sidebar").toBeGreaterThanOrEqual(0);
    expect(hrefs[today + 1], "the row after Today").toBe("/tasks");
    expect(hrefs.indexOf("/dashboard"), "Dashboard comes after Tasks").toBeGreaterThan(today + 1);
    await tasksRow.first().click();
    await expect.poll(() => pathOf(owner), { timeout: 60_000 }).toBe("/tasks");
    await expect(owner.getByRole("heading", { name: /^Tasks$/ }).first()).toBeVisible({ timeout: 60_000 });
  });

  test("Step 2: Overview · List · Calendar · Team tabs — each opens its page and is the highlighted one", async () => {
    expect(await tabLabels(owner)).toEqual(["Overview", "List", "Calendar", "Team"]);
    // On the list, List is the marked tab.
    await expect(tabs(owner).getByRole("link", { name: "List", exact: true })).toHaveAttribute("aria-current", "page");

    for (const tab of [TABS[0], TABS[2], TABS[3], TABS[1]]) {
      const link = tabs(owner).getByRole("link", { name: tab.label, exact: true });
      await expect(link).toBeVisible({ timeout: 60_000 });
      await link.click();
      await expect.poll(() => pathOf(owner), { timeout: 60_000, message: `${tab.label} opens ${tab.path}` }).toBe(tab.path);
      await expect(owner.getByRole("heading", { name: tab.heading }).first()).toBeVisible({ timeout: 60_000 });
      // The same four tabs on this page too, and only this one is marked.
      expect(await tabLabels(owner), `tabs on ${tab.path}`).toEqual(["Overview", "List", "Calendar", "Team"]);
      await expect(tabs(owner).getByRole("link", { name: tab.label, exact: true })).toHaveAttribute("aria-current", "page");
      await expect(tabs(owner).locator('a[aria-current="page"]')).toHaveCount(1);
      // No sideways scroll at 1280.
      expect(await owner.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${tab.path} fits 1280`).toBe(true);
      // One way to the list: the old "List view" button is gone.
      await expect(owner.locator("main").getByRole("link", { name: "List view" })).toHaveCount(0);
    }

    // Keyboard: a tab takes focus and Enter opens it.
    await tabs(owner).getByRole("link", { name: "Calendar", exact: true }).focus();
    await owner.keyboard.press("Enter");
    await expect.poll(() => pathOf(owner), { timeout: 60_000 }).toBe("/tasks/calendar");
  });

  test("Step 3: Sales — Tasks shows Overview, List and Calendar, no Team tab", async ({ browser, baseURL }) => {
    sales = await pageAs(browser, baseURL, "sales");
    await sales.setViewportSize({ width: 1280, height: 800 });
    await openAppPage(sales, "/tasks", /^Tasks$/);
    expect(await tabLabels(sales)).toEqual(["Overview", "List", "Calendar"]);
    await expect(tabs(sales).getByRole("link", { name: "Team" })).toHaveCount(0);
    // Tasks is in the sales menu too, at the top.
    await expect(sidebar(sales).locator('a[href="/tasks"]').first()).toBeVisible({ timeout: 60_000 });
    // The three tabs work for sales as well.
    await tabs(sales).getByRole("link", { name: "Overview", exact: true }).click();
    await expect.poll(() => pathOf(sales), { timeout: 60_000 }).toBe("/tasks/overview");
    expect(await tabLabels(sales)).toEqual(["Overview", "List", "Calendar"]);
  });
});
