/**
 * Card test — R-2933 "Tasks: up to 3 people working with the owner + a link".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2933
 * Needs migration 20261119205800_r2933_task_collaborators_link.sql on the local DB (tasks.link_url, task_collaborators).
 *
 * The Owner login adds "CT R2933 prepare the proposal" through Tasks > Add task (due in 40 days),
 * picks the Sales login and one more teammate under "Working with", and types a link without
 * https://. Then: the row names both people and opens the link; the database has the two rows and
 * the full link; the Sales login's bell says "… added you to a task: …".
 * The task (its collaborator rows go with it), the notices and the mail-log rows are removed after.
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const TITLE = "CT R2933 prepare the proposal";
const SALES_EMAIL = "e2e-sales@example.test";
const LINK_TYPED = "drive.google.com/ct-r2933";
const LINK_SAVED = "https://drive.google.com/ct-r2933";
const TASK_ID_SQL = `(select t.id from public.tasks t where t.tenant_id = ${E2E_TENANT_SQL} and t.title = '${TITLE}')`;

const CLEAN = `
  delete from public.notifications where tenant_id = ${E2E_TENANT_SQL} and kind = 'task.assigned' and title like '% added you to a task: ${TITLE}';
  delete from public.email_log where tenant_id = ${E2E_TENANT_SQL} and kind = 'task_collaborator' and subject = 'Added to a task: ${TITLE}';
  delete from public.tasks where tenant_id = ${E2E_TENANT_SQL} and title = '${TITLE}';`;

test.describe("R-2933 people working with the owner + link", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) localDb("R-2933").psql(CLEAN); });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2933").psql(CLEAN); });

  test("Step 1+2: Add task with 2 people under 'Working with' and a link — the row names both and opens the link", async ({ browser, baseURL }) => {
    const db = localDb("R-2933");
    // The name the app shows for the Sales login (full name, else the part of the email before @).
    const salesName = db.one(`
      select coalesce(nullif(btrim(u.full_name), ''), split_part(u.email, '@', 1)) from public.users u
       where u.email = '${SALES_EMAIL}' and u.tenant_id = ${E2E_TENANT_SQL};`);
    expect(salesName).not.toBe("");

    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks?tab=upcoming");
      const add = page.getByRole("button", { name: "Add task" }).first();
      await expect(add).toBeVisible({ timeout: 60_000 });
      await add.click();
      const dlg = page.getByRole("dialog", { name: "Add follow-up task" });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await fillKept(dlg.locator("#title"), TITLE);
      const due = new Date(Date.now() + 40 * 24 * 3600 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      await fillKept(dlg.locator("#due_at"), `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T10:00`);

      const group = dlg.getByRole("group", { name: "Working with" });
      await expect(group).toBeVisible({ timeout: 60_000 });
      const sales = await onlyOne(group.getByRole("button", { name: salesName, exact: true }), "the Sales login under Working with");
      await sales.click();
      await expect(sales).toHaveAttribute("aria-pressed", "true");
      const other = group.getByRole("button", { pressed: false }).first();
      const otherName = (await other.innerText()).trim();
      await other.click();
      await expect(group.getByRole("button", { pressed: true })).toHaveCount(2);

      await fillKept(dlg.locator("#link"), LINK_TYPED);
      const saved = page.waitForResponse((r) => r.url().includes("/api/tasks/collaborators") && r.request().method() === "POST", { timeout: 60_000 });
      await dlg.getByRole("button", { name: "Schedule" }).click();
      const res = await saved;
      const body: unknown = await res.json();
      expect(body, `the collaborators call answered ${res.status()} ${JSON.stringify(body)}`).toMatchObject({ ok: true, added: 2, notified: 2 });
      await expect(dlg).toBeHidden({ timeout: 60_000 });

      const row = await onlyOne(page.getByRole("main").getByRole("listitem").filter({ hasText: TITLE }), "the new task's row");
      const withPeople = row.getByTestId("task-collaborators");
      await expect(withPeople).toContainText(salesName, { timeout: 60_000 });
      await expect(withPeople).toContainText(otherName);
      const link = row.getByTestId("task-link");
      await expect(link).toHaveAttribute("href", LINK_SAVED);
      await expect(link).toHaveAttribute("target", "_blank");
      await expect(link).toContainText("drive.google.com");

      expect(db.one(`select link_url from public.tasks where id = ${TASK_ID_SQL};`)).toBe(LINK_SAVED);
      expect(db.one(`select count(*)::text from public.task_collaborators where task_id = ${TASK_ID_SQL};`)).toBe("2");
      expect(db.one(`
        select count(*)::text from public.task_collaborators c join public.users u on u.id = c.user_id
         where c.task_id = ${TASK_ID_SQL} and u.email = '${SALES_EMAIL}'
           and c.added_by = (select o.id from public.users o where o.email = 'e2e-owner@example.test' and o.tenant_id = c.tenant_id);`)).toBe("1");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: Sales — the bell says '… added you to a task: …'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "sales");
    try {
      await openAppPage(page, "/tasks");
      const bell = page.getByRole("button", { name: /unread notifications/ });
      await expect(bell).toBeVisible({ timeout: 60_000 });
      await bell.click();
      const panel = page.getByRole("dialog", { name: "Notifications" });
      await onlyOne(panel.getByText(new RegExp(`^.+ added you to a task: ${TITLE}$`)), "the 'added you to a task' notice");
    } finally {
      await page.context().close();
    }
  });
});
