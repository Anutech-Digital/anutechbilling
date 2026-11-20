/**
 * Card test — R-2965 "Scorecards: every KPI opens the records behind its number".
 *
 * LOCAL app (E2E Test Co) through the Local test login (Owner). Plants two DONE tasks owned by
 * the Owner, completed a minute ago (real dates): one due at 09:00 IST two days ago (2 days
 * late) and one due tomorrow (on time). Revenue is checked on
 * the Owner's real payments of this month — no money row is planted (a payment posts to the
 * books): the Sheet's number must be the tile's and its rows must add up to it, or, with none,
 * say so in words.
 * Run: `node scripts/ops/card-tests.mjs R-2965`. Planted rows have fixed ids and are removed after.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CARD = "R-2965";
const T = E2E_TENANT_SQL;
const OWNER = `(select u.id from public.users u where u.email = 'e2e-owner@example.test' and u.tenant_id = ${T})`;
const id = (n: number) => `c2965000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const LATE = "CT R2965 finished two days late";
const ONTIME = "CT R2965 finished before its due date";
/** 09:00 IST, two IST days before today. */
const DUE_2_DAYS_AGO = `(((now() at time zone 'Asia/Kolkata')::date - 2) + time '09:00') at time zone 'Asia/Kolkata'`;
const CLEAN = `delete from public.tasks where tenant_id = ${T} and id in ('${id(1)}', '${id(2)}');`;

function seed(): void {
  localDb(CARD).psql(`
    begin;
    ${CLEAN}
    insert into public.tasks (id, tenant_id, owner_id, title, kind, status, priority, due_at, completed_at) values
      ('${id(1)}', ${T}, ${OWNER}, '${LATE}', 'custom', 'done', 'medium', ${DUE_2_DAYS_AGO}, now() - interval '1 minute'),
      ('${id(2)}', ${T}, ${OWNER}, '${ONTIME}', 'custom', 'done', 'medium', now() + interval '1 day', now() - interval '1 minute');
    commit;`);
}

/** "₹1,23,456.50" / "₹64.9K" → rupees (K / L / Cr understood). */
function rupees(text: string): number {
  const m = /₹\s?([\d,]+(?:\.\d+)?)\s*(K|L|Cr)?/.exec(text);
  if (!m) throw new Error(`no rupee amount in "${text}"`);
  const n = Number(m[1].replace(/,/g, ""));
  return n * (m[2] === "K" ? 1e3 : m[2] === "L" ? 1e5 : m[2] === "Cr" ? 1e7 : 1);
}

test.describe("R-2965 — every scorecard number opens the records behind it", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  let page: Page;
  let owner = "";
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    owner = localDb(CARD).one(`select ${OWNER}`);
    page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 800 });
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    localDb(CARD).psql(`begin; ${CLEAN} commit;`);
  });

  const sheet = () => page.getByTestId("kpi-records-sheet");
  const close = async () => { await page.keyboard.press("Escape"); await expect(sheet()).toHaveCount(0); };

  test("Step 1: Scorecards opens; every number is a button", async () => {
    await openAppPage(page, `/scorecard?user=${owner}`, /Scorecards/);
    for (const kpi of ["revenue", "dealsWon", "quotes", "payments", "present", "tasksOnTime", "tasksLate", "activity"]) {
      const b = await onlyOne(page.getByTestId(`kpi-${kpi}-${owner}`), `the ${kpi} button`);
      await expect(b).toHaveAttribute("aria-label", /— show the records$/);
    }
  });

  test("Step 2: Revenue — the Sheet shows the tile's amount and payments that add up to it (or says there are none)", async () => {
    const tile = page.getByTestId(`kpi-revenue-${owner}`);
    const tileText = (await tile.getAttribute("aria-label")) ?? "";
    await tile.click();
    await expect(sheet()).toBeVisible({ timeout: 60_000 });
    const head = (await sheet().getByTestId("kpi-sheet-value").textContent()) ?? "";
    expect(tileText).toContain(head);
    const table = sheet().getByRole("table");
    if (rupees(head) === 0) {
      await expect(sheet().getByText(/No payments recorded by .+ in \w+ \d{4}\./)).toBeVisible();
    } else {
      const amounts = await table.locator("tbody tr td:last-child").allTextContents();
      const exact = rupees((await sheet().getByTestId("kpi-sheet-exact").textContent()) ?? "");
      // The list paints 100 rows, then "Load more" — add up only when every row is on screen.
      if (amounts.length < 100) {
        const sum = amounts.reduce((s, t) => s + rupees(t), 0);
        expect(Math.abs(sum - exact)).toBeLessThan(0.01);
      }
      const link = table.locator("tbody tr").first().getByRole("link");
      await expect(link).toHaveAttribute("href", /^\/(quotes|invoices)\//);
    }
    await close();
  });

  test("Step 3: Tasks late — the late task with how many days late; the on-time one is not there", async () => {
    await page.reload();
    const tile = page.getByTestId(`kpi-tasksLate-${owner}`);
    await expect(tile).toBeVisible({ timeout: 60_000 });
    const n = Number(/Tasks late (\d[\d,]*)/.exec((await tile.getAttribute("aria-label")) ?? "")?.[1].replace(/,/g, ""));
    expect(n).toBeGreaterThanOrEqual(1);
    await tile.click();
    await expect(sheet()).toBeVisible({ timeout: 60_000 });
    await expect(sheet().getByTestId("kpi-sheet-value")).toHaveText(String(n.toLocaleString("en-IN")));
    const rows = sheet().getByRole("table").locator("tbody tr");
    await expect(rows).toHaveCount(Math.min(n, 100));
    const late = await onlyOne(rows.filter({ hasText: LATE }), "the late task's row");
    await expect(late.locator("td").last()).toHaveText("2");
    await expect(late.getByRole("link", { name: LATE })).toHaveAttribute("href", `/tasks?task=${id(1)}`);
    await expect(rows.filter({ hasText: ONTIME }), "the on-time task is not in Tasks late").toHaveCount(0);
    await close();
    await page.getByTestId(`kpi-tasksOnTime-${owner}`).click();
    await expect(sheet()).toBeVisible({ timeout: 60_000 });
    await onlyOne(sheet().getByRole("table").locator("tbody tr").filter({ hasText: ONTIME }), "the on-time task's row");
    await close();
  });

  test("Step 4: Activity — counts by type, adding up to the number", async () => {
    const tile = page.getByTestId(`kpi-activity-${owner}`);
    const shown = ((await tile.textContent()) ?? "").trim();
    await tile.click();
    await expect(sheet()).toBeVisible({ timeout: 60_000 });
    await expect(sheet().getByTestId("kpi-sheet-value")).toHaveText(shown);
    if (shown === "0") {
      await expect(sheet().getByText(/No changes made by .+ in the app/)).toBeVisible();
    } else {
      const counts = await sheet().getByRole("table", { name: "Activity by type" }).locator("tbody tr td:last-child").allTextContents();
      expect(counts.reduce((s, t) => s + Number(t.replace(/,/g, "")), 0)).toBe(Number(shown.replace(/,/g, "")));
    }
    await close();
  });
});
