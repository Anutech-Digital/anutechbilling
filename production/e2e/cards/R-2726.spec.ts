/**
 * Card test — R-2726: /admin/feedback (Settings › Bug Reports & AI Fixes) search, filters, sorting.
 *
 * howToCheck, on localhost (Local test login → Owner lands in E2E Test Co):
 *  1. Type "scorecards" in the search box → the planted Scorecards reports show, the other one does not.
 *  2. Filters → Reporter = Hitesh R2726, status tab Open → only his open report.
 *  3. Sort "Oldest first" / "Newest first" flips the order.
 *  4. Reload keeps the search, the filters and the sort (they are in the address).
 *  5. A row is one line; opening it shows the full report text and the buttons. "Real users"
 *     leaves out the report filed from a test address.
 *  6. A non-platform user (Manager) has no "All workspaces", ?scope=all changes nothing, and the
 *     platform route answers the same 403 with or without a search.
 *  7. Platform owner → All workspaces: the search also finds the report filed in ANOTHER
 *     workspace, with its workspace name; Workspace filter narrows to it. Needs a localhost where
 *     the test Owner is a platform admin (PLATFORM_ADMIN_EMAILS=e2e-owner@example.test in the
 *     shell that starts dev:local) — skipped otherwise.
 *
 * Data: three planted reports in E2E Test Co + one in the local "Demo Cloud Reseller" tenant
 * (fixed ids, local DB only, removed afterwards). Run: `node scripts/ops/card-tests.mjs R-2726`.
 */
import { expect, test, type Page } from "@playwright/test";
import { E2E_TENANT_SQL, fillKept, localDb, onlyInCardTests, onlyOne, pageAs, waitForHydrated } from "./card-steps";

const CARD = "R-2726";
const OWN_OPEN = "c2726000-0000-4000-8000-000000000001";   // Hitesh, open, 12 Nov
const OWN_FIXED = "c2726000-0000-4000-8000-000000000002";  // QA (test address), fixed, 10 Nov
const OWN_QUEUED = "c2726000-0000-4000-8000-000000000003"; // Hitesh, queued, 11 Nov
const OTHER_WS = "c2726000-0000-4000-8000-000000000004";   // Hitesh, another workspace
const IDS = [OWN_OPEN, OWN_FIXED, OWN_QUEUED, OTHER_WS];
const OTHER_TENANT = "d0000000-0000-4000-8000-000000000001"; // supabase/seed: Demo Cloud Reseller
const HITESH = "hitesh.r2726@r2726-realco.in";
const TOKEN = "zq2726";

function clear(): void {
  const list = IDS.map((i) => `'${i}'`).join(",");
  localDb(CARD).psql(`delete from public.feedback where id in (${list}) and title like '${TOKEN} %';`);
}
function otherTenantExists(): boolean {
  return localDb(CARD).one(`select count(*) from public.tenants where id = '${OTHER_TENANT}';`) === "1";
}
function seed(): void {
  clear();
  const row = (id: string, tenant: string, title: string, body: string, name: string, email: string, status: string, at: string, extra = "") =>
    `('${id}', ${tenant}, 'bug', 'high', '${title}', '${body}', '/reports/scorecards', '/reports/scorecards', '${name}', '${email}', '${status}', '${at}'${extra})`;
  const cols = "(id, tenant_id, reported_type, reported_severity, title, body, page_path, route_pattern, reporter_name, reporter_email, status, created_at";
  const db = localDb(CARD);
  db.psql(`
    insert into public.feedback ${cols}) values
      ${row(OWN_OPEN, E2E_TENANT_SQL, `${TOKEN} Scorecards total is wrong`, `${TOKEN} BODY-OWN-OPEN the total row adds the last month twice`, "Hitesh R2726", HITESH, "open", "2026-11-12T06:30:00Z")};
    insert into public.feedback ${cols}, agent_card) values
      ${row(OWN_FIXED, E2E_TENANT_SQL, `${TOKEN} Invoice PDF logo is cut`, `${TOKEN} BODY-OWN-FIXED logo cropped`, "QA Bot R2726", "qa.r2726@example.test", "fixed", "2026-11-10T05:00:00Z", ", 'R-9726'")};
    insert into public.feedback ${cols}, dispatched_at) values
      ${row(OWN_QUEUED, E2E_TENANT_SQL, `${TOKEN} Scorecards filter resets`, `${TOKEN} BODY-OWN-QUEUED filter resets on reload`, "Hitesh R2726", HITESH, "agent_queued", "2026-11-11T05:00:00Z", ", '2026-11-11T05:10:00Z'")};
    -- the fixed one was filed on another screen, so "scorecards" (which also matches the page path) does not find it
    update public.feedback set page_path = '/invoices', route_pattern = '/invoices' where id = '${OWN_FIXED}';`);
  if (otherTenantExists()) {
    db.psql(`insert into public.feedback ${cols}) values
      ${row(OTHER_WS, `'${OTHER_TENANT}'`, `${TOKEN} Scorecards export fails`, `${TOKEN} BODY-OTHER-WS export button does nothing`, "Hitesh R2726", HITESH, "open", "2026-11-12T07:00:00Z")};`);
  }
}

