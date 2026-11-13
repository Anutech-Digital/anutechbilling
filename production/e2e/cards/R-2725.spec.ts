/**
 * Card test — R-2725 "Employees: remove 'Scorecards' from the menu; show the Score in the
 * Employees table and link the scorecard from the employee profile" (Hitesh, 12 Nov 2026).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2725`.
 *
 * Data: a score belongs to a LOGIN, so the steps need one employee with a linked login. The
 * local company normally has one ("E2E Sales (demo)" ↔ E2E Sales). If no login is linked,
 * beforeAll links the E2E Sales login to the first active employee on the LOCAL docker DB
 * (localDb guard) and afterAll puts it back — nothing else is written.
 */
import { expect, test, type Page } from "@playwright/test";
import { E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, pathOf, waitForHydrated } from "./card-steps";

const CARD = "R-2725";
/** Set only when THIS run made the link (so afterAll undoes exactly that). */
let plantedLinkUser: string | null = null;
let linked = { employee: "", userId: "" };
let unlinkedEmployee = "";

/** The Employees table row whose name cell is exactly `name`. */
function employeeRow(page: Page, name: string) {
  return page.locator("main table tbody tr").filter({ has: page.locator("td:first-child .font-medium", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") }) });
}

async function openEmployees(page: Page) {
  await openAppPage(page, "/accounting/employees", /^Employees$/);
  await waitForHydrated(page, page.locator("main table tbody tr"));
}

test.describe("R-2725 — Score on the Employees table, Scorecards off the menu", () => {
  onlyInCardTests();

  test.beforeAll(() => {
    const db = localDb(CARD);
    const pick = () => db.one(
      `select e.name || '|' || u.id from public.users u join public.employees e on e.id = u.employee_id
        where u.tenant_id = ${E2E_TENANT_SQL} and u.is_active is not false and e.is_active
          and u.role in ('owner','manager','sales','accountant','billing','support')
        order by e.name limit 1`);
    let row = pick();
    if (!row) {
      const userId = db.one(`select id from public.users where tenant_id = ${E2E_TENANT_SQL} and full_name = 'E2E Sales' and employee_id is null limit 1`);
      const empId = db.one(`select id from public.employees where tenant_id = ${E2E_TENANT_SQL} and is_active order by name limit 1`);
      if (!/^[0-9a-f-]{36}$/.test(userId) || !/^[0-9a-f-]{36}$/.test(empId)) throw new Error("R-2725: E2E Test Co has no E2E Sales login or no active employee — seed the local test company first");
      db.psql(`update public.users set employee_id = '${empId}' where id = '${userId}' and tenant_id = ${E2E_TENANT_SQL}`);
      plantedLinkUser = userId;
      row = pick();
    }
    const [name, userId] = row.split("|");
    linked = { employee: name, userId };
    unlinkedEmployee = db.one(
      `select e.name from public.employees e where e.tenant_id = ${E2E_TENANT_SQL}
        and not exists (select 1 from public.users u where u.employee_id = e.id) order by e.name limit 1`);
  });

  test.afterAll(() => {
    if (!plantedLinkUser) return;
    localDb(CARD).psql(`update public.users set employee_id = null where id = '${plantedLinkUser}' and tenant_id = ${E2E_TENANT_SQL}`);
    plantedLinkUser = null;
  });

  test("Step 1: Owner — the menu has no Scorecards row (Team → Employees & Users still lists Team Performance)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      const nav = page.getByRole("navigation").first();
      // The Employees & Users accordion is open on its own page — its other children show.
      await expect(nav.getByRole("link", { name: "Team Performance" })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByRole("navigation").getByRole("link", { name: /^Scorecards?$/ })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Owner — Score column shows the same number as that person's scorecard, and clicking it opens it", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      await expect(page.locator("main table thead").getByRole("button", { name: "Score" })).toBeVisible({ timeout: 60_000 });
      const row = await onlyOne(employeeRow(page, linked.employee), `row of ${linked.employee}`);
      const scoreLink = await onlyOne(row.getByRole("link", { name: /score \d+ — open scorecard/i }), "the score link");
      const shown = (await scoreLink.innerText()).trim();
      expect(shown).toMatch(/^\d+$/);
      await scoreLink.click();
      await expect(page).toHaveURL(new RegExp(`/scorecard\\?user=${linked.userId}$`), { timeout: 60_000 });
      // That person only, and the SAME number.
      const score = await onlyOne(page.locator('main [data-testid^="scorecard-score-"]'), "one scorecard on the page");
      await expect(score).toHaveAttribute("data-testid", `scorecard-score-${linked.userId}`);
      await expect(score).toHaveText(shown);
      await expect(page.getByRole("link", { name: "All scorecards" })).toBeVisible();
      test.info().annotations.push({ type: "note", description: `${linked.employee}: Score ${shown} on the table = ${shown} on the scorecard` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Owner — an employee with no linked login shows — (not 0)", async ({ browser, baseURL }) => {
    test.skip(!unlinkedEmployee, "every local employee has a linked login — nothing to show '—' for");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      const row = await onlyOne(employeeRow(page, unlinkedEmployee), `row of ${unlinkedEmployee}`);
      await expect(row.getByLabel(/no score, no active login linked/i)).toHaveText("—", { timeout: 60_000 });
      await expect(row.getByRole("link", { name: /open scorecard/i })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: Owner — at 1280 px the table fits: no sideways scroll, Actions column on screen; Score sorts", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner"); // pageAs opens a 1280 x 900 window
    try {
      await openEmployees(page);
      const table = await onlyOne(page.locator("main table"), "the Employees table");
      await expect(table.getByRole("link", { name: /open scorecard/i }).first()).toBeVisible({ timeout: 60_000 });
      const fit = await table.evaluate((t) => {
        const card = t.parentElement!;
        const lastTh = t.querySelector("thead th:last-child")!.getBoundingClientRect();
        return { tableW: Math.round(t.getBoundingClientRect().width), cardW: card.clientWidth, cardScroll: card.scrollWidth,
          actionsRight: Math.round(lastTh.right), viewport: window.innerWidth, pageScroll: document.documentElement.scrollWidth };
      });
      expect(fit.cardScroll, JSON.stringify(fit)).toBeLessThanOrEqual(fit.cardW);
      expect(fit.actionsRight, JSON.stringify(fit)).toBeLessThanOrEqual(fit.viewport);
      expect(fit.pageScroll, JSON.stringify(fit)).toBeLessThanOrEqual(fit.viewport);
      // Sort: highest score first, people with no score last.
      await table.getByRole("button", { name: "Score" }).click();
      await expect(table.locator("thead th[aria-sort='descending']")).toHaveCount(1);
      const cells = (await table.locator("tbody tr td:nth-child(5)").allInnerTexts()).map((s) => s.trim());
      const nums = cells.filter((c) => /^\d+$/.test(c)).map(Number);
      expect(nums, cells.join(",")).toEqual([...nums].sort((a, b) => b - a));
      expect(cells.slice(0, nums.length).every((c) => /^\d+$/.test(c)), `scored rows first: ${cells.join(",")}`).toBe(true);
    } finally {
      await page.context().close();
    }
  });

  test("Step 5: Owner — the employee profile has a Scorecard button that opens that employee's scorecard", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openEmployees(page);
      const row = await onlyOne(employeeRow(page, linked.employee), `row of ${linked.employee}`);
      await expect(row.getByRole("link", { name: /open scorecard/i })).toBeVisible({ timeout: 60_000 });
      await row.locator("td:first-child").click();
      const profile = page.getByRole("dialog", { name: new RegExp(linked.employee.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i") });
      const btn = await onlyOne(profile.getByRole("link", { name: "Scorecard" }), "the Scorecard button");
      await expect(btn).toBeVisible({ timeout: 60_000 });
      await expect(profile.getByRole("button", { name: "Edit" })).toBeVisible(); // it sits with the profile actions
      await btn.click();
      await expect(page).toHaveURL(new RegExp(`/scorecard\\?user=${linked.userId}$`), { timeout: 60_000 });
      await expect(page.locator(`main [data-testid="scorecard-score-${linked.userId}"]`)).toBeVisible({ timeout: 60_000 });
    } finally {
      await page.context().close();
    }
  });

  test("Step 6: an old /scorecard link still opens for Owner and Manager (everyone listed); Sales is bounced", async ({ browser, baseURL }) => {
    for (const role of ["owner", "manager"] as const) {
      const page = await pageAs(browser, baseURL, role);
      try {
        await openAppPage(page, "/scorecard", /^Scorecards$/);
        expect(pathOf(page)).toBe("/scorecard");
        await expect(page.locator('main [data-testid^="scorecard-score-"]').nth(1)).toBeVisible({ timeout: 60_000 });
        await expect(page.getByRole("link", { name: "All scorecards" })).toHaveCount(0);
      } finally {
        await page.context().close();
      }
    }
    const sales = await pageAs(browser, baseURL, "sales");
    try {
      await sales.goto("/scorecard");
      await expect(sales).not.toHaveURL(/\/scorecard/, { timeout: 60_000 });
    } finally {
      await sales.context().close();
    }
  });

  test("Step 7: Accountant — sees Employees but no Score column (cannot open scorecards)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "accountant");
    try {
      await openEmployees(page);
      await expect(page.locator("main table thead th", { hasText: "Status" })).toBeVisible({ timeout: 60_000 });
      await expect(page.locator("main table thead th", { hasText: "Score" })).toHaveCount(0);
      await expect(page.locator("main table").getByRole("link", { name: /open scorecard/i })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
