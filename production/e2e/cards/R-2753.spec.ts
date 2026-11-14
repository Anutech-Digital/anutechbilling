/**
 * Card test — R-2753 "Renewals Bulk reminder: follows the open tab / ticked rows, the dialog names who
 * is skipped and why, one reminder button, no floating email button on phone" (14 Nov owner-style audit).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co, grace 0 days) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2753`. NOTHING IS EMAILED: every step stops at the dialog and
 * presses Cancel / Close — the "Email N" button is never pressed.
 *
 * Data (fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   · "CT R2753 Kochi Pvt Ltd"  — NO email on file, renews in 12 days (8–30 tab);
 *   · "CT R2753 Delhi Pvt Ltd"  — email on file, renews in 20 days (8–30 tab);
 *   · "CT R2753 Late Pvt Ltd"   — email on file, renewal date 5 days ago (Overdue tab; grace 0 → past grace).
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const C_KOCHI = "c2753000-0000-4000-8000-000000000001";
const C_DELHI = "c2753000-0000-4000-8000-000000000002";
const C_LATE = "c2753000-0000-4000-8000-000000000003";
const S_KOCHI = "c2753000-0000-4000-8000-000000000021";
const S_DELHI = "c2753000-0000-4000-8000-000000000022";
const S_LATE = "c2753000-0000-4000-8000-000000000023";
const CUSTS = [C_KOCHI, C_DELHI, C_LATE];
const SUBS = [S_KOCHI, S_DELHI, S_LATE];
const KOCHI = "CT R2753 Kochi Pvt Ltd";
const DELHI = "CT R2753 Delhi Pvt Ltd";
const LATE = "CT R2753 Late Pvt Ltd";
const db = () => localDb("R-2753");
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
      ('${C_KOCHI}', ${T}, '${KOCHI}', null, '32', 'India'),
      ('${C_DELHI}', ${T}, '${DELHI}', 'ct2753-delhi@example.test', '07', 'India'),
      ('${C_LATE}',  ${T}, '${LATE}',  'ct2753-late@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount) values
      ('${S_KOCHI}', ${T}, '${C_KOCHI}', '${KOCHI}', 'CT R2753 Kochi Plan', 'google', 5, 500, 12, 'yearly', public.ist_today() - 353, public.ist_today() + 12, 'active', 'pending', true, 0),
      ('${S_DELHI}', ${T}, '${C_DELHI}', '${DELHI}', 'CT R2753 Delhi Plan', 'google', 5, 500, 12, 'yearly', public.ist_today() - 345, public.ist_today() + 20, 'active', 'pending', true, 0),
      ('${S_LATE}',  ${T}, '${C_LATE}',  '${LATE}',  'CT R2753 Late Plan',  'google', 5, 500, 12, 'yearly', public.ist_today() - 370, public.ist_today() - 5,  'active', 'notice_sent', true, 0);
    commit;`);
}

async function openTab(page: Page, bucket: string, mustShow: string): Promise<void> {
  await openAppPage(page, `/renewals?bucket=${bucket}`, /Renewals/);
  await expect(page.locator("tr", { hasText: mustShow }).filter({ visible: true })).toHaveCount(1, { timeout: 60_000 });
}

async function openReminder(page: Page, label: RegExp): Promise<Locator> {
  const btn = await onlyOne(page.getByTestId("renewals-remind"), "Remind button");
  await expect(btn).toHaveText(label, { timeout: 60_000 });
  await btn.click();
  const dlg = await onlyOne(page.getByTestId("renewal-reminder-dialog"), "reminder dialog");
  await expect(dlg).toBeVisible();
  return dlg;
}

test.describe("R-2753 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: on the Overdue tab the one Remind button lists only Overdue rows — the 8–30 customers are not in it; past-grace rows say why", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openTab(page, "overdue", LATE);
    const dlg = await openReminder(page, /^Remind \d+ in Overdue$/);
    await expect(dlg.getByText(KOCHI)).toHaveCount(0);
    await expect(dlg.getByText(DELHI)).toHaveCount(0);
    const skipped = await onlyOne(dlg.getByRole("region", { name: "Skipped" }), "Skipped list");
    const pastGrace = await onlyOne(skipped.locator("li", { hasText: "past the renewal date and the grace" }), "past-grace group");
    await expect(pastGrace).toContainText(LATE);
    await expect(pastGrace).toContainText("Send renewal quote");
    /* never send — Close / Cancel */
    await dlg.getByRole("button", { name: /^(Cancel|Close)$/ }).first().click();
    await expect(page.getByTestId("renewal-reminder-dialog")).toHaveCount(0);
    /* one reminder button: the ticked-rows bar has none */
    await (await onlyOne(page.getByRole("checkbox", { name: new RegExp(`^Select ${LATE}`) }).filter({ visible: true }), "row tick")).check();
    await expect(page.getByTestId("renewals-remind")).toHaveText("Remind 1 selected");
    await expect(page.getByRole("button", { name: "Send reminder" })).toHaveCount(0);
  });

  test("Step 2: on the 8–30 tab a customer with no email is 'skipped — no email on file', never counted in 'Email N'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openTab(page, "d30", KOCHI);
    const dlg = await openReminder(page, /^Remind \d+ in 8–30$/);
    const send = await onlyOne(dlg.getByRole("region", { name: "Will be emailed" }), "will-be-emailed list");
    await expect(send).toContainText(DELHI);
    await expect(send).not.toContainText(KOCHI);
    const noEmail = await onlyOne(dlg.getByRole("region", { name: "Skipped" }).locator("li", { hasText: "no email on file" }), "no-email group");
    await expect(noEmail).toContainText(KOCHI);
    /* the Email N count = the will-be-emailed list, Kochi not in it */
    const n = await send.locator("li").count();
    await expect(dlg.getByRole("button", { name: new RegExp(`^Email ${n} customers?$`) })).toBeVisible();
    await dlg.getByRole("button", { name: "Cancel" }).click();   // never send
    await expect(page.getByTestId("renewal-reminder-dialog")).toHaveCount(0);
  });

  test("Step 3: at phone size (375) there is no floating Bulk reminder / email button", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 375, height: 812 });
    await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
    await expect(page.getByText(KOCHI).filter({ visible: true }).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText("Bulk reminder")).toHaveCount(0);
    const floatingMail = await page.evaluate(() =>
      [...document.querySelectorAll("button")].filter((b) => {
        const s = getComputedStyle(b);
        return (s.position === "fixed" || b.closest("[class*='fixed']")) && b.offsetParent !== null && /remind|email/i.test(b.textContent ?? "");
      }).length);
    expect(floatingMail).toBe(0);
  });
});
