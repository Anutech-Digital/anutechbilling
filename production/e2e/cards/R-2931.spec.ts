/**
 * Card test — R-2931 "Tasks: mahine ka calendar (due date se)" (/tasks/calendar).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2931` (no migration).
 *
 * Planted fresh on every run and removed after it (fixed ids, local docker DB only): two open
 * tasks of E2E Test Co, one due today 12:00 IST and one due 3 days later (same or next month).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2931";
const TASK_TODAY = "c2931000-0000-4000-8000-000000000001";
const TASK_LATER = "c2931000-0000-4000-8000-000000000002";
const TITLE_TODAY = "CT R2931 Call the calendar customer";
const TITLE_LATER = "CT R2931 Send the calendar quote";
const T = E2E_TENANT_SQL;
/** Today 12:00 IST as a timestamptz. */
const NOON_IST = `((date_trunc('day', now() at time zone 'Asia/Kolkata') + interval '12 hours') at time zone 'Asia/Kolkata')`;

const CLEAN = `delete from public.tasks where tenant_id = ${T} and id in ('${TASK_TODAY}', '${TASK_LATER}');`;

function seed(): void {
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, title, kind, status, due_at) values
      ('${TASK_TODAY}', ${T}, '${TITLE_TODAY}', 'call', 'pending', ${NOON_IST}),
      ('${TASK_LATER}', ${T}, '${TITLE_LATER}', 'followup', 'pending', ${NOON_IST} + interval '3 days');
    commit;`);
}

/** The IST day (YYYY-MM-DD) the local DB put a planted task on. */
function dueDay(id: string): string {
  return localDb(CARD).one(`select to_char(due_at at time zone 'Asia/Kolkata', 'YYYY-MM-DD') from public.tasks where id = '${id}';`);
}

test.describe("R-2931 — Tasks: month calendar by due date", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
  });

  test("Step 1: Tasks > Calendar opens with this month's grid", async () => {
    await openAppPage(page, "/tasks/calendar", /Task calendar/);
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      await expect(page.getByText(d, { exact: true }).first()).toBeVisible();
    }
    const today = dueDay(TASK_TODAY);
    await expect(page.getByTestId(`day-${today}`)).toBeVisible({ timeout: 60_000 });
  });

  test("Step 2: a task shows on its due day; pressing the day opens that day's list", async () => {
    const today = dueDay(TASK_TODAY);
    const later = dueDay(TASK_LATER);

    // Today's task is in today's cell — and not in the later day's cell.
    const todayCell = page.getByTestId(`day-${today}`);
    await expect(todayCell.getByText(TITLE_TODAY)).toBeVisible({ timeout: 60_000 });
    await expect(todayCell.getByText(TITLE_LATER)).toHaveCount(0);

    // The later task sits on its own day (move to its month first when it falls in the next one).
    if (later.slice(0, 7) !== today.slice(0, 7)) {
      await page.getByRole("button", { name: "Next month" }).click();
    }
    const laterCell = page.getByTestId(`day-${later}`);
    await expect(laterCell.getByText(TITLE_LATER)).toBeVisible({ timeout: 60_000 });

    // Press that day → the list below names the day and shows the task row.
    await laterCell.click();
    const list = page.getByTestId("calendar-day-list");
    await expect(list.getByRole("heading")).toContainText(/1 task due|tasks due/);
    await onlyOne(list.getByText(TITLE_LATER), "the later task in the day list");
    await expect(list.getByText(TITLE_TODAY)).toHaveCount(0);
  });
});
