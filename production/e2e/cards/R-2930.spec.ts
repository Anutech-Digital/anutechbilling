/**
 * Card test — R-2930 "Tasks page: search, This week / Later, summary cards".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2930
 *
 * Data (planted fresh, removed after), all owned by the Owner login:
 *   "CT R2930 alpha call"  — overdue (3 days ago)
 *   "CT R2930 beta visit"  — due in 40 days (always "Later")
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const ALPHA = "CT R2930 alpha call";
const BETA = "CT R2930 beta visit";
const IDS = ["c2930000-0000-4000-8000-000000000a01", "c2930000-0000-4000-8000-000000000a02"];
const OWNER = `(select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = ${E2E_TENANT_SQL})`;
const CLEAN = `delete from public.tasks where id in ('${IDS[0]}', '${IDS[1]}');`;

/** Open the Summary strip (it is closed by default and remembers the choice). */
async function openSummary(page: Page): Promise<void> {
  const toggle = page.locator('[data-kpi-strip="tasks"]').getByRole("button", { name: /Summary/ });
  await expect(toggle).toBeVisible({ timeout: 60_000 });
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
    await expect(page.getByTestId("task-summary")).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
}

/** The number on a summary card. */
async function cardValue(page: Page, label: string): Promise<number> {
  const card = page.getByTestId("task-summary").getByRole("button", { name: new RegExp(`^${label}\\b`) });
  await expect(card).toBeVisible({ timeout: 60_000 });
  const text = (await card.innerText()).replace(label, "");
  return Number((text.match(/\d+/) ?? ["NaN"])[0]);
}
async function tabCount(page: Page, name: RegExp): Promise<number> {
  return Number(((await page.getByRole("tab", { name }).first().innerText()).match(/\d+/) ?? ["0"])[0]);
}

test.describe("R-2930 Tasks search + summary cards", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    localDb("R-2930").psql(`
      begin;
      ${CLEAN}
      insert into public.tasks (id, tenant_id, owner_id, title, kind, due_at, status)
      values ('${IDS[0]}', ${E2E_TENANT_SQL}, ${OWNER}, '${ALPHA}', 'call', now() - interval '3 days', 'pending'),
             ('${IDS[1]}', ${E2E_TENANT_SQL}, ${OWNER}, '${BETA}', 'meeting', now() + interval '40 days', 'pending');
      commit;`);
  });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2930").psql(CLEAN); });

  test("Step 1: the four cards show, and agree with the tabs; a card opens its tab", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks");
      await onlyOne(page.getByRole("main").getByRole("listitem").filter({ hasText: ALPHA }), "the overdue task's row");
      // Closed, the Summary line itself carries the four numbers.
      const strip = page.locator('[data-kpi-strip="tasks"]');
      for (const label of ["Open", "Overdue", "Today", "Done this week"]) await expect(strip.getByText(new RegExp(`^${label} \\d+`))).toBeVisible({ timeout: 60_000 });
      await openSummary(page);
      const overdue = await cardValue(page, "Overdue");
      const today = await cardValue(page, "Today");
      const open = await cardValue(page, "Open");
      expect(Number.isNaN(await cardValue(page, "Done this week"))).toBe(false);
      expect(overdue).toBeGreaterThanOrEqual(1);
      expect(overdue).toBe(await tabCount(page, /^Overdue/));
      expect(today).toBe(await tabCount(page, /^Today/));
      expect(open).toBe(overdue + today + (await tabCount(page, /^Upcoming/)));

      // "Later" holds the task due in 40 days.
      const later = page.locator("section", { has: page.locator("#task-group-later") });
      await onlyOne(later.getByRole("listitem").filter({ hasText: BETA }), "the far task under Later");

      await page.getByTestId("task-summary").getByRole("button", { name: /^Overdue\b/ }).click();
      await expect(page).toHaveURL(/tab=overdue/);
      await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: BETA })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: typing a task's name in Search leaves only that task", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks");
      const main = page.getByRole("main");
      await onlyOne(main.getByRole("listitem").filter({ hasText: BETA }), "the far task before searching");
      await fillKept(page.getByRole("searchbox", { name: "Search tasks" }), "R2930 alpha");
      await onlyOne(main.getByRole("listitem").filter({ hasText: ALPHA }), "the searched task");
      await expect(main.getByRole("listitem")).toHaveCount(1);
      await openSummary(page);
      expect(await cardValue(page, "Open")).toBe(1); // the cards follow the search too

      await fillKept(page.getByRole("searchbox", { name: "Search tasks" }), "zz-no-such-task-zz");
      await expect(main.getByText("No tasks match")).toBeVisible({ timeout: 30_000 });
      await main.getByRole("button", { name: "Clear search" }).click();
      await onlyOne(main.getByRole("listitem").filter({ hasText: BETA }), "the far task after clearing");
    } finally {
      await page.context().close();
    }
  });
});
