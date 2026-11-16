/**
 * Card test — R-2757 "Bill next part dialog warns about an earlier unpaid part; 'Periods' renamed
 * to 'Months to bill'" (user audit 14 Nov 2026: Greentin Check 2095 — the Oct part proforma
 * Q-F588-27-0059 sent and unpaid, while Bill next part offered Nov with no word about it).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2757`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 * customer "CT R2757 Parts Pvt Ltd", a monthly Google Workspace subscription (10 seats × ₹325) whose
 * LAST month's part has proforma PI-CT2757-1 (₹3,835) sent and unpaid since that month's 1st, the
 * renewal date the last day of that month (Overdue tab) — the same shape as Greentin Check 2095.
 * Nothing is created: the dialog is closed with Cancel.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2757000-0000-4000-8000-000000000001";
const SUB = "c2757000-0000-4000-8000-000000000021";
const BILL = "c2757000-0000-4000-8000-000000000031";
const PI = "PI-CT2757-1";
const NAME = "CT R2757 Parts Pvt Ltd";
const db = () => localDb("R-2757");
const T = E2E_TENANT_SQL;
/* The first of this IST month — the part before it is "last month". */
const M0 = "date_trunc('month', public.ist_today())::date";

function clean(): void {
  db().psql(`begin;
    delete from public.quotes where (id = '${PI}' or subscription_billing_id = '${BILL}'
      or subscription_billing_id in (select id from public.subscription_billings where subscription_id = '${SUB}')) and tenant_id = ${T};
    delete from public.subscription_billings where subscription_id = '${SUB}' and tenant_id = ${T};
    delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2757@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', 'CT R2757 Workspace Plan', 'google', 10, 3250, 1, 'monthly',
              (${M0} - interval '2 months')::date, ${M0} - 1, 'active', 'renewed', true, 0);
    insert into public.subscription_billings (id, tenant_id, subscription_id, term_start, period_index, bill_on, period_start, period_end, taxable_amount, tax_rate, due_on)
      values ('${BILL}', ${T}, '${SUB}', (${M0} - interval '1 month')::date, 1, (${M0} - interval '1 month')::date,
              (${M0} - interval '1 month')::date, ${M0}, 3250, 18, (${M0} - interval '1 month')::date);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, subscription_billing_id, created_date, amount, subtotal, tax_rate, line_items)
      values ('${PI}', ${T}, '${CUST}', '${NAME}', 'sent', 'awaiting', '${BILL}', ${M0} - 2, 3835, 3250, 18, '[]');
    commit;`);
}

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
function istMonths(): { last: string; now: string } {
  const d = new Date(Date.now() + 330 * 60_000);
  const m = d.getUTCMonth();
  const y = d.getUTCFullYear();
  const lm = (m + 11) % 12;
  return { last: `${MON[lm]} ${m === 0 ? y - 1 : y}`, now: MON[m] };
}

async function openDialog(page: Page) {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  const row = page.locator("tr", { hasText: "CT R2757 Workspace Plan" }).filter({ visible: true });
  await expect(row).toHaveCount(1, { timeout: 60_000 });
  const direct = row.getByRole("button", { name: /^Bill next part$/ }).filter({ visible: true });
  if (await direct.count()) {
    await expect(direct.first()).toBeEnabled({ timeout: 60_000 });   // facts load first (R-2710)
    await direct.first().click();
  }
  else {
    await row.getByRole("button", { name: /More actions|⋯|More/ }).last().click();
    await page.getByRole("menuitem", { name: /Bill next part/ }).click();
  }
  const dlg = page.getByRole("dialog");
  await expect(dlg).toBeVisible({ timeout: 30_000 });
  return dlg;
}

test.describe("R-2757 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1+2: Bill next part names last month's unpaid proforma, 'Months to bill', button 'Bill <month> anyway'; Cancel creates nothing", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    const dlg = await openDialog(page);
    const note = dlg.getByTestId("bill-next-unpaid-earlier");
    const { last, now } = istMonths();
    await expect(note).toContainText("An earlier part is still unpaid", { timeout: 60_000 });
    await expect(note).toContainText(`${last} · ${PI} · ₹3,835 unpaid · overdue`);
    await expect(note.getByRole("link", { name: "Record payment" })).toHaveAttribute("href", `/quotes/${PI}?pay=1`);
    await expect(dlg.getByLabel(/Months to bill/)).toBeVisible();
    await expect(dlg.getByRole("button", { name: `Bill ${now} anyway` })).toBeEnabled();
    await dlg.getByRole("button", { name: "Cancel" }).click();
    await expect(dlg).toBeHidden();
    expect(db().one(`select count(*) from public.quotes q join public.subscription_billings b on b.id = q.subscription_billing_id where b.subscription_id = '${SUB}'`)).toBe("1");
  });
});
