/**
 * Card test — R-2924 "Tasks: the bell shows only my tasks, not everyone's".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2924
 *
 * Data (planted fresh on every run, removed after): two overdue tasks in E2E Test Co —
 * "CT R2924 sales follow-up" owned by the Sales login and "CT R2924 owner follow-up" owned by the Owner login.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const T_SALES = "c2924000-0000-4000-8000-000000000a01";
const T_OWNER = "c2924000-0000-4000-8000-000000000a02";
const SALES_TITLE = "CT R2924 sales follow-up";
const OWNER_TITLE = "CT R2924 owner follow-up";

const CLEAN = `delete from public.tasks where id in ('${T_SALES}', '${T_OWNER}');`;
const userId = (role: string) =>
  `(select u.id from public.users u where u.email = 'e2e-${role}@example.test' and u.tenant_id = ${E2E_TENANT_SQL})`;

function seed(): void {
  localDb("R-2924").psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, owner_id, title, kind, due_at, status)
    values ('${T_SALES}', ${E2E_TENANT_SQL}, ${userId("sales")}, '${SALES_TITLE}', 'followup', now() - interval '2 days', 'pending'),
           ('${T_OWNER}', ${E2E_TENANT_SQL}, ${userId("owner")}, '${OWNER_TITLE}', 'followup', now() - interval '2 days', 'pending');
    commit;`);
}

async function openBell(page: Page) {
  await openAppPage(page, "/tasks");
  const bell = page.getByRole("button", { name: /unread notifications/ });
  await expect(bell).toBeVisible({ timeout: 60_000 });
  await bell.click();
  const panel = page.getByRole("dialog", { name: "Notifications" });
  await expect(panel).toBeVisible({ timeout: 60_000 });
  return panel;
}

test.describe("R-2924 bell shows only my tasks", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2924").psql(CLEAN); });

  test("Step 1+2: Sales login — the bell lists the sales task, not the owner's, and has no Everyone switch", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "sales");
    try {
      const panel = await openBell(page);
      await onlyOne(panel.getByText(SALES_TITLE, { exact: true }), "the sales login's own task");
      await expect(panel.getByText(OWNER_TITLE, { exact: true })).toHaveCount(0);
      await expect(panel.getByRole("button", { name: "Everyone", exact: true })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Owner login — own task by default; Everyone shows the colleague's too", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const panel = await openBell(page);
      await panel.getByRole("button", { name: "Mine", exact: true }).click();
      await onlyOne(panel.getByText(OWNER_TITLE, { exact: true }), "the owner's own task");
      await expect(panel.getByText(SALES_TITLE, { exact: true })).toHaveCount(0);
      await panel.getByRole("button", { name: "Everyone", exact: true }).click();
      await onlyOne(panel.getByText(SALES_TITLE, { exact: true }), "the sales task in the team view");
      await onlyOne(panel.getByText(OWNER_TITLE, { exact: true }), "the owner's task in the team view");
      await panel.getByRole("button", { name: "Mine", exact: true }).click();
      await expect(panel.getByText(SALES_TITLE, { exact: true })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });
});
