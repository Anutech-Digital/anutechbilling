/**
 * Card test — R-2937 "Tasks List: one-line compact rows (default) + Comfortable toggle + sticky
 * group headers" (/tasks).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2937` (no migration).
 *
 * Planted fresh on every run and removed after it (fixed ids, local docker DB only), all owned
 * by the Owner login:
 *   14 overdue tasks, due exactly 3 days ago ("Overdue by 3 days" whatever the weekday) — the
 *      first one High priority with a description;
 *   1 task due in 20 minutes ("Today …", or "Tomorrow …" in the last minutes of the day);
 *   1 task due in 40 days (a date).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2937";
const T = E2E_TENANT_SQL;
const OWNER = `(select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = ${T})`;
const id = (n: number) => `c2937000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const OVERDUE_COUNT = 14;
const FIRST = "CT R2937 overdue 01 chase payment";
const NOTE = "CT R2937 note: ask for the UTR number";
const SOON = "CT R2937 soon call";
const LATER = "CT R2937 later visit";
const ALL_IDS = Array.from({ length: OVERDUE_COUNT + 2 }, (_, i) => `'${id(i + 1)}'`).join(", ");
const CLEAN = `delete from public.tasks where tenant_id = ${T} and id in (${ALL_IDS});`;

function seed(): void {
  const overdue = Array.from({ length: OVERDUE_COUNT }, (_, i) => {
    const n = i + 1;
    const title = n === 1 ? FIRST : `CT R2937 overdue ${String(n).padStart(2, "0")}`;
    // A few seconds apart so the order in the group is fixed; all exactly 3 IST days back.
    return `('${id(n)}', ${T}, ${OWNER}, '${title}', 'followup', 'pending', '${n === 1 ? "high" : "medium"}', now() - interval '3 days' - interval '${n} seconds', ${n === 1 ? `'${NOTE}'` : "null"})`;
  });
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, owner_id, title, kind, status, priority, due_at, notes) values
      ${overdue.join(",\n      ")},
      ('${id(OVERDUE_COUNT + 1)}', ${T}, ${OWNER}, '${SOON}', 'call', 'pending', 'medium', now() + interval '20 minutes', null),
      ('${id(OVERDUE_COUNT + 2)}', ${T}, ${OWNER}, '${LATER}', 'meeting', 'pending', 'low', now() + interval '40 days', null);
    commit;`);
}

const rows = (page: Page) => page.getByRole("main").getByRole("listitem");
const rowOf = (page: Page, title: string) => rows(page).filter({ hasText: title });

/** Open /tasks and wait until the list has loaded (the planted overdue task's row shows). */
async function openTasks(page: Page): Promise<Locator> {
  await openAppPage(page, "/tasks", /^Tasks$/);
  return onlyOne(rowOf(page, FIRST), "the first planted overdue task's row");
}

