/**
 * Card test — R-2938 "Tasks: one filter bar — search + Status + Priority + Assignee dropdowns
 * with counts (person chips removed)" (/tasks, and the Overview donuts that open it filtered).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2938` (no migration).
 *
 * Planted fresh on every run and removed after it (fixed ids, local docker DB only):
 *   two High tasks of the Owner login (one 2 days overdue, one due in 40 days),
 *   one Medium "In progress" task of the Owner login (due in 41 days),
 *   one Low "On hold" task of the Sales login (due in 42 days).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2938";
const T = E2E_TENANT_SQL;
const user = (email: string) => `(select u.id from public.users u where u.email = '${email}' and u.tenant_id = ${T})`;
const OWNER = user("e2e-owner@example.test");
const SALES_EMAIL = "e2e-sales@example.test";
const SALES = user(SALES_EMAIL);
const id = (n: number) => `c2938000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const HIGH_OVERDUE = "CT R2938 high overdue chase";
const HIGH_LATER = "CT R2938 high later visit";
const MEDIUM_DOING = "CT R2938 medium in progress";
const LOW_HOLD = "CT R2938 low on hold (sales)";
const CLEAN = `delete from public.tasks where tenant_id = ${T} and id in ('${id(1)}', '${id(2)}', '${id(3)}', '${id(4)}');`;

function seed(): void {
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, owner_id, title, kind, status, priority, progress, due_at) values
      ('${id(1)}', ${T}, ${OWNER}, '${HIGH_OVERDUE}', 'followup', 'pending', 'high', 'not_started', now() - interval '2 days'),
      ('${id(2)}', ${T}, ${OWNER}, '${HIGH_LATER}', 'meeting', 'pending', 'high', 'not_started', now() + interval '40 days'),
      ('${id(3)}', ${T}, ${OWNER}, '${MEDIUM_DOING}', 'custom', 'pending', 'medium', 'in_progress', now() + interval '41 days'),
      ('${id(4)}', ${T}, ${SALES}, '${LOW_HOLD}', 'call', 'pending', 'low', 'on_hold', now() + interval '42 days');
    commit;`);
}

const rows = (page: Page) => page.getByRole("main").getByRole("listitem");
const rowOf = (page: Page, title: string) => rows(page).filter({ hasText: title });
const box = (page: Page, name: "Status" | "Priority" | "Assignee") =>
  page.getByTestId("task-filter-bar").getByRole("combobox", { name, exact: true });
/** The number in "High (5)". */
const countIn = (label: string): number => Number(/\((\d+)\)\s*$/.exec(label)?.[1] ?? NaN);

/** Open a dropdown, read its option names, and close it again. */
async function optionsOf(page: Page, name: "Status" | "Priority" | "Assignee"): Promise<string[]> {
  await box(page, name).click();
  const options = page.getByRole("option");
  await expect(options.first()).toBeVisible({ timeout: 30_000 });
  const names = (await options.allInnerTexts()).map((s) => s.trim());
  await page.keyboard.press("Escape");
  await expect(options).toHaveCount(0);
  return names;
}
async function pick(page: Page, name: "Status" | "Priority" | "Assignee", option: RegExp): Promise<void> {
  await box(page, name).click();
  const item = page.getByRole("option", { name: option });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
  await expect(page.getByRole("option")).toHaveCount(0);
}
/** "Open N" on the closed Summary line. */
async function summaryOpen(page: Page): Promise<number> {
  const fact = page.locator('[data-kpi-strip="tasks"]').getByText(/^Open \d+/);
  await expect(fact).toBeVisible({ timeout: 60_000 });
  return Number(/\d+/.exec(await fact.innerText())?.[0] ?? NaN);
}
/** Open /tasks (with a query string or not) and wait until the list has loaded. */
async function openTasks(page: Page, path = "/tasks"): Promise<void> {
  await openAppPage(page, path, /^Tasks$/);
  await onlyOne(rowOf(page, HIGH_OVERDUE), "the planted High overdue task's row");
}

