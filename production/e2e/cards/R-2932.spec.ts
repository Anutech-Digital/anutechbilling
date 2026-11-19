/**
 * Card test — R-2932 "Team workload + overdue / completion trend report" (Reports → Team tasks).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2932` (no migration).
 *
 * Planted fresh on every run and removed after it (fixed ids, local docker DB only): four tasks
 * owned by E2E Test Co's owner — one open and due tomorrow, one open and 3 days overdue, one
 * ticked done an hour ago (on time), one due 10 days ago and ticked 9 days ago (late).
 * The report's counts for the owner must go UP by exactly these against a read taken before.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2932";
const IDS = [1, 2, 3, 4].map((i) => `c2932000-0000-4000-8000-00000000000${i}`);
const T = E2E_TENANT_SQL;
const CLEAN = `delete from public.tasks where tenant_id = ${T} and id in (${IDS.map((i) => `'${i}'`).join(", ")});`;

let ownerId = "";
let before = { open: 0, overdue: 0 };

/** Open / overdue counts of the owner's tasks, straight from the local DB. */
function ownerCounts(): { open: number; overdue: number } {
  const [open, overdue] = localDb(CARD).one(`
    select count(*) || '|' || count(*) filter (where due_at < now())
    from public.tasks where tenant_id = ${T} and owner_id = '${ownerId}' and status in ('pending', 'snoozed');`).split("|").map(Number);
  return { open, overdue };
}

function seed(): void {
  const db = localDb(CARD);
  ownerId = db.one(`select id from public.users where tenant_id = ${T} and role = 'owner' order by created_at limit 1;`);
  if (!/^[0-9a-f-]{36}$/.test(ownerId)) throw new Error("E2E Test Co has no owner user");
  db.psql(`begin; ${CLEAN} commit;`);
  before = ownerCounts();
  db.psql(`
    begin;
    insert into public.tasks (id, tenant_id, owner_id, title, kind, status, due_at, completed_at) values
      ('${IDS[0]}', ${T}, '${ownerId}', 'CT R2932 open task', 'call', 'pending', now() + interval '1 day', null),
      ('${IDS[1]}', ${T}, '${ownerId}', 'CT R2932 overdue task', 'call', 'pending', now() - interval '3 days', null),
      ('${IDS[2]}', ${T}, '${ownerId}', 'CT R2932 done task', 'call', 'done', now() + interval '1 day', now() - interval '1 hour'),
      ('${IDS[3]}', ${T}, '${ownerId}', 'CT R2932 late task', 'call', 'done', now() - interval '10 days', now() - interval '9 days');
    commit;`);
}

test.describe("R-2932 — Reports: Team tasks", () => {
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

  test("Step 1: Reports > Team tasks opens", async () => {
    await openAppPage(page, "/reports", /Reports/);
    const link = page.locator('main a[href="/reports/team-tasks"]').first();
    await expect(link).toBeVisible({ timeout: 60_000 });
    await link.click();
    await expect(page).toHaveURL(/\/reports\/team-tasks/);
    await expect(page.getByRole("heading", { name: "Team tasks" })).toBeVisible({ timeout: 60_000 });
  });

  test("Step 2: each member's row shows open / overdue / done counts", async () => {
    const table = page.getByTestId("team-workload");
    await expect(table).toBeVisible({ timeout: 60_000 });
    for (const h of ["Team member", "Open", "Overdue", "Done this week"]) {
      await expect(table.getByRole("columnheader", { name: h, exact: true })).toBeVisible();
    }
    const row = page.getByTestId(`workload-${ownerId}`);
    await expect(row.locator('[data-col="open"]')).toHaveText(String(before.open + 2), { timeout: 60_000 });
    await expect(row.locator('[data-col="overdue"]')).toHaveText(String(before.overdue + 1));
    // "Done this week" holds at least the task ticked an hour ago (unless the week began within the hour).
    const done = Number(await row.locator('[data-col="done"]').innerText());
    expect(done).toBeGreaterThanOrEqual(new Date(Date.now() + 5.5 * 3600_000).getUTCDay() === 1 ? 0 : 1);
    // The name opens the Tasks list for that person.
    await expect(row.getByRole("link", { name: /View .* tasks/ })).toHaveAttribute("href", `/tasks?assignee=${ownerId}`);
  });

  test("Step 3: the 8-week completed vs late chart shows below", async () => {
    const card = page.getByTestId("team-trend");
    await expect(card.getByRole("heading", { name: /Completed vs late — last 8 weeks/ })).toBeVisible();
    await expect(card.locator("svg.recharts-surface").first()).toBeVisible({ timeout: 60_000 });
    const table = card.getByTestId("team-trend-table");
    await expect(table.getByRole("columnheader")).toHaveCount(9); // "Week of" + 8 weeks
    const sum = async (name: string) =>
      (await table.getByRole("row", { name: new RegExp(`^${name}`) }).getByRole("cell").allInnerTexts()).reduce((s, v) => s + Number(v), 0);
    expect(await sum("Completed")).toBeGreaterThanOrEqual(2); // the two planted done tasks
    expect(await sum("Late")).toBeGreaterThanOrEqual(2);      // the overdue one + the one ticked a day late
  });
});
