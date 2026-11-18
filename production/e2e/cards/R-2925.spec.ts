/**
 * Card test — R-2925 "Tasks: the person a task is assigned to is told at once (app + email)".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2925
 *
 * The Owner login adds a task "CT R2925 call the customer" assigned to the Sales login through
 * Tasks > Add task. Then: the Sales login's bell shows "New task from …", and the local email
 * log has the mail to the Sales login. Localhost has no mail provider, so the row reads
 * "failed — No email provider is configured"; the row itself (right person, right subject) is what
 * proves the app handed the mail to the sender. A real inbox is checked on staging. The task and its notice are removed after.
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const TITLE = "CT R2925 call the customer";
const SALES_EMAIL = "e2e-sales@example.test";

const CLEAN = `
  delete from public.notifications where tenant_id = ${E2E_TENANT_SQL} and kind = 'task.assigned' and title like '%${TITLE}';
  delete from public.email_log where tenant_id = ${E2E_TENANT_SQL} and kind = 'task_assigned' and subject = 'New task: ${TITLE}';
  delete from public.tasks where tenant_id = ${E2E_TENANT_SQL} and title = '${TITLE}';`;

test.describe("R-2925 assignee is told (bell + email)", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => { if (CARD_TESTS_ON) localDb("R-2925").psql(CLEAN); });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2925").psql(CLEAN); });

  test("Step 1: Owner — Tasks > Add task, assign to the Sales member, save", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks");
      const add = page.getByRole("button", { name: "Add task" }).first();
      await expect(add).toBeVisible({ timeout: 60_000 });
      await add.click();
      const dlg = page.getByRole("dialog", { name: "Add follow-up task" });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await fillKept(dlg.locator("#title"), TITLE);
      await dlg.locator("#assignee").click();
      const option = page.getByRole("option", { name: /· sales$/ });
      await expect(option.first()).toBeVisible({ timeout: 30_000 });
      await option.first().click();
      const notice = page.waitForResponse((r) => r.url().includes("/api/tasks/assigned") && r.request().method() === "POST", { timeout: 60_000 });
      await dlg.getByRole("button", { name: "Schedule" }).click();
      const res = await notice;
      expect(res.status()).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, notified: true });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Sales — the bell shows 'New task from …' with the task's name", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "sales");
    try {
      await openAppPage(page, "/tasks");
      const bell = page.getByRole("button", { name: /unread notifications/ });
      await expect(bell).toBeVisible({ timeout: 60_000 });
      await bell.click();
      const panel = page.getByRole("dialog", { name: "Notifications" });
      await onlyOne(panel.getByText(new RegExp(`^New task from .+: ${TITLE}$`)), "the 'New task from …' notice");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: the email to the Sales member was handed to the mail sender (local email log)", async () => {
    const db = localDb("R-2925");
    const row = db.one(`
      select recipient || '|' || subject || '|' || status || '|' || coalesce(error_message, '') from public.email_log
       where tenant_id = ${E2E_TENANT_SQL} and kind = 'task_assigned' and subject = 'New task: ${TITLE}'
       order by created_at desc limit 1;`);
    expect(row.split("|").slice(0, 2)).toEqual([SALES_EMAIL, `New task: ${TITLE}`]);
    // Localhost has no mail provider (dev:local blanks the keys): the app still hands the mail to the sender,
    // which logs it as failed with exactly that reason. Any OTHER failure is a real one.
    const [, , status, why] = row.split("|");
    if (status === "failed") expect(why).toBe("No email provider is configured, so this message cannot be sent.");
    else expect(["sent", "stubbed"]).toContain(status);
    // Who handed it over is recorded on the task.
    const stamped = db.one(`
      select (t.delegated_by = (select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = t.tenant_id))::text
        from public.tasks t where t.tenant_id = ${E2E_TENANT_SQL} and t.title = '${TITLE}';`);
    expect(stamped).toBe("true");
  });
});
