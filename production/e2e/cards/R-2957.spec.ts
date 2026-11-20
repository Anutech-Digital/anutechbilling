/**
 * Card test — R-2957 "Tasks: a task can have sub-tasks (database + counts) — the base for goals".
 *
 * The card has no screen of its own: with no goal in the data every Tasks page reads as before.
 * This test plants what R-2958 will let a person make — one GOAL with one sub-task under it, both
 * overdue — and checks the counting rule on the pages that exist today: the sub-task is listed
 * and counted like any task, the goal row is in no list and no count.
 *
 * LOCAL app (E2E Test Co) through the Local test login. Needs migration
 * 20261120100051_r2957_task_sub_tasks.sql on the local database (`npm run localhost:update`).
 * Run: `node scripts/ops/card-tests.mjs R-2957`.
 *
 * Planted fresh on every run and removed after it (fixed ids, local docker DB only), owned by the
 * Owner login, linked to no customer.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2957";
const T = E2E_TENANT_SQL;
const OWNER = `(select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = ${T})`;
const id = (n: number) => `c2957000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const GOAL = "CT R2957 goal row (not work)";
const STEP = "CT R2957 sub-task (the work)";
/* Sub-task first, then the goal: a row is removed before the row it points to. */
const CLEAN = `delete from public.tasks where tenant_id = ${T} and id = '${id(2)}'; delete from public.tasks where tenant_id = ${T} and id = '${id(1)}';`;

function seed(): void {
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, owner_id, title, kind, status, priority, due_at) values
      ('${id(1)}', ${T}, ${OWNER}, '${GOAL}', 'custom', 'pending', 'medium', now() - interval '2 days');
    insert into public.tasks (id, tenant_id, owner_id, title, kind, status, priority, due_at, parent_task_id) values
      ('${id(2)}', ${T}, ${OWNER}, '${STEP}', 'custom', 'pending', 'medium', now() - interval '2 days', '${id(1)}');
    commit;`);
}

const rows = (page: Page): Locator => page.getByRole("main").getByRole("listitem");
/** The number on a tile of Overview's "Open tasks by due date" strip — the tile's own label says it ("Overdue: 3 open tasks. …"). */
async function overviewNumber(page: Page, label: string): Promise<number> {
  const tile = await onlyOne(page.getByRole("main").getByRole("link", { name: new RegExp(`^${label}: \d+ open tasks?\.`) }), `the Overview "${label}" tile`);
  const m = new RegExp(`^${label}: (\d+) open`).exec((await tile.getAttribute("aria-label")) ?? "");
  if (!m) throw new Error(`no number on the Overview "${label}" tile`);
  return Number(m[1]);
}

test.describe("R-2957 — a goal row is not counted or listed as work; its sub-task is", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
  let overdueBefore = 0;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
    page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 800 });
    await openAppPage(page, "/tasks/overview", /Tasks overview/);
    overdueBefore = await overviewNumber(page, "Overdue");
    seed();
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
  });

  test("Step 1: Tasks list — the sub-task is a row, the goal is not; Overview's Overdue goes up by one, not two", async () => {
    /* The database made the first task a goal by itself when the sub-task went under it. */
    expect(localDb(CARD).one(`select is_goal::text from public.tasks where id = '${id(1)}'`)).toBe("true");

    await openAppPage(page, "/tasks?tab=overdue", /^Tasks$/);
    await onlyOne(rows(page).filter({ hasText: STEP }), "the sub-task's row");
    await expect(rows(page).filter({ hasText: GOAL }), "the goal row is not listed as work").toHaveCount(0);

    await openAppPage(page, "/tasks/overview", /Tasks overview/);
    await expect.poll(() => overviewNumber(page, "Overdue"), { timeout: 60_000 }).toBe(overdueBefore + 1);
    await expect(page.getByRole("main").getByText(GOAL), "the goal is in no Overview list").toHaveCount(0);
  });
});
