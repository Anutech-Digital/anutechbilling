/**
 * Card test — R-2926 "Tasks: Priority (Low / Medium / High)".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2926
 *
 * Data: one planted Medium task "CT R2926 medium earlier" due in 2 days (so the Upcoming group is
 * not empty and has an EARLIER task). The Owner login then adds "CT R2926 high later" (due in 5 days,
 * same group) with Priority = High through Tasks > Add task.
 * Both are removed after.
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const HIGH = "CT R2926 high later";
const MEDIUM = "CT R2926 medium earlier";
const T_MEDIUM = "c2926000-0000-4000-8000-000000000a01";
const OWNER = `(select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = ${E2E_TENANT_SQL})`;

const CLEAN = `delete from public.tasks where tenant_id = ${E2E_TENANT_SQL} and (id = '${T_MEDIUM}' or title = '${HIGH}');`;

test.describe("R-2926 task priority", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    localDb("R-2926").psql(`
      begin;
      ${CLEAN}
      insert into public.tasks (id, tenant_id, owner_id, title, kind, due_at, status)
      values ('${T_MEDIUM}', ${E2E_TENANT_SQL}, ${OWNER}, '${MEDIUM}', 'followup', now() + interval '2 days', 'pending');
      commit;`);
  });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2926").psql(CLEAN); });

  test("Step 1+2: Add task with Priority = High — the row shows a red 'High' badge and sits above a Medium task of its group", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks?tab=upcoming");
      const add = page.getByRole("button", { name: "Add task" }).first();
      await expect(add).toBeVisible({ timeout: 60_000 });
      await add.click();
      const dlg = page.getByRole("dialog", { name: "Add follow-up task" });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await fillKept(dlg.locator("#title"), HIGH);
      // Due in 5 days: later than the planted Medium task, same group (Upcoming).
      const due = new Date(Date.now() + 5 * 24 * 3600 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      await fillKept(dlg.locator("#due_at"), `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T10:00`);
      await dlg.locator("#priority").click();
      await page.getByRole("option", { name: "High", exact: true }).click();
      await dlg.getByRole("button", { name: "Schedule" }).click();
      await expect(dlg).toBeHidden({ timeout: 60_000 });

      const main = page.getByRole("main");
      const highRow = await onlyOne(main.getByRole("listitem").filter({ hasText: HIGH }), "the High task's row");
      await onlyOne(highRow.getByText("High", { exact: true }), "the High badge");
      const mediumRow = await onlyOne(main.getByRole("listitem").filter({ hasText: MEDIUM }), "the Medium task's row");
      // Medium is the default: no badge on its row.
      await expect(mediumRow.getByText("Medium", { exact: true })).toHaveCount(0);

      // High is above Medium although it is due later.
      const titles = await main.getByRole("listitem").allInnerTexts();
      const iHigh = titles.findIndex((t) => t.includes(HIGH));
      const iMedium = titles.findIndex((t) => t.includes(MEDIUM));
      expect(iHigh).toBeGreaterThanOrEqual(0);
      expect(iHigh).toBeLessThan(iMedium);

      // The colour is the app's red badge (not only the word).
      const badgeClass = await highRow.getByText("High", { exact: true }).getAttribute("class");
      expect(badgeClass).toContain("bg-rose-soft");

      expect(localDb("R-2926").one(`select priority from public.tasks where tenant_id = ${E2E_TENANT_SQL} and title = '${HIGH}';`)).toBe("high");
    } finally {
      await page.context().close();
    }
  });
});
