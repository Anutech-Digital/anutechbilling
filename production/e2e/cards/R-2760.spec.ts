/**
 * Card test — R-2760 (R-2739c) "Renewals status filter + bulk Send renewal on the new StageKeys
 * (bulkSendDecision; skip no-email rows with the reason)".
 *
 * Run: `node scripts/ops/card-tests.mjs R-2760`. Nothing is emailed: the bulk confirm is cancelled.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after), all renewing
 * in 15 days (tab 8–30):
 *   · A "CT R2760 Due Plan"      — customer WITH an email, nothing sent        → would be sent
 *   · B "CT R2760 No Email Plan" — customer with NO email, nothing sent         → skipped: no email on file
 *   · C "CT R2760 Sent Plan"     — renewal quote sent                           → skipped: its stage (quote sent)
 */
import { expect, test } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST_A = "c2760000-0000-4000-8000-000000000001";
const CUST_B = "c2760000-0000-4000-8000-000000000002";
const SUB_A = "c2760000-0000-4000-8000-000000000021";
const SUB_B = "c2760000-0000-4000-8000-000000000022";
const SUB_C = "c2760000-0000-4000-8000-000000000023";
const db = () => localDb("R-2760");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    update public.subscriptions set renewal_quote_id = null where id = '${SUB_C}' and tenant_id = ${T};
    delete from public.quotes where id = 'Q-CT2760-C' and tenant_id = ${T};
    delete from public.subscriptions where id in ('${SUB_A}', '${SUB_B}', '${SUB_C}') and tenant_id = ${T};
    delete from public.customers where id in ('${CUST_A}', '${CUST_B}') and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  const sub = (id: string, cust: string, name: string, plan: string) => `('${id}', ${T}, '${cust}', '${name}', '${plan}', 'google', 2, 200, 12, 'yearly',
              public.ist_today() - 350, public.ist_today() + 15, 'active', 'notice_sent', true)`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST_A}', ${T}, 'CT R2760 Mail Co', 'ct2760@example.test', '07', 'India'),
             ('${CUST_B}', ${T}, 'CT R2760 No Mail Co', null, '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ${sub(SUB_A, CUST_A, "CT R2760 Mail Co", "CT R2760 Due Plan")},
             ${sub(SUB_B, CUST_B, "CT R2760 No Mail Co", "CT R2760 No Email Plan")},
             ${sub(SUB_C, CUST_A, "CT R2760 Mail Co", "CT R2760 Sent Plan")};
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2760-C', ${T}, '${CUST_A}', 'CT R2760 Mail Co', 'sent', 'none', true, '${SUB_C}',
              public.ist_today() + 15, 12, public.ist_today() - 1, public.ist_today() + 14, 2832, 2400, 18,
              jsonb_build_array(jsonb_build_object('name', 'CT R2760 line', 'qty', 2, 'rate', 1200, 'commitment', 'annual_yearly')));
    update public.subscriptions set renewal_quote_id = 'Q-CT2760-C' where id = '${SUB_C}';
    commit;`);
}

test.describe("R-2760 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: the status filter has the chip's words with counts — 'Quote sent' lists the sent row only", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
    const table = page.getByTestId("renewals-table");
    await expect(table.locator("tr", { hasText: "CT R2760 Sent Plan" })).toHaveCount(1, { timeout: 60_000 });
    const filter = page.getByRole("combobox", { name: "Filter by status" });
    await expect(filter.locator("option", { hasText: /^Quote sent \(\d+\)$/ })).toHaveCount(1, { timeout: 60_000 });
    await expect(filter.locator("option", { hasText: /^Not sent \(\d+\)$/ })).toHaveCount(1);
    await filter.selectOption("sent");
    await expect(table.locator("tr", { hasText: "CT R2760 Sent Plan" })).toHaveCount(1, { timeout: 30_000 });
    await expect(table.locator("tr", { hasText: "CT R2760 Due Plan" })).toHaveCount(0);
    await page.context().close();
  });

  test("Step 2: tick all three → Send renewal: only the due row with an email is sent; the others are named with why (cancelled — nothing emailed)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
    const table = page.getByTestId("renewals-table");
    for (const plan of ["CT R2760 Due Plan", "CT R2760 No Email Plan", "CT R2760 Sent Plan"]) {
      const row = table.locator("tr", { hasText: plan });
      await expect(row.getByTestId("stage-chip")).toHaveCount(1, { timeout: 60_000 });
      await row.getByRole("checkbox").check();
    }
    /* the bulk bar's button (each row's own one-button is "Send renewal" too) */
    await page.locator('button:not([data-testid="stage-primary"])', { hasText: /^Send renewal$/ }).click();
    const dlg = page.getByRole("alertdialog").or(page.getByRole("dialog"));
    await expect(dlg).toContainText("Send the renewal quote to 1 customer?", { timeout: 30_000 });
    await expect(dlg).toContainText("Not sent (2)");
    await expect(dlg).toContainText("CT R2760 No Mail Co — no email on file");
    await expect(dlg).toContainText("CT R2760 Mail Co — Renewal quote sent");
    await dlg.getByRole("button", { name: /^Cancel$/ }).click();
    expect(db().one(`select count(*) from public.renewal_email_log where subscription_id in ('${SUB_A}', '${SUB_B}', '${SUB_C}')`)).toBe("0");
    await page.context().close();
  });
});