const rowOf = (page: Page, id: string) => page.getByTestId(`feedback-card-${id}`);
const count = (page: Page) => page.getByTestId("feedback-result-count");
const search = (page: Page) => page.getByRole("searchbox", { name: "Search reports" });

/** Open the page and wait until the list (or its empty state) has loaded. */
async function openFeedback(page: Page, query = ""): Promise<void> {
  await page.goto(`/admin/feedback${query}`);
  await waitForHydrated(page, count(page).filter({ hasText: /\d+ reports?/ }));
}
async function shownIds(page: Page): Promise<string[]> {
  const ids = await page.getByTestId("feedback-rows").locator("> li").evaluateAll((els) => els.map((e) => e.getAttribute("data-testid") ?? ""));
  return ids.map((t) => t.replace("feedback-card-", "")).filter((id) => IDS.includes(id));
}

test.describe("R-2726 — Bug Reports & AI Fixes: search, filters, sorting, compact rows", () => {
  onlyInCardTests();
  test.setTimeout(240_000);
  test.beforeAll(() => seed());
  test.afterAll(() => clear());

  test("Step 1: search 'scorecards' shows the planted Scorecards reports only", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openFeedback(page);
    await fillKept(search(page), `${TOKEN} scorecards`);
    await expect(count(page)).toHaveText("2 reports", { timeout: 60_000 });
    await expect(rowOf(page, OWN_OPEN)).toBeVisible();
    await expect(rowOf(page, OWN_QUEUED)).toBeVisible();
    await expect(rowOf(page, OWN_FIXED)).toHaveCount(0);
    await expect(rowOf(page, OTHER_WS)).toHaveCount(0); // another workspace's report never shows on "This workspace"
    await expect(page).toHaveURL(/[?&]q=zq2726\+scorecards/);
    // The status tabs count the same search.
    await expect(page.getByRole("tab", { name: /^Open/ })).toContainText("1");
    await page.context().close();
  });

  test("Step 2: reporter = Hitesh + status Open → only his open report", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openFeedback(page, `?q=${TOKEN}`);
    await expect(count(page)).toHaveText("3 reports", { timeout: 60_000 });
    const filters = await onlyOne(page.getByRole("button", { name: /^Filters/ }), "the Filters button");
    await expect(filters).toBeVisible({ timeout: 60_000 });
    await filters.click();
    const reporter = page.getByLabel("Reporter");
    await expect(reporter.locator(`option[value="${HITESH}"]`)).toHaveCount(1, { timeout: 60_000 });
    await reporter.selectOption(HITESH);
    await page.keyboard.press("Escape");
    await expect(count(page)).toHaveText("2 reports", { timeout: 60_000 });
    await page.getByRole("tab", { name: /^Open/ }).click();
    await expect(count(page)).toHaveText("1 report", { timeout: 60_000 });
    expect(await shownIds(page)).toEqual([OWN_OPEN]);
    await expect(page).toHaveURL(/status=open/);
    await expect(page).toHaveURL(/reporter=hitesh\.r2726%40r2726-realco\.in/);
    await page.context().close();
  });

  test("Step 3: Oldest first / Newest first flips the order", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openFeedback(page, `?q=${TOKEN}`);
    await expect(count(page)).toHaveText("3 reports", { timeout: 60_000 });
    expect(await shownIds(page)).toEqual([OWN_OPEN, OWN_QUEUED, OWN_FIXED]); // newest first is the default
    await page.getByLabel("Sort").selectOption("oldest");
    await expect(async () => expect(await shownIds(page)).toEqual([OWN_FIXED, OWN_QUEUED, OWN_OPEN])).toPass({ timeout: 60_000 });
    await page.getByLabel("Sort").selectOption("newest");
    await expect(async () => expect(await shownIds(page)).toEqual([OWN_OPEN, OWN_QUEUED, OWN_FIXED])).toPass({ timeout: 60_000 });
    await page.context().close();
  });

  test("Step 4: a reload keeps the search, the filters and the sort", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openFeedback(page, `?q=${TOKEN}&reporter=${encodeURIComponent(HITESH)}&sort=oldest`);
    await expect(count(page)).toHaveText("2 reports", { timeout: 60_000 });
    await page.reload();
    await waitForHydrated(page, count(page).filter({ hasText: /\d+ reports?/ }));
    await expect(search(page)).toHaveValue(TOKEN);
    await expect(page.getByLabel("Sort")).toHaveValue("oldest");
    await expect(count(page)).toHaveText("2 reports", { timeout: 60_000 });
    expect(await shownIds(page)).toEqual([OWN_QUEUED, OWN_OPEN]);
    await expect(page.getByRole("button", { name: /Remove filter: Reporter: Hitesh R2726/ })).toBeVisible();
    await page.context().close();
  });

  test("Step 5: a row is one line, opens to the full report + buttons; 'Real users' leaves out the test address", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openFeedback(page, `?q=${TOKEN}`);
    const row = rowOf(page, OWN_OPEN);
    const line = row.getByTestId("feedback-row");
    await expect(line).toContainText("12 Nov, 12:00 pm"); // 06:30 UTC in IST
    await expect(line).toContainText("Hitesh R2726");
    await expect(line).toContainText("/reports/scorecards");
    await expect(line).toContainText("Open");
    await expect(rowOf(page, OWN_FIXED).getByTestId("feedback-row")).toContainText("R-9726");
    await expect(page.getByText("BODY-OWN-OPEN")).toHaveCount(0);
    await line.click();
    await expect(row.getByTestId("feedback-body")).toContainText("BODY-OWN-OPEN");
    for (const name of [/Run AI Auto-Fix/, /Copy Directive/, /^Mark fixed$/, /^Won't fix$/]) {
      await expect(row.getByRole("button", { name })).toBeVisible();
    }
    // The table fits a 1280 px window: no sideways scroll.
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole("button", { name: "Real users" }).click();
    await expect(count(page)).toHaveText("2 reports", { timeout: 60_000 });
    await expect(rowOf(page, OWN_FIXED)).toHaveCount(0);
    await page.context().close();
  });

  test("Step 6: a non-platform user sees only their own workspace — no All workspaces, ?scope=all changes nothing, route says 403", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "manager");
    await openFeedback(page, `?scope=all&ws=${OTHER_TENANT}&q=${TOKEN}`);
    await expect(page.getByRole("button", { name: "All workspaces" })).toHaveCount(0);
    await expect(count(page)).toHaveText("3 reports", { timeout: 60_000 });
    await expect(rowOf(page, OTHER_WS)).toHaveCount(0);
    const bodies = new Set<string>();
    for (const qs of ["", `?q=${TOKEN}`, `?ws=${OTHER_TENANT}&q=export`, "?facets=1"]) {
      const res = await page.request.get(`/api/admin/feedback/platform${qs}`, { timeout: 60_000 });
      expect(res.status()).toBe(403);
      bodies.add(await res.text());
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).not.toContain(TOKEN);
    await page.context().close();
  });

  test("Step 7: platform owner → All workspaces finds the other workspace's report", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const who = (await (await page.request.get("/api/platform/whoami", { timeout: 60_000 })).json()) as { isPlatformAdmin?: boolean };
    test.skip(!who.isPlatformAdmin, "The local test Owner is not a platform admin on this localhost — start dev:local with PLATFORM_ADMIN_EMAILS=e2e-owner@example.test to run this step.");
    test.skip(!otherTenantExists(), "The local DB has no 'Demo Cloud Reseller' tenant (supabase/seed) to plant the other workspace's report in.");
    await openFeedback(page, `?q=${TOKEN}`);
    await page.getByRole("button", { name: "All workspaces" }).click();
    await expect(count(page)).toHaveText("4 reports", { timeout: 60_000 });
    await fillKept(search(page), `${TOKEN} scorecards`);
    await expect(count(page)).toHaveText("3 reports", { timeout: 60_000 });
    const other = rowOf(page, OTHER_WS);
    await expect(other.getByTestId("feedback-row")).toContainText("Demo Cloud Reseller");
    await other.getByTestId("feedback-row").click();
    await expect(other.getByTestId("feedback-body")).toContainText("BODY-OTHER-WS");
    await expect(other.getByRole("button", { name: /Send to AI/ })).toBeVisible();
    await expect(other.getByRole("button", { name: /^Mark fixed$/ })).toHaveCount(0); // that workspace's own job

    const filters = await onlyOne(page.getByRole("button", { name: /^Filters/ }), "the Filters button");
    await filters.click();
    await page.getByLabel("Workspace").selectOption(OTHER_TENANT);
    await page.keyboard.press("Escape");
    await expect(count(page)).toHaveText("1 report", { timeout: 60_000 });
    expect(await shownIds(page)).toEqual([OTHER_WS]);
    await page.context().close();
  });
});
