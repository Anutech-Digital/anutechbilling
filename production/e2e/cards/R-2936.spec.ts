/**
 * Card test — R-2936 "Tasks Overview page" (/tasks/overview).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2936` (no migration).
 *
 * Planted fresh on every run and removed after it (fixed ids, local docker DB only): three open
 * tasks of E2E Test Co — one overdue since yesterday, one High-priority task due in 20 minutes
 * (the soonest task ahead, so it is in "Upcoming") and one Low-priority task due in 40 days
 * (tasks.due_at is NOT NULL — a task always has a due time).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2936";
const TASK_OVERDUE = "c2936000-0000-4000-8000-000000000001";
const TASK_SOON = "c2936000-0000-4000-8000-000000000002";
const TASK_LATER = "c2936000-0000-4000-8000-000000000003";
const TITLE_OVERDUE = "CT R2936 Chase the overdue payment";
const TITLE_SOON = "CT R2936 Call the overview customer";
const TITLE_LATER = "CT R2936 Tidy the price list";
const T = E2E_TENANT_SQL;

const CLEAN = `delete from public.tasks where tenant_id = ${T} and id in ('${TASK_OVERDUE}', '${TASK_SOON}', '${TASK_LATER}');`;

function seed(): void {
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, title, kind, status, priority, due_at) values
      ('${TASK_OVERDUE}', ${T}, '${TITLE_OVERDUE}', 'followup', 'pending', 'medium', now() - interval '1 day'),
      ('${TASK_SOON}', ${T}, '${TITLE_SOON}', 'call', 'pending', 'high', now() + interval '20 minutes'),
      ('${TASK_LATER}', ${T}, '${TITLE_LATER}', 'custom', 'pending', 'low', now() + interval '40 days');
    commit;`);
}

/** The whole number a card shows — waits for it (a card shows a shimmer while loading). */
async function numberIn(scope: ReturnType<Page["locator"]>): Promise<number> {
  await expect(scope).toHaveText(/\d/, { timeout: 60_000 });
  const text = (await scope.innerText()).replace(/,/g, "");
  const m = /\d+/.exec(text);
  if (!m) throw new Error(`no number in "${text}"`);
  return Number(m[0]);
}

