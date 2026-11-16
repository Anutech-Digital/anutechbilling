/**
 * Card test — R-2857 "Renewals drawer + rows polish".
 *
 * Display only (found on staging in a Chrome human test, 16 Nov):
 *   1. the drawer's History tabs All · Quotes · Invoices · Payments · Timeline sit on ONE line (480px drawer);
 *   2. Flags say "At risk" once — never "At risk — At risk";
 *   3. phones read one way, "+91 98765 98765", however they were saved (+919876598765 / +91-9898989898 /
 *      9876543210) — rows and drawer; a plan name that already carries "(1 seats)" gets no second "· 1 seats".
 * The row's "quote ₹92.0K" (queue.ts) and the table row's own seat text (row-cells.tsx) belong to R-2854.
 * Run: `node scripts/ops/card-tests.mjs R-2857`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): three customers
 * whose phones are saved three ways, one yearly subscription each — A is 3 days overdue (so it is At risk)
 * with the seat count in its plan name; B and C renew in 12 / 13 days.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const ROWS = [
  { cust: "c2857000-0000-4000-8000-000000000001", sub: "c2857000-0000-4000-8000-000000000021", name: "CT R2857 First Point", saved: "+919876598765", shown: "+91 98765 98765", plan: "CT R2857 Workspace Starter (1 seats)", seats: 1, due: -3 },
  { cust: "c2857000-0000-4000-8000-000000000002", sub: "c2857000-0000-4000-8000-000000000022", name: "CT R2857 Dash Phone", saved: "+91-9898989898", shown: "+91 98989 89898", plan: "CT R2857 Workspace Standard", seats: 1, due: 12 },
  { cust: "c2857000-0000-4000-8000-000000000003", sub: "c2857000-0000-4000-8000-000000000023", name: "CT R2857 Bare Phone", saved: "9876543210", shown: "+91 98765 43210", plan: "CT R2857 Workspace Plus", seats: 4, due: 13 },
] as const;
const [A, B, C] = ROWS;
const db = () => localDb("R-2857");
const T = E2E_TENANT_SQL;
const ids = (k: "cust" | "sub") => ROWS.map((r) => `'${r[k]}'`).join(", ");

function clean(): void {
  db().psql(`begin;
    delete from public.subscriptions where id in (${ids("sub")}) and tenant_id = ${T};
    delete from public.customers where id in (${ids("cust")}) and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    ${ROWS.map((r) => `
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${r.cust}', ${T}, '${r.name}', 'ct2857@example.test', '${r.saved}', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${r.sub}', ${T}, '${r.cust}', '${r.name}', '${r.plan}', 'google', ${r.seats}, 1667, 12, 'yearly',
              public.ist_today() + ${r.due} - 365, public.ist_today() + ${r.due}, 'active', 'notice_sent', true, 0, 0);`).join("")}
    commit;`);
}

async function openDrawer(page: Page, row: (typeof ROWS)[number], bucket: string): Promise<ReturnType<Page["getByTestId"]>> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAppPage(page, `/renewals?bucket=${bucket}&sub=${row.sub}`);
  const drawer = page.getByTestId("renewal-drawer");
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByRole("heading", { name: row.name })).toBeVisible({ timeout: 60_000 });
  return drawer;
}

test.describe("R-2857 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: History tabs All · Quotes · Invoices · Payments · Timeline are on one line in the drawer", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const drawer = await openDrawer(page, A, "urgent");
    const tabs = drawer.getByTestId("renewal-drawer-history").getByRole("tab");
    await expect(tabs).toHaveText([/^All\d+$/, /^Quotes\d+$/, /^Invoices\d+$/, /^Payments\d+$/, /^Timeline\d+$/], { timeout: 60_000 });
    const boxes = await tabs.evaluateAll((els) => els.map((e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), right: b.right }; }));
    expect(new Set(boxes.map((b) => b.top)).size, `tab tops ${boxes.map((b) => b.top).join(", ")}`).toBe(1);
    /* with room to spare: two-digit counts on every tab (about 7px each) still fit the 480px drawer */
    const strip = drawer.getByTestId("renewal-drawer-history-tabs");
    const spare = await strip.evaluate((el) => el.getBoundingClientRect().right - Math.max(...[...el.querySelectorAll("[role=tab]")].map((t) => t.getBoundingClientRect().right)));
    expect(spare, `spare width after the last tab: ${Math.round(spare)}px`).toBeGreaterThanOrEqual(35);
    expect(await drawer.evaluate((el) => el.scrollWidth - el.clientWidth), "drawer has no horizontal scroll").toBeLessThanOrEqual(1);
  });

  test("Step 2: Flags say 'At risk' once", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const drawer = await openDrawer(page, A, "urgent");
    const flag = drawer.locator("[data-testid=renewal-drawer-flag][data-flag=atRisk]");
    await expect(flag).toBeVisible({ timeout: 60_000 });
    const line = (await flag.locator("p").first().textContent()) ?? "";
    expect(line).toMatch(/^At risk/);
    expect(line.match(/At risk/g)?.length, `flag line: "${line}"`).toBe(1);
  });

  test("Step 3: phones read one way on rows and in the drawer; the seat count is said once", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const drawer = await openDrawer(page, A, "urgent");
    await expect(drawer.getByTestId("renewal-contact")).toContainText(A.shown);
    /* the plan name already says "(1 seats)" — no second count after it */
    const head = (await drawer.textContent()) ?? "";
    expect(head).toContain(`${A.plan} · Google`);
    expect(head).not.toMatch(/\(1 seats\) · 1 seats?/);

    await page.setViewportSize({ width: 1280, height: 800 });
    await openAppPage(page, "/renewals?bucket=d30");
    for (const r of [B, C]) {
      const row = page.locator("tr", { hasText: r.name });
      await expect(row).toBeVisible({ timeout: 60_000 });
      await expect(row).toContainText(r.shown, { timeout: 60_000 });   // the contacts are read after the rows paint
      await expect(row.locator(`a[href="tel:${r.shown.replace(/\s+/g, "")}"]`)).toHaveCount(1);
    }
    await expect(page.getByText(B.saved, { exact: true })).toHaveCount(0);
  });

  test("Step 3b: the row's quote amount in full (₹92,040, not ₹92.0K)", async () => {
    test.skip(true, "The row's 'quote ₹92.0K' is built in renewals/queue.ts, R-2854's file — R-2854 prints it in full (quote ₹92,040) and fixes the table row's seat text; its own card test checks both.");
  });
});
