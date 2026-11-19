/**
 * Card test — R-2927 "Tasks: In progress / On hold, changed straight from the row".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2927
 *
 * Data (planted fresh, removed after): one overdue task "CT R2927 overdue call" owned by the Owner login.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const TITLE = "CT R2927 overdue call";
const T = "c2927000-0000-4000-8000-000000000a01";
const OWNER = `(select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = ${E2E_TENANT_SQL})`;
const CLEAN = `delete from public.tasks where id = '${T}';`;

/** The numbers on the Overdue and Today tabs. */
async function tabCounts(page: Page): Promise<{ overdue: string; today: string }> {
  const read = async (name: RegExp) => ((await page.getByRole("tab", { name }).first().innerText()).match(/\d+/) ?? ["0"])[0];
  return { overdue: await read(/^Overdue/), today: await read(/^Today/) };
}

test.describe("R-2927 status from the row", () => {
  onlyInCardTests();
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    localDb("R-2927").psql(`
      begin;
      ${CLEAN}
      insert into public.tasks (id, tenant_id, owner_id, title, kind, due_at, status)
      values ('${T}', ${E2E_TENANT_SQL}, ${OWNER}, '${TITLE}', 'call', now() - interval '3 days', 'pending');
      commit;`);
  });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2927").psql(CLEAN); });

  test("Step 1+2: pick 'In progress' on the row — the task stays where it is, shows 'In progress', counts do not move", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks");
      const main = page.getByRole("main");
      const row = await onlyOne(main.getByRole("listitem").filter({ hasText: TITLE }), "the planted task's row");
      const before = await tabCounts(page);

      const status = row.getByRole("button", { name: /^Status: Not started/ });
      await expect(status).toBeVisible({ timeout: 60_000 });
      await status.click();
      await page.getByRole("menuitemcheckbox", { name: "In progress", exact: true }).click();

      await expect(row.getByRole("button", { name: /^Status: In progress/ })).toBeVisible({ timeout: 60_000 });
      // Still in the Overdue group, same counts.
      const overdue = page.locator("section", { has: page.locator("#task-group-overdue") });
      await onlyOne(overdue.getByRole("listitem").filter({ hasText: TITLE }), "the task in the Overdue group");
      expect(await tabCounts(page)).toEqual(before);

      const db = localDb("R-2927");
      await expect.poll(() => db.one(`select status || '|' || progress from public.tasks where id = '${T}';`), { timeout: 30_000 }).toBe("pending|in_progress");

      // On hold, then Done from the same menu; Done can be taken back from it too.
      await row.getByRole("button", { name: /^Status: In progress/ }).click();
      await page.getByRole("menuitemcheckbox", { name: "On hold", exact: true }).click();
      await expect(row.getByRole("button", { name: /^Status: On hold/ })).toBeVisible({ timeout: 60_000 });
      await expect.poll(() => db.one(`select status || '|' || progress from public.tasks where id = '${T}';`), { timeout: 30_000 }).toBe("pending|on_hold");

      await row.getByRole("button", { name: /^Status: On hold/ }).click();
      await page.getByRole("menuitemcheckbox", { name: "Done", exact: true }).click();
      await expect(page.getByText("Marked done ✓")).toBeVisible({ timeout: 60_000 }); // the same Undo toast as the circle
      await expect.poll(() => db.one(`select status from public.tasks where id = '${T}';`), { timeout: 30_000 }).toBe("done");

      // Take Done back from the menu: the Done group is folded on the All tab, so open the Done tab.
      await openAppPage(page, "/tasks?tab=done");
      const doneRow = await onlyOne(page.getByRole("main").getByRole("listitem").filter({ hasText: TITLE }), "the task in Done");
      await doneRow.getByRole("button", { name: /^Status: Done/ }).click();
      await page.getByRole("menuitemcheckbox", { name: "Not started", exact: true }).click();
      await expect.poll(() => db.one(`select status || '|' || progress || '|' || (completed_at is null)::text from public.tasks where id = '${T}';`), { timeout: 30_000 }).toBe("pending|not_started|true");
    } finally {
      await page.context().close();
    }
  });
});