test.describe("R-2938 — Tasks: one filter bar with counts", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
  let salesName = "";
  let highCount = NaN;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    salesName = localDb(CARD).one(`select coalesce(nullif(full_name, ''), split_part(email, '@', 1)) from public.users where email = '${SALES_EMAIL}' and tenant_id = ${T};`);
    page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 800 });
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
  });

  test("Step 1: Tasks has ONE line with search, Status, Priority and Assignee — and no person chips", async () => {
    await openTasks(page);
    const bar = page.getByTestId("task-filter-bar");
    const search = bar.getByRole("searchbox", { name: "Search tasks" });
    await expect(search).toBeVisible();
    const tops: number[] = [(await search.boundingBox())!.y];
    for (const name of ["Status", "Priority", "Assignee"] as const) {
      await expect(box(page, name)).toBeVisible();
      tops.push((await box(page, name).boundingBox())!.y);
    }
    expect(Math.max(...tops) - Math.min(...tops), "search and the three dropdowns sit on one line").toBeLessThanOrEqual(8);
    // The wrapped person chips are gone.
    await expect(page.getByRole("main").getByRole("button", { name: /^\S{0,2}\s?(Everyone|Mine)\s*\d*$/ })).toHaveCount(0);
    // Fits 1280: no sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  });

  test("Step 2: every option carries a number; the Sales login (it has a task) is offered under Assignee", async () => {
    const status = await optionsOf(page, "Status");
    expect(status.map((s) => s.replace(/ \(\d+\)$/, ""))).toEqual(["All statuses", "Not started", "In progress", "On hold", "Done"]);
    const priority = await optionsOf(page, "Priority");
    expect(priority.map((s) => s.replace(/ \(\d+\)$/, ""))).toEqual(["All priorities", "High", "Medium", "Low"]);
    const assignee = await optionsOf(page, "Assignee");
    expect(assignee.slice(0, 2).map((s) => s.replace(/ \(\d+\)$/, ""))).toEqual(["Everyone", "Mine"]);
    for (const label of [...status, ...priority, ...assignee]) expect(label, "option has its number").toMatch(/ \(\d+\)$/);

    highCount = countIn(priority[1]);
    expect(highCount).toBeGreaterThanOrEqual(2); // the two planted High tasks
    expect(countIn(status[2])).toBeGreaterThanOrEqual(1); // In progress
    expect(countIn(status[3])).toBeGreaterThanOrEqual(1); // On hold
    const sales = assignee.find((s) => s.replace(/ \(\d+\)$/, "") === salesName);
    expect(sales, `"${salesName}" under Assignee (${assignee.join(" | ")})`).toBeTruthy();
    expect(countIn(sales!)).toBeGreaterThanOrEqual(1);
    // The numbers add up: the three priorities make "All priorities".
    expect(countIn(priority[1]) + countIn(priority[2]) + countIn(priority[3])).toBe(countIn(priority[0]));
  });

  test("Step 3: Priority = High leaves only High tasks; Summary and tabs follow", async () => {
    await pick(page, "Priority", /^High \(\d+\)$/);
    await expect(page).toHaveURL(/[?&]priority=high(&|$)/);
    await expect(box(page, "Priority")).toContainText("High");
    await onlyOne(rowOf(page, HIGH_OVERDUE), "the High overdue task");
    await onlyOne(rowOf(page, HIGH_LATER), "the High later task");
    await expect(rowOf(page, MEDIUM_DOING)).toHaveCount(0);
    await expect(rowOf(page, LOW_HOLD)).toHaveCount(0);
    // Every open row on the page carries the High badge.
    const total = await rows(page).count();
    expect(total).toBeGreaterThanOrEqual(2);
    await expect(rows(page).filter({ has: page.getByText("High", { exact: true }) })).toHaveCount(total);
    // Summary "Open" is the number the option showed.
    expect(await summaryOpen(page)).toBe(highCount);
    const overdueTab = Number(((await page.getByRole("tab", { name: /^Overdue/ }).first().innerText()).match(/\d+/) ?? ["NaN"])[0]);
    expect(overdueTab).toBeGreaterThanOrEqual(1);
    expect(overdueTab).toBeLessThanOrEqual(highCount);
  });

  test("Step 4: a reload keeps the filter; adding Assignee narrows further; Clear filters brings everything back", async () => {
    await page.reload();
    await onlyOne(rowOf(page, HIGH_OVERDUE), "the High overdue task after the reload");
    await expect(page).toHaveURL(/[?&]priority=high(&|$)/);
    await expect(box(page, "Priority")).toContainText("High");
    await expect(rowOf(page, MEDIUM_DOING)).toHaveCount(0);
    expect(await summaryOpen(page)).toBe(highCount);

    // Search for the planted tasks only, so the next counts are exact whatever else the company holds.
    await fillKept(page.getByRole("searchbox", { name: "Search tasks" }), "CT R2938");
    await expect(rows(page)).toHaveCount(2); // the two High ones

    // The Sales login's planted task is Low: High + Sales = nothing, said plainly.
    const salesOption = new RegExp(`^${salesName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+\\)$`);
    await pick(page, "Assignee", salesOption);
    await expect(page).toHaveURL(/[?&]assignee=[0-9a-f-]{36}(&|$)/);
    const main = page.getByRole("main");
    await expect(main.getByText("No tasks match “CT R2938” with these filters")).toBeVisible({ timeout: 30_000 });
    await expect(rows(page)).toHaveCount(0);

    // "Clear filters" (the button under the message) removes the three choices; the search stays.
    await main.getByRole("button", { name: "Clear filters", exact: true }).last().click();
    await expect(page).not.toHaveURL(/priority=|assignee=|status=/);
    await expect(rows(page)).toHaveCount(4);
    await onlyOne(rowOf(page, MEDIUM_DOING), "the Medium task after clearing");
    await onlyOne(rowOf(page, LOW_HOLD), "the Sales login's Low task after clearing");

    // Status works the same way: In progress leaves the Medium task only.
    await pick(page, "Status", /^In progress \(\d+\)$/);
    await expect(page).toHaveURL(/[?&]status=in_progress(&|$)/);
    await expect(rows(page)).toHaveCount(1);
    await onlyOne(rowOf(page, MEDIUM_DOING), "the In progress task");

    // Assignee = the Sales login alone shows that person's task.
    await pick(page, "Status", /^All statuses \(\d+\)$/);
    await pick(page, "Assignee", salesOption);
    await expect(rows(page)).toHaveCount(1);
    await onlyOne(rowOf(page, LOW_HOLD), "the Sales login's task");
  });

  test("Step 5: Overview — the Priority donut's High line opens the Tasks list with High picked", async () => {
    await openAppPage(page, "/tasks/overview", /Tasks overview/);
    const high = page.getByTestId("overview-priority").getByRole("link", { name: /^High:/ });
    await expect(high).toBeVisible({ timeout: 60_000 });
    await high.click();
    await expect(page).toHaveURL(/\/tasks\?priority=high$/, { timeout: 60_000 });
    await onlyOne(rowOf(page, HIGH_OVERDUE), "the High overdue task in the list");
    await expect(rowOf(page, MEDIUM_DOING)).toHaveCount(0);
    await expect(box(page, "Priority")).toContainText("High");

    // …and a Status donut line opens the list on that status.
    await openAppPage(page, "/tasks/overview", /Tasks overview/);
    const doing = page.getByTestId("overview-status").getByRole("link", { name: /^In progress:/ });
    await expect(doing).toBeVisible({ timeout: 60_000 });
    await doing.click();
    await expect(page).toHaveURL(/\/tasks\?status=in_progress$/, { timeout: 60_000 });
    await onlyOne(rowOf(page, MEDIUM_DOING), "the In progress task in the list");
    await expect(rowOf(page, HIGH_OVERDUE)).toHaveCount(0);
  });
});
