/**
 * Card test — R-2942 "Tasks pages: width + cut-off names, 'Sales' eyebrow on Overview / Calendar,
 * Tasks highlighted on the Team tab, filter stays after a List / sidebar click".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2942` (no migration).
 *
 * Planted fresh on every run and removed after it (fixed ids, local docker DB only), all owned
 * by the Owner login, none linked to a customer:
 *   FITS  — Medium, with a note, due 3 days ago. 51 letters: on the 1100px page with the type
 *           word on the line it was cut at 1280 px; now it shows whole.
 *   LONG  — Medium, due 3 days ago, a name no 1280 px line can hold: cut on the line, whole on a click.
 *   HIGH  — High, due in 40 days (the one task the Priority = High step must keep).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, pathOf } from "./card-steps";

const CARD = "R-2942";
const T = E2E_TENANT_SQL;
const OWNER = `(select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = ${T})`;
const id = (n: number) => `c2942000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const FITS = "CT R2942 Set up seats (DNS, users) for the new team";
const LONG = "CT R2942 Long name: renew the domain, move the mailboxes, tell the customer and send the invoice today";
const HIGH = "CT R2942 high priority visit";
const CLEAN = `delete from public.tasks where tenant_id = ${T} and id in ('${id(1)}', '${id(2)}', '${id(3)}');`;

function seed(): void {
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, owner_id, title, kind, status, priority, due_at, notes) values
      ('${id(1)}', ${T}, ${OWNER}, '${FITS}', 'custom', 'pending', 'medium', now() - interval '3 days', 'CT R2942 note'),
      ('${id(2)}', ${T}, ${OWNER}, '${LONG}', 'followup', 'pending', 'medium', now() - interval '3 days' - interval '5 seconds', null),
      ('${id(3)}', ${T}, ${OWNER}, '${HIGH}', 'meeting', 'pending', 'high', now() + interval '40 days', null);
    commit;`);
}

/** The sidebar's own menu (desktop rail) — not the Tasks tab strip, which is a <nav> too. */
const sidebar = (page: Page): Locator => page.locator("aside nav");
/** The tab strip at the top of a Tasks page. */
const tabs = (page: Page): Locator => page.getByRole("navigation", { name: "Tasks views" });
const rows = (page: Page) => page.getByRole("main").getByRole("listitem");
const rowOf = (page: Page, title: string) => rows(page).filter({ hasText: title });
const priorityBox = (page: Page) => page.getByTestId("task-filter-bar").getByRole("combobox", { name: "Priority", exact: true });
const searchBox = (page: Page) => page.getByRole("searchbox", { name: "Search tasks" });
const leftOf = async (l: Locator): Promise<number> => Math.round((await l.boundingBox())!.x);
/** Is the element's text cut off (it needs more width than it has)? */
const isCut = (l: Locator): Promise<boolean> => l.evaluate((el) => el.scrollWidth > el.clientWidth);
/** The width the element's text needs and the width it has, in px. */
const room = (l: Locator): Promise<{ needs: number; has: number }> => l.evaluate((el) => ({ needs: el.scrollWidth, has: el.clientWidth }));

const PAGES = [
  { label: "Overview", path: "/tasks/overview", heading: /Tasks overview/ },
  { label: "List", path: "/tasks", heading: /^Tasks$/ },
  { label: "Calendar", path: "/tasks/calendar", heading: /Task calendar/ },
  { label: "Team", path: "/reports/team-tasks", heading: /Team tasks/ },
] as const;