test.describe("R-2936 — Tasks Overview page", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 800 });
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
  });

  test("Step 1: Tasks > Overview opens with the four cards, and fits 1280 px", async () => {
    await openAppPage(page, "/tasks/overview", /Tasks overview/);
    const cards = page.getByTestId("overview-cards");
    for (const label of ["Open", "Overdue", "Due today", "Done this week"]) {
      await expect(cards.getByRole("link", { name: new RegExp(`^${label}`) })).toBeVisible({ timeout: 60_000 });
    }
    // The three planted tasks are open; one of them is overdue.
    await expect.poll(() => numberIn(cards.getByRole("link", { name: /^Open/ })), { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    expect(await numberIn(cards.getByRole("link", { name: /^Overdue/ }))).toBeGreaterThanOrEqual(1);
    // No sideways scroll at 1280.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    /* R-2942: Overview is a tab on the Tasks pages (R-2939 took its row out of the sidebar). The
       old line looked for the link in ANY <nav>, so the tab strip passed it by accident — check
       the strip by name: one Overview tab, to this page, marked as the open one; and the sidebar
       has the Tasks row but no Overview row under it. */
    const tabs = await onlyOne(page.getByRole("navigation", { name: "Tasks views" }), "the Tasks tab strip");
    const overviewTab = await onlyOne(tabs.getByRole("link", { name: "Overview", exact: true }), "the Overview tab");
    await expect(overviewTab).toHaveAttribute("href", "/tasks/overview");
    await expect(overviewTab).toHaveAttribute("aria-current", "page");
    const sidebar = page.locator("aside nav");
    await expect(sidebar.locator('a[href="/tasks"]').filter({ hasText: "Tasks" }).first()).toBeVisible({ timeout: 60_000 });
    await expect(sidebar.locator('a[href="/tasks/overview"]')).toHaveCount(0);
  });

  test("Step 2: two donuts (status, priority) whose lines add up to Open, and the due strip", async () => {
    const open = await numberIn(page.getByTestId("overview-cards").getByRole("link", { name: /^Open/ }));
    for (const id of ["overview-status", "overview-priority"]) {
      const donut = page.getByTestId(id);
      await expect(donut.getByRole("img")).toBeVisible({ timeout: 60_000 });
      const lines = donut.getByRole("link");
      await expect(lines).toHaveCount(3);
      let sum = 0;
      for (let i = 0; i < 3; i++) sum += Number(/: (\d+) open/.exec((await lines.nth(i).getAttribute("aria-label")) ?? "")?.[1] ?? NaN);
      expect(sum, `${id} lines add up to the Open card`).toBe(open);
    }
    const priority = page.getByTestId("overview-priority");
    expect(Number(/: (\d+) open/.exec((await priority.getByRole("link", { name: /^High:/ }).getAttribute("aria-label")) ?? "")?.[1])).toBeGreaterThanOrEqual(1);
    expect(Number(/: (\d+) open/.exec((await priority.getByRole("link", { name: /^Low:/ }).getAttribute("aria-label")) ?? "")?.[1])).toBeGreaterThanOrEqual(1);

    const due = page.getByTestId("overview-due");
    for (const label of ["Overdue", "Today", "This week", "This month"]) {
      await expect(due.getByRole("link", { name: new RegExp(`^${label}:`) })).toBeVisible();
    }
  });

  test("Step 3: Upcoming and Newly added list the planted tasks", async () => {
    const upcoming = page.getByTestId("overview-upcoming");
    await onlyOne(upcoming.getByText(TITLE_SOON), "the soon task in Upcoming");
    await expect(upcoming.getByText(TITLE_OVERDUE)).toHaveCount(0); // an overdue task is not "upcoming"
    await expect(upcoming.locator("li")).not.toHaveCount(0);
    expect(await upcoming.locator("li").count()).toBeLessThanOrEqual(5);

    const newest = page.getByTestId("overview-new");
    for (const title of [TITLE_OVERDUE, TITLE_SOON, TITLE_LATER]) await onlyOne(newest.getByText(title), `${title} in Newly added`);
    expect(await newest.locator("li").count()).toBeLessThanOrEqual(5);
  });

  test("Step 4: the Overdue card opens the Tasks list on its Overdue tab with the same count", async () => {
    const card = page.getByTestId("overview-cards").getByRole("link", { name: /^Overdue/ });
    const overdue = await numberIn(card);
    await card.click();
    await expect(page).toHaveURL(/\/tasks\?tab=overdue/, { timeout: 60_000 });
    await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible({ timeout: 60_000 });
    await onlyOne(page.getByRole("main").getByText(TITLE_OVERDUE), "the overdue task in the Tasks list");
    await expect(page.getByRole("main").getByText(TITLE_SOON)).toHaveCount(0);
    await expect(page.getByRole("tab", { name: /Overdue/ }).first()).toHaveText(new RegExp(`(^|\\D)${overdue}(\\D|$)`));
  });

  test("Step 5: a task name in Upcoming opens that task in the Tasks list", async () => {
    await openAppPage(page, "/tasks/overview", /Tasks overview/);
    const row = page.getByTestId("overview-upcoming").getByRole("link", { name: new RegExp(TITLE_SOON) });
    await expect(row).toBeVisible({ timeout: 60_000 });
    await row.click();
    await expect(page).toHaveURL(new RegExp(`/tasks\\?task=${TASK_SOON}`), { timeout: 60_000 });
    const dlg = page.getByRole("dialog");
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    await expect(dlg.locator("#title")).toHaveValue(TITLE_SOON);
  });
});
