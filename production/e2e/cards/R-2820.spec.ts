/**
 * Card test — R-2820 "Renewals: Remind button counts only rows it can send, names the open view, greyed
 * with a reason at 0" (Renewals 12-question audit, 14 Nov).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co, grace 0 days) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2820`. NOTHING IS EMAILED: the dialog is closed with Cancel —
 * "Email N" is never pressed.
 *
 * Data (fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   · "CT R2820 Late Pvt Ltd"  — renewal date 6 days ago, yearly (Overdue; grace 0 → needs a call);
 *   · "CT R2820 Split Pvt Ltd" — renewal date 4 days ago, billed quarterly (Overdue; a part bill);
 *   · "CT R2820 Due Pvt Ltd"   — renews in 15 days, email on file (8–30 → can be reminded).
 * Other rows in the shared local DB vary, so the Overdue step ticks the two seeded rows.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const C_LATE = "c2820000-0000-4000-8000-000000000001";
const C_SPLIT = "c2820000-0000-4000-8000-000000000002";
const C_DUE = "c2820000-0000-4000-8000-000000000003";
const S_LATE = "c2820000-0000-4000-8000-000000000021";
const S_SPLIT = "c2820000-0000-4000-8000-000000000022";
const S_DUE = "c2820000-0000-4000-8000-000000000023";
const CUSTS = [C_LATE, C_SPLIT, C_DUE];
const SUBS = [S_LATE, S_SPLIT, S_DUE];
const LATE = "CT R2820 Late Pvt Ltd";
const SPLIT = "CT R2820 Split Pvt Ltd";
const DUE = "CT R2820 Due Pvt Ltd";
const db = () => localDb("R-2820");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  db().psql(`begin;
    delete from public.renewal_email_log where subscription_id in (${inList(SUBS)});
    delete from public.subscriptions where id in (${inList(SUBS)}) and tenant_id = ${T};
    delete from public.contacts where customer_id in (${inList(CUSTS)});
    delete from public.customers where id in (${inList(CUSTS)}) and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country) values
      ('${C_LATE}',  ${T}, '${LATE}',  'ct2820-late@example.test', '07', 'India'),
      ('${C_SPLIT}', ${T}, '${SPLIT}', 'ct2820-split@example.test', '07', 'India'),
      ('${C_DUE}',   ${T}, '${DUE}',   'ct2820-due@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount) values
      ('${S_LATE}',  ${T}, '${C_LATE}',  '${LATE}',  'CT R2820 Late Plan',  'google', 5, 500, 12, 'yearly',    public.ist_today() - 371, public.ist_today() - 6, 'active', 'notice_sent', true, 0),
      ('${S_SPLIT}', ${T}, '${C_SPLIT}', '${SPLIT}', 'CT R2820 Split Plan', 'google', 5, 500, 12, 'quarterly', public.ist_today() - 369, public.ist_today() - 4, 'active', 'notice_sent', true, 0),
      ('${S_DUE}',   ${T}, '${C_DUE}',   '${DUE}',   'CT R2820 Due Plan',   'google', 5, 500, 12, 'yearly',    public.ist_today() - 350, public.ist_today() + 15, 'active', 'pending', true, 0);
    commit;`);
}

async function openTab(page: Page, bucket: string, mustShow: string): Promise<void> {
  await openAppPage(page, `/renewals?bucket=${bucket}`, /Renewals/);
  await expect(page.locator("tr", { hasText: mustShow }).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
}

async function tick(page: Page, name: string): Promise<void> {
  await (await onlyOne(page.getByRole("checkbox", { name: new RegExp(`^Select ${name}`) }).filter({ visible: true }), `tick ${name}`)).check();
}

test.describe("R-2820 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Overdue — rows that need a call or a part bill grey the button out with the reason", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openTab(page, "overdue", LATE);
    const btn = await onlyOne(page.getByTestId("renewals-remind"), "Remind button");
    /* the tab-level label: a count it can send "in Overdue", or greyed "Remind 0 · N …" */
    await expect(btn).toHaveText(/^Remind (\d+ in Overdue|0 · \d+ .+)$/, { timeout: 60_000 });
    if (/^Remind 0/.test((await btn.textContent()) ?? "")) await expect(btn).toBeDisabled();
    await tick(page, LATE);
    await tick(page, SPLIT);
    await expect(btn).toHaveText("Remind 0 · 2 need a call or part bill");
    await expect(btn).toBeDisabled();
    await expect(btn).toHaveAttribute("title", /past the renewal date and the grace/);
    await expect(btn).toHaveAttribute("title", /billed in parts/);
  });

  test("Step 2: 8–30 — the count is the rows it will email, the same as the dialog's 'Email N'; skipped rows show the product", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openTab(page, "d30", DUE);
    const btn = await onlyOne(page.getByTestId("renewals-remind"), "Remind button");
    await expect(btn).toHaveText(/^Remind \d+ in 8–30$/, { timeout: 60_000 });
    const n = Number(/Remind (\d+)/.exec((await btn.textContent()) ?? "")?.[1]);
    await btn.click();
    const dlg = await onlyOne(page.getByTestId("renewal-reminder-dialog"), "reminder dialog");
    const send = await onlyOne(dlg.getByRole("region", { name: "Will be emailed" }), "will-be-emailed list");
    await expect(send.locator("li")).toHaveCount(n);
    await expect(send).toContainText(`${DUE} · CT R2820 Due Plan`);
    await expect(dlg.getByRole("button", { name: new RegExp(`^Email ${n} customers?$`) })).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();   // never send
    await expect(page.getByTestId("renewal-reminder-dialog")).toHaveCount(0);
  });
});
