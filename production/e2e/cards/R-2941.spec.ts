/**
 * Card test — R-2941 "Tasks: database guards for 'Working with' and Remind".
 *
 * LOCAL ONLY (E2E Test Co on the local docker DB, through the Local test login). Run:
 *   node scripts/ops/card-tests.mjs R-2941
 * Needs migration 20261120011930_r2941_task_guards.sql on the local DB (the two guard triggers)
 * — step 1 says so plainly when it is missing.
 *
 * Step 1: the Owner login adds "CT R2941 plan the visit" through Tasks > Add task and picks 3
 * people under "Working with" — every other chip is then switched off; Save works and the
 * database holds 3 rows. A 4th row written straight into the database is refused by the guard.
 * Step 2: the Owner presses Remind on a planted task of the Sales login — "Reminder sent"; a
 * second press at once is refused in plain words and nothing more is counted.
 * The rest of the card (another company's task / person, resetting the reminder time by hand,
 * the server path) is supabase/tests/r2941_task_guards.test.sql.
 * Both tasks, the notices and the mail-log rows are removed after.
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const ADD_TITLE = "CT R2941 plan the visit";
const REMIND_TITLE = "CT R2941 call the client back";
const T_ID = "c2941000-0000-4000-8000-000000000a01";
const SALES = `(select u.id from public.users u where u.email = 'e2e-sales@example.test' and u.tenant_id = ${E2E_TENANT_SQL})`;
const ADDED_TASK_SQL = `(select t.id from public.tasks t where t.tenant_id = ${E2E_TENANT_SQL} and t.title = '${ADD_TITLE}')`;

const CLEAN = `
  delete from public.notifications where tenant_id = ${E2E_TENANT_SQL} and kind = 'task.reminder' and entity_id = '${T_ID}';
  delete from public.notifications where tenant_id = ${E2E_TENANT_SQL} and kind = 'task.assigned' and title like '% added you to a task: ${ADD_TITLE}';
  delete from public.email_log where tenant_id = ${E2E_TENANT_SQL} and kind = 'task_reminder' and subject = 'Reminder: ${REMIND_TITLE}';
  delete from public.email_log where tenant_id = ${E2E_TENANT_SQL} and kind = 'task_collaborator' and subject = 'Added to a task: ${ADD_TITLE}';
  delete from public.tasks where tenant_id = ${E2E_TENANT_SQL} and (id = '${T_ID}' or title = '${ADD_TITLE}');`;

test.describe("R-2941 database guards for 'Working with' and Remind", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    localDb("R-2941").psql(`
      begin;
      ${CLEAN}
      insert into public.tasks (id, tenant_id, owner_id, title, kind, due_at, status)
      values ('${T_ID}', ${E2E_TENANT_SQL}, ${SALES}, '${REMIND_TITLE}', 'followup', now() + interval '40 days', 'pending');
      commit;`);
  });
  test.afterAll(() => { if (CARD_TESTS_ON) localDb("R-2941").psql(CLEAN); });

  test("Step 1: Add task — 3 people under 'Working with', every other chip is switched off, Save works; the database refuses a 4th", async ({ browser, baseURL }) => {
    const db = localDb("R-2941");
    expect(
      db.one(`select count(*)::text from pg_trigger where tgname in ('trg_task_collaborators_guard', 'trg_tasks_followup_guard') and not tgisinternal and tgenabled <> 'D';`),
      "migration 20261120011930_r2941_task_guards.sql is not on the local DB — run npm run localhost:update",
    ).toBe("2");

    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks?tab=upcoming");
      const add = page.getByRole("button", { name: "Add task" }).first();
      await expect(add).toBeVisible({ timeout: 60_000 });
      await add.click();
      const dlg = page.getByRole("dialog", { name: "Add follow-up task" });
      await expect(dlg).toBeVisible({ timeout: 60_000 });
      await fillKept(dlg.locator("#title"), ADD_TITLE);
      const due = new Date(Date.now() + 40 * 24 * 3600 * 1000);
      const pad = (n: number) => String(n).padStart(2, "0");
      await fillKept(dlg.locator("#due_at"), `${due.getFullYear()}-${pad(due.getMonth() + 1)}-${pad(due.getDate())}T10:00`);

      const group = dlg.getByRole("group", { name: "Working with" });
      await expect(group).toBeVisible({ timeout: 60_000 });
      const chips = group.getByRole("button");
      const total = await chips.count();
      expect(total, "E2E Test Co needs at least 4 teammates to show a switched-off 4th chip").toBeGreaterThanOrEqual(4);
      for (let i = 0; i < 3; i++) {
        const next = group.getByRole("button", { pressed: false }).first();
        await next.click();
        await expect(group.getByRole("button", { pressed: true })).toHaveCount(i + 1);
      }
      // Every chip that is not picked is now switched off — a 4th person cannot be chosen.
      const rest = group.getByRole("button", { pressed: false });
      await expect(rest).toHaveCount(total - 3);
      for (let i = 0; i < total - 3; i++) await expect(rest.nth(i)).toBeDisabled();

      const saved = page.waitForResponse((r) => r.url().includes("/api/tasks/collaborators") && r.request().method() === "POST", { timeout: 60_000 });
      await dlg.getByRole("button", { name: "Schedule" }).click();
      const res = await saved;
      const body: unknown = await res.json();
      expect(body, `the collaborators call answered ${res.status()} ${JSON.stringify(body)}`).toMatchObject({ ok: true, added: 3 });
      await expect(dlg).toBeHidden({ timeout: 60_000 });
      expect(db.one(`select count(*)::text from public.task_collaborators where task_id = ${ADDED_TASK_SQL};`)).toBe("3");

      // Straight into the database, around the screen and the route: the guard refuses a 4th person.
      const direct = db.one(`
        do $$
        declare v_msg text := 'WENT IN';
        begin
          begin
            insert into public.task_collaborators (tenant_id, task_id, user_id)
            select t.tenant_id, t.id, u.id from public.tasks t join public.users u on u.tenant_id = t.tenant_id
             where t.id = ${ADDED_TASK_SQL} and u.is_active is not false and u.id <> coalesce(t.owner_id, t.id)
               and not exists (select 1 from public.task_collaborators c where c.task_id = t.id and c.user_id = u.id)
             limit 1;
          exception when others then v_msg := sqlerrm;
          end;
          perform set_config('r2941.card_test', v_msg, false);
        end $$;
        select current_setting('r2941.card_test');`);
      expect(direct).toContain("R-2941: a task can have up to 3 people");
      expect(db.one(`select count(*)::text from public.task_collaborators where task_id = ${ADDED_TASK_SQL};`)).toBe("3");
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Remind a teammate's task — 'Reminder sent'; a second press at once is refused in plain words", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/tasks?tab=upcoming");
      const row = await onlyOne(page.getByRole("main").getByRole("listitem").filter({ hasText: REMIND_TITLE }), "the teammate's task row");
      const remind = await onlyOne(row.getByRole("button", { name: /^Remind\b/ }), "the Remind button");

      const call = page.waitForResponse((r) => r.url().includes("/api/tasks/remind") && r.request().method() === "POST", { timeout: 60_000 });
      await remind.click();
      const res = await call;
      const body: unknown = await res.json();
      expect(body, `the remind call answered ${res.status()} ${JSON.stringify(body)}`).toMatchObject({ ok: true, reminded: true });
      await expect(page.getByText("Reminder sent", { exact: true })).toBeVisible({ timeout: 30_000 });

      const again = page.waitForResponse((r) => r.url().includes("/api/tasks/remind") && r.request().method() === "POST", { timeout: 60_000 });
      await remind.click();
      expect((await again).status()).toBe(409);
      await expect(page.getByText(/A reminder was already sent for this task in the last hour/)).toBeVisible({ timeout: 30_000 });
      // The server path stamped once (the guard lets the server write the two columns).
      expect(localDb("R-2941").one(`select followup_count::text || '|' || (last_followup_at is not null)::text from public.tasks where id = '${T_ID}';`)).toBe("1|true");
    } finally {
      await page.context().close();
    }
  });
});