/** Open /tasks (with a query string or not) and wait until the list has loaded. */
async function openTasks(page: Page, path = "/tasks", wait = FITS): Promise<void> {
  await openAppPage(page, path, /^Tasks$/);
  await onlyOne(rowOf(page, wait), `the planted task "${wait}"`);
}
async function pickPriority(page: Page, option: RegExp): Promise<void> {
  await priorityBox(page).click();
  const item = page.getByRole("option", { name: option });
  await expect(item).toBeVisible({ timeout: 30_000 });
  await item.click();
  await expect(page.getByRole("option")).toHaveCount(0);
}
/** The sidebar's row links, in order (a count badge is its own link with a query string). */
async function sidebarRows(page: Page): Promise<string[]> {
  return (await sidebar(page).locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href") ?? "")))
    .filter((h) => !h.includes("?"));
}
const tasksRow = (page: Page): Locator => sidebar(page).locator('a[href="/tasks"]').filter({ hasText: "Tasks" }).first();
const background = (l: Locator): Promise<string> => l.evaluate((el) => getComputedStyle(el).backgroundColor);

test.describe("R-2942 — Tasks pages: width, names, no 'Sales', Team tab, filters cleared by List / sidebar", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 800 });
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
  });

  test("Step 1: Overview, List and Calendar have no 'SALES' above the title", async () => {
    for (const p of PAGES.slice(0, 3)) {
      await openAppPage(page, p.path, p.heading);
      const title = await onlyOne(page.getByRole("main").getByRole("heading", { level: 1, name: p.heading }), `the ${p.label} title`);
      // The small grey word above a title sits in the title's own block.
      await expect(title.locator("xpath=..").getByText("Sales", { exact: true }), `${p.path}: no 'Sales' above the title`).toHaveCount(0);
    }
  });

  test("Step 2: on a 1280 screen the task's name shows whole, with the actions still on the line", async () => {
    await openTasks(page);
    const row = await onlyOne(rowOf(page, FITS), "the planted task's row");
    const name = await onlyOne(row.getByRole("button", { name: FITS, exact: true }), "its name");
    const r = await room(name);
    expect(r.needs, `the name needs ${r.needs}px and has ${r.has}px at 1280 — it must not be cut`).toBeLessThanOrEqual(r.has);
    // The type word is off the line at this width (kept for a screen reader); the icon says it on hover.
    const word = await onlyOne(row.getByText("Task", { exact: true }), "the type word");
    expect((await word.boundingBox())?.width ?? 0, "the type word takes no room on the line at 1280").toBeLessThanOrEqual(1);
    await onlyOne(row.getByTitle("Task", { exact: true }), "the type icon with its hover text");

    // Still one line, the whole row inside the screen, nothing scrolls sideways (R-2937).
    const box = (await row.boundingBox())!;
    expect(box.height, "row height").toBeLessThanOrEqual(40);
    for (const action of ["Edit task", "Snooze", "Delete"]) await onlyOne(row.getByRole("button", { name: action, exact: true }), action);
    const del = (await row.getByRole("button", { name: "Delete", exact: true }).boundingBox())!;
    expect(del.x + del.width, "the last action button ends inside the screen").toBeLessThanOrEqual(1280);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);

    // A name no line can hold is cut on the line — and a click on it shows all of it.
    const longRow = await onlyOne(rowOf(page, LONG), "the long-named task's row");
    const longName = await onlyOne(longRow.getByRole("button", { name: LONG, exact: true }), "the long name");
    expect(await isCut(longName), "the long name is cut on the line").toBe(true);
    await expect(longName).toHaveAttribute("title", LONG);
    await longName.click();
    await expect(longName).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => isCut(longName), { message: "opened, the long name shows whole" }).toBe(false);
    await longName.click();
    await expect.poll(() => isCut(longName)).toBe(true);
  });

  test("Step 3: on a wide screen the four Tasks pages use the room and line up", async () => {
    await page.setViewportSize({ width: 1700, height: 900 });
    try {
      const widths: number[] = [];
      for (const p of PAGES) {
        await openAppPage(page, p.path, p.heading);
        const bar = await onlyOne(page.getByTestId("tasks-tabs-bar"), "the tab strip's frame");
        const strip = await onlyOne(tabs(page), "the Tasks tab strip");
        const title = await onlyOne(page.getByRole("main").getByRole("heading", { level: 1, name: p.heading }), `the ${p.label} title`);
        const w = Math.round((await bar.boundingBox())!.width);
        widths.push(w);
        // 1700 − the 240px sidebar = 1460: the page is no longer held at 1100px.
        expect(w, `${p.path}: width of the page at 1700`).toBeGreaterThan(1300);
        expect(await leftOf(title), `${p.path}: the title starts where the tabs start`).toBe(await leftOf(strip));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), `${p.path} fits`).toBe(true);
      }
      expect(new Set(widths).size, `the four pages are the same width (${widths.join(", ")})`).toBe(1);

      // The list fills that width: its right edge is the tab strip's right edge.
      await openTasks(page);
      const list = (await page.getByTestId("task-list").boundingBox())!;
      const strip = (await tabs(page).boundingBox())!;
      expect(Math.abs(list.x + list.width - (strip.x + strip.width)), "list and tab strip end at the same place").toBeLessThanOrEqual(1);
    } finally {
      await page.setViewportSize({ width: 1280, height: 800 });
    }
  });

  test("Step 4: on the Team tab the sidebar keeps Tasks highlighted and does not change its menu", async () => {
    await openTasks(page);
    const before = await sidebarRows(page);
    const active = await background(tasksRow(page));
    const idle = await background(sidebar(page).locator('a[href="/today"]').first());
    expect(active, "on /tasks the Tasks row is the highlighted one").not.toBe(idle);

    await tabs(page).getByRole("link", { name: "Team", exact: true }).click();
    await expect.poll(() => pathOf(page), { timeout: 60_000 }).toBe("/reports/team-tasks");
    await expect(page.getByRole("heading", { name: /Team tasks/ }).first()).toBeVisible({ timeout: 60_000 });
    await expect(tabs(page).getByRole("link", { name: "Team", exact: true })).toHaveAttribute("aria-current", "page");

    await expect.poll(() => background(tasksRow(page)), { message: "Tasks stays highlighted on the Team tab" }).toBe(active);
    expect(await sidebarRows(page), "the sidebar shows the same rows as on the Tasks list").toEqual(before);
    expect(await sidebarRows(page), "the Accounts menu did not open").not.toContain("/accounting/banking");
  });

  test("Step 5: Priority = High, then the List tab — every task is back and the filter is cleared", async () => {
    await openTasks(page);
    await pickPriority(page, /^High \(\d+\)$/);
    await expect(page).toHaveURL(/[?&]priority=high(&|$)/);
    await onlyOne(rowOf(page, HIGH), "the High task");
    await expect(rowOf(page, FITS)).toHaveCount(0);

    await tabs(page).getByRole("link", { name: "List", exact: true }).click();
    await expect(page).toHaveURL(/\/tasks$/, { timeout: 60_000 });
    await onlyOne(rowOf(page, FITS), "the Medium task, back after pressing List");
    await expect(priorityBox(page)).toHaveText(/^All priorities/);
    // The address and the screen agree after a reload too.
    await page.reload();
    await onlyOne(rowOf(page, FITS), "the Medium task after a reload");
  });

  test("Step 6: search + Priority, then 'Tasks' in the sidebar — search and filter are cleared", async () => {
    await openTasks(page);
    await fillKept(searchBox(page), "CT R2942 high");
    await pickPriority(page, /^High \(\d+\)$/);
    await expect(page).toHaveURL(/[?&]priority=high(&|$)/);
    await expect(page).toHaveURL(/[?&]q=CT/);
    await expect(rows(page)).toHaveCount(1);
    await onlyOne(rowOf(page, HIGH), "the one task the search and High leave");

    await tasksRow(page).click();
    await expect(page).toHaveURL(/\/tasks$/, { timeout: 60_000 });
    await expect(searchBox(page)).toHaveValue("");
    await expect(priorityBox(page)).toHaveText(/^All priorities/);
    await onlyOne(rowOf(page, FITS), "the Medium task, back after pressing Tasks in the sidebar");
    await onlyOne(rowOf(page, LONG), "the long-named task, back too");
  });
});
