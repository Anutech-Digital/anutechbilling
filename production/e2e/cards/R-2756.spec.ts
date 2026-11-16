/**
 * Card test — R-2756 "One overdue-days number everywhere (row, AI box, Top risk); a Won't-renew
 * customer is not Top risk and gets no Nudge / Voice note".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2756`.
 *
 * Data (fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   · "CT R2756 Overdue Pvt Ltd"  — annual, renewal date 14 days ago, nothing sent (At risk, chased)
 *   · "CT R2756 Leaving Pvt Ltd"  — Won't renew, ends in 10 days, big MRR (was the header's "Top risk")
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST_O = "c2756000-0000-4000-8000-000000000001";
const CUST_W = "c2756000-0000-4000-8000-000000000002";
const SUB_O = "c2756000-0000-4000-8000-000000000021";
const SUB_W = "c2756000-0000-4000-8000-000000000022";
const NAME_O = "CT R2756 Overdue Pvt Ltd";
const NAME_W = "CT R2756 Leaving Pvt Ltd";
const db = () => localDb("R-2756");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    delete from public.subscriptions where id in ('${SUB_O}', '${SUB_W}') and tenant_id = ${T};
    delete from public.customers where id in ('${CUST_O}', '${CUST_W}') and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST_O}', ${T}, '${NAME_O}', 'ct2756o@example.test', '07', 'India'),
             ('${CUST_W}', ${T}, '${NAME_W}', 'ct2756w@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB_O}', ${T}, '${CUST_O}', '${NAME_O}', 'CT R2756 Overdue Plan', 'google', 1, 100, 12, 'yearly',
              public.ist_today() - 379, public.ist_today() - 14, 'active', 'notice_sent', true),
             ('${SUB_W}', ${T}, '${CUST_W}', '${NAME_W}', 'CT R2756 Leaving Plan', 'google', 1, 900000, 12, 'yearly',
              public.ist_today() - 355, public.ist_today() + 10, 'active', 'notice_sent', false);
    commit;`);
}

test.describe("R-2756 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Renewals Top risk + Renewal AI box — never the Won't renew customer; overdue days name their date", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1568, height: 900 });
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const top = page.getByText(/^Top risk:/).first();
    await expect(top).toBeVisible({ timeout: 90_000 });
    await expect(top).not.toContainText(NAME_W);
    /* the AI box (Forecast → Expand) reads the row's own day count and names its date */
    const expand = page.getByRole("button", { name: /Expand/ }).first();
    if (await expand.isVisible()) await expand.click();
    const ai = page.getByText(/renewals? at risk, worth/).locator("..");
    await expect(ai).toBeVisible({ timeout: 60_000 });
    const text = (await ai.innerText()).replace(/\s+/g, " ");
    expect(text).not.toContain(NAME_W);
    expect(text).not.toMatch(/Renewal \d+d overdue, not paid/i);
    /* the seeded Overdue row is chased and 14 days late, so the pick is an overdue row: its words are required */
    expect(text).toMatch(/(Part bill overdue|Invoice overdue) \d+d \(due \d{1,2} \w{3} \d{4}\)|(Part due|Renewal date passed) \d+d ago \(\d{1,2} \w{3} \d{4}\)/);
  });

  test("Step 2: the Won't renew row — no Nudge / Voice note / Follow up in ⋯", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1568, height: 900 });
    await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
    const r = page.locator("tr", { hasText: "CT R2756 Leaving Plan" }).filter({ visible: true });
    await expect(r).toHaveCount(1, { timeout: 90_000 });
    await expect(r.getByTestId("stage-chip")).toHaveAttribute("title", /^Won't renew · ends/, { timeout: 60_000 });
    const more = r.getByRole("button", { name: /More renewal actions/ });
    await expect(more).toBeVisible({ timeout: 60_000 });
    await more.click();
    await expect(page.getByRole("menuitem", { name: /Undo Won't renew/ })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("menuitem", { name: /Nudge|Voice note|Follow up/ })).toHaveCount(0);
  });

  test("Step 3: the customer page next best action says Won't renew · ends <date>", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, `/customers/${CUST_W}`, new RegExp(NAME_W));
    await expect(page.getByText(/^Won't renew · ends \d{1,2} \w{3} \d{4}$/)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("button", { name: /Send renewal quote/ })).toHaveCount(0);
  });
});
