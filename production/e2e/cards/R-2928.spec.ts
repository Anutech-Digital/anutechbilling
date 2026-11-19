/**
 * Card test — R-2928 "Tasks: 'Remind' (follow-up) button + when the owner was last reminded".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2928
 * Needs migration 20261119201547_r2928_task_followup.sql on the local DB (tasks.last_followup_at).
 *
 * Data: one planted task "CT R2928 send the quote" owned by the Sales login, due in 40 days.
 * The Owner login presses "Remind" on its row. Then: the toast, "Last reminded …" on the row, the
 * Sales login's bell, and the local email log (localhost has no mail provider, so the row reads
 * "failed — No email provider is configured"; the row itself proves the mail was handed to the
 * sender — a real inbox is checked on staging). A second press inside the hour is refused.
 * The task, its notice and its mail-log row are removed after.
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const TITLE = "CT R2928 send the quote";
const T_ID = "c2928000-0000-4000-8000-000000000a01";
const SALES_EMAIL = "e2e-sales@example.test";
const SALES = `(select u.id from public.users u where u.email = '${SALES_EMAIL}' and u.tenant_id = ${E2E_TENANT_SQL})`;

const CLEAN = `
  delete from public.notifications where tenant_id = ${E2E_TENANT_SQL} and kind = 'task.reminder' and entity_id = '${T_ID}';
  delete from public.email_log where tenant_id = ${E2E_TENANT_SQL} and kind = 'task_reminder' and subject = 'Reminder: ${TITLE}';
  delete from public.tasks where tenant_id = ${E2E_TENANT_SQL} and id = '${T_ID}';`;

test.describe("R-2928 Remind a teammate about their task", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    localDb("R-2928").psql(`
      begin;
      ${CLEAN}
      insert into public.tasks (id, tenant_id, owner_id, title, kind, due_at, status)
      values ('${T_ID}', ${E2E_TENANT_SQL}, ${SALES}, '${TITLE}', 'followup', now() + interval '40 days', 'pending');
      commit;`);
  });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2928").psql(CLEAN); });

  test("Step 1+2: Owner presses Remind on the teammate's task — 'Reminder sent', and the row shows 'Last reminded …'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks?tab=upcoming");
      const main = page.getByRole("main");
      const row = await onlyOne(main.getByRole("listitem").filter({ hasText: TITLE }), "the teammate's task row");
      await expect(row.getByTestId("task-last-reminded")).toHaveCount(0);
      const remind = await onlyOne(row.getByRole("button", { name: /^Remind\b/ }), "the Remind button");

      const call = page.waitForResponse((r) => r.url().includes("/api/tasks/remind") && r.request().method() === "POST", { timeout: 60_000 });
      await remind.click();
      const res = await call;
      const body: unknown = await res.json();
      expect(body, `the remind call answered ${res.status()} ${JSON.stringify(body)}`).toMatchObject({ ok: true, reminded: true });
      await expect(page.getByText("Reminder sent", { exact: true })).toBeVisible({ timeout: 30_000 });
      await expect(row.getByTestId("task-last-reminded")).toContainText(/^\s*Last reminded \d{1,2} [A-Z][a-z]{2}, \d{1,2}:\d{2} (am|pm)$/, { timeout: 60_000 });

      // A second press inside the hour is refused in plain words, and nothing more is counted.
      const again = page.waitForResponse((r) => r.url().includes("/api/tasks/remind") && r.request().method() === "POST", { timeout: 60_000 });
      await remind.click();
      expect((await again).status()).toBe(409);
      await expect(page.getByText(/A reminder was already sent for this task in the last hour/)).toBeVisible({ timeout: 30_000 });
      expect(localDb("R-2928").one(`select followup_count::text || '|' || (last_followup_at is not null)::text from public.tasks where id = '${T_ID}';`)).toBe("1|true");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3a: Sales — the bell shows 'Reminder from …' with the task's name", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "sales");
    try {
      await openAppPage(page, "/tasks");
      const bell = page.getByRole("button", { name: /unread notifications/ });
      await expect(bell).toBeVisible({ timeout: 60_000 });
      await bell.click();
      const panel = page.getByRole("dialog", { name: "Notifications" });
      await onlyOne(panel.getByText(new RegExp(`^Reminder from .+: ${TITLE}$`)), "the 'Reminder from …' notice");
      // The Sales login sees no Remind button on its OWN task.
      await page.keyboard.press("Escape");
      await openAppPage(page, "/tasks?tab=upcoming");
      const row = await onlyOne(page.getByRole("main").getByRole("listitem").filter({ hasText: TITLE }), "the task row (Sales login)");
      await expect(row.getByRole("button", { name: /^Remind\b/ })).toHaveCount(0);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3b: the reminder email to the Sales member was handed to the mail sender (local email log), once", async () => {
    const db = localDb("R-2928");
    const rows = db.psql(`
      select recipient || '|' || subject || '|' || status || '|' || coalesce(error_message, '') from public.email_log
       where tenant_id = ${E2E_TENANT_SQL} and kind = 'task_reminder' and subject = 'Reminder: ${TITLE}';`);
    expect(rows).toHaveLength(1);
    const [to, subject, status, why] = rows[0].split("|");
    expect([to, subject]).toEqual([SALES_EMAIL, `Reminder: ${TITLE}`]);
    // Localhost has no mail provider: the sender logs the mail as failed with exactly that reason.
    if (status === "failed") expect(why).toBe("No email provider is configured, so this message cannot be sent.");
    else expect(["sent", "stubbed"]).toContain(status);
  });
});