test.describe("R-2937 — Tasks list: one-line rows, Comfortable, sticky group headings", () => {
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

  test("Step 1: Tasks opens with every task on one line", async () => {
    const first = await openTasks(page);
    await expect(page.getByTestId("task-list")).toHaveAttribute("data-density", "compact");
    await expect(first).toHaveAttribute("data-density", "compact");
    // The description is not on the line.
    await expect(first.getByText(NOTE)).toHaveCount(0);
  });

  test("Step 2: a line has name, who, priority, status and due in words; 12+ tasks fit 1280×800", async () => {
    const first = await onlyOne(rowOf(page, FIRST), "the first planted overdue task's row");
    await onlyOne(first.getByRole("checkbox", { name: `Mark done: ${FIRST}` }), "the done circle");
    await onlyOne(first.getByRole("button", { name: FIRST, exact: true }), "the task's name");
    await onlyOne(first.getByText(/^Assigned to /), "who has the task");
    await onlyOne(first.getByText("High", { exact: true }), "the priority badge");
    await onlyOne(first.getByRole("button", { name: /^Status: Not started/ }), "the status menu");
    await onlyOne(first.getByText("Overdue by 3 days", { exact: true }), "the due words");
    for (const name of ["Edit task", "Snooze", "Delete"]) await onlyOne(first.getByRole("button", { name, exact: true }), name);

    // Due today (or, in the last minutes of the day, tomorrow) says the time; far ahead says the date.
    await onlyOne(rowOf(page, SOON).getByText(/^(Today|Tomorrow) \d{1,2}(:\d{2})? (am|pm)$/), "the soon task's due words");
    await onlyOne(rowOf(page, LATER).getByText(/^([A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2}|\d{1,2} [A-Z][a-z]{2} \d{4})$/), "the far task's due date");

    // One line each: 12 or more whole rows on the first screen, none taller than a single line.
    await page.evaluate(() => window.scrollTo(0, 0));
    const boxes = await rows(page).evaluateAll((els) => els.map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, height: r.height };
    }));
    const onScreen = boxes.filter((b) => b.top >= 0 && b.bottom <= 800);
    expect(onScreen.length, `whole task rows on a 1280×800 screen (heights: ${boxes.slice(0, 5).map((b) => Math.round(b.height)).join(", ")})`).toBeGreaterThanOrEqual(12);
    expect(Math.max(...onScreen.map((b) => b.height)), "tallest row on the first screen").toBeLessThanOrEqual(40);

    // Fits 1280: no sideways scroll, and the last action button is inside the screen.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    const del = await first.getByRole("button", { name: "Delete", exact: true }).boundingBox();
    expect(del && del.x + del.width).toBeLessThanOrEqual(1280);
  });

  test("Step 3: a click on the name opens the description under the line", async () => {
    const first = await onlyOne(rowOf(page, FIRST), "the first planted overdue task's row");
    const name = first.getByRole("button", { name: FIRST, exact: true });
    await expect(name).toHaveAttribute("aria-expanded", "false");
    await name.click();
    await expect(name).toHaveAttribute("aria-expanded", "true");
    await onlyOne(first.getByText(NOTE), "the description");
    await name.click();
    await expect(first.getByText(NOTE)).toHaveCount(0);
  });

  test("Step 4: Comfortable brings back the roomy card, is remembered, and switches back", async () => {
    const toggle = page.getByRole("main").getByRole("button", { name: "Comfortable", exact: true });
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    let first = await onlyOne(rowOf(page, FIRST), "the row in Comfortable");
    await expect(first).toHaveAttribute("data-density", "comfortable");
    await onlyOne(first.getByText(NOTE), "the description, showing without a click");
    await expect(first.getByText(/Overdue ·/)).toBeVisible();

    // Remembered: a reload opens Comfortable again.
    first = await openTasks(page);
    await expect(first).toHaveAttribute("data-density", "comfortable", { timeout: 30_000 });
    const again = page.getByRole("main").getByRole("button", { name: "Comfortable", exact: true });
    await expect(again).toHaveAttribute("aria-pressed", "true");

    await again.click();
    await expect(again).toHaveAttribute("aria-pressed", "false");
    await expect(await onlyOne(rowOf(page, FIRST), "the row back on one line")).toHaveAttribute("data-density", "compact");
  });

  test("Step 5: scrolling down, the 'Overdue' heading stays stuck at the top", async () => {
    await page.setViewportSize({ width: 1280, height: 400 }); // short screen: the Overdue group is taller than it
    const heading = page.locator("#task-group-overdue");
    await expect(heading).toBeVisible({ timeout: 60_000 });
    await expect(heading).toContainText("Overdue");
    await page.evaluate(() => window.scrollTo(0, 0));
    const before = (await heading.boundingBox())!;
    // Scroll far enough that the heading's own place has left the screen, with its group still showing.
    await page.evaluate((y) => window.scrollTo(0, y), Math.round(before.y) + 60);
    await expect.poll(async () => Math.round((await heading.boundingBox())!.y), { timeout: 15_000 }).toBeGreaterThanOrEqual(0);
    const after = (await heading.boundingBox())!;
    expect(after.y, "the heading is still on screen").toBeGreaterThanOrEqual(0);
    expect(after.y, "… near the top, under the top bar").toBeLessThanOrEqual(120);
    await expect(heading).toBeInViewport();
    // A row further down the same group is on screen under it.
    await expect(rowOf(page, "CT R2937 overdue 08")).toBeInViewport();
    await page.setViewportSize({ width: 1280, height: 800 });
  });
});
