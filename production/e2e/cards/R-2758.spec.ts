/**
 * Card test — R-2758 (R-2739a) "Renewals row shows ONE stage chip + ONE primary button from
 * renewalStage / renewalPrimary (R-2738 model wired into the page + RenewalActions)".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2758`.
 *
 * Data (fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after),
 * customer "CT R2758 Renewals Pvt Ltd", every plan renewing 10 days from today (≤30 tab "8–30"):
 *   · A "CT R2758 Due Plan"      — nothing sent                 → "Due in 10d" + [Send renewal]
 *   · B "CT R2758 Sent Plan"     — renewal quote sent, unpaid   → "Renewal quote sent…" + [Follow up]
 *   · C "CT R2758 Invoiced Plan" — renewal quote's invoice, ₹1,180 unpaid → "Invoiced · ₹1,180 due" + [Record payment]
 *   · D "CT R2758 Ending Plan"   — Won't renew                   → "Won't renew · ends …", no button, ⋯ "Undo Won't renew"
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localCleanupDeleteIssuedInvoice, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2758000-0000-4000-8000-000000000001";
const SUB_A = "c2758000-0000-4000-8000-000000000021";
const SUB_B = "c2758000-0000-4000-8000-000000000022";
const SUB_C = "c2758000-0000-4000-8000-000000000023";
const SUB_D = "c2758000-0000-4000-8000-000000000024";
const SUBS = [SUB_A, SUB_B, SUB_C, SUB_D];
const NAME = "CT R2758 Renewals Pvt Ltd";
const QUOTES = ["Q-CT2758-B", "Q-CT2758-C"];
const INVOICES = ["INV-CT2758-C"];
const db = () => localDb("R-2758");
const T = E2E_TENANT_SQL;
const inList = (ids: readonly string[]) => ids.map((x) => `'${x}'`).join(", ");

function clean(): void {
  localCleanupDeleteIssuedInvoice(db(), "R-2758", {
    invoiceIds: INVOICES,
    before: `update public.quotes set invoice_id = null where id in (${inList(QUOTES)}) and tenant_id = ${T};
             update public.subscriptions set renewal_quote_id = null, quote_id = null where id in (${inList(SUBS)}) and tenant_id = ${T};`,
    after: `delete from public.quotes where id in (${inList(QUOTES)}) and tenant_id = ${T};
            delete from public.subscriptions where id in (${inList(SUBS)}) and tenant_id = ${T};
            delete from public.customers where id = '${CUST}' and tenant_id = ${T};`,
  });
}

function seed(): void {
  const line = `jsonb_build_array(jsonb_build_object('name', 'CT R2758 line', 'qty', 1, 'rate', 1000, 'commitment', 'annual_yearly'))`;
  const sub = (id: string, plan: string, autoRenew = true) => `('${id}', ${T}, '${CUST}', '${NAME}', '${plan}', 'google', 1, 100, 12, 'yearly',
              public.ist_today() - 355, public.ist_today() + 10, 'active', 'notice_sent', ${autoRenew})`;
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2758@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ${sub(SUB_A, "CT R2758 Due Plan")}, ${sub(SUB_B, "CT R2758 Sent Plan")},
             ${sub(SUB_C, "CT R2758 Invoiced Plan")}, ${sub(SUB_D, "CT R2758 Ending Plan", false)};
    -- B: renewal quote with the customer, unpaid
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2758-B', ${T}, '${CUST}', '${NAME}', 'sent', 'none', true, '${SUB_B}',
              public.ist_today() + 10, 12, public.ist_today() - 1, public.ist_today() + 14, 1180, 1000, 18, ${line});
    update public.subscriptions set renewal_quote_id = 'Q-CT2758-B' where id = '${SUB_B}';
    -- C: renewal quote accepted + invoiced, nothing paid
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('Q-CT2758-C', ${T}, '${CUST}', '${NAME}', 'accepted', 'invoiced', true, '${SUB_C}',
              public.ist_today() + 10, 12, public.ist_today() - 3, public.ist_today() + 14, 1180, 1000, 18, ${line});
    insert into public.invoices (id, tenant_id, customer_id, customer_name, quote_id, status, amount, tax_amount, paid_amount, invoice_date, due_date)
      values ('INV-CT2758-C', ${T}, '${CUST}', '${NAME}', 'Q-CT2758-C', 'pending', 1180, 180, 0, public.ist_today() - 2, public.ist_today() + 10);
    update public.quotes set invoice_id = 'INV-CT2758-C' where id = 'Q-CT2758-C';
    update public.subscriptions set renewal_quote_id = 'Q-CT2758-C' where id = '${SUB_C}';
    commit;`);
}

async function rowOf(page: Page, plan: string): Promise<Locator> {
  await page.setViewportSize({ width: 1568, height: 900 });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  const r = page.locator("tr", { hasText: plan }).filter({ visible: true });
  await expect(r).toHaveCount(1, { timeout: 60_000 });
  /* ONE chip, at most ONE button (the ⋯ is not a button with a label) */
  await expect(r.getByTestId("stage-chip")).toHaveCount(1, { timeout: 60_000 });
  return r;
}

test.describe("R-2758 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: nothing sent → one chip 'Due in 10d' and one button 'Send renewal'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2758 Due Plan");
    await expect(r.getByTestId("stage-chip")).toContainText("Due in 10d");
    await expect(r.getByTestId("stage-primary")).toHaveText(/Send renewal/);
  });

  test("Step 2: sent renewal quote → 'Renewal quote sent' + Follow up; no second 'Quote sent' chip", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2758 Sent Plan");
    await expect(r.getByTestId("stage-chip")).toContainText("Renewal quote sent");
    await expect(r.getByTestId("stage-primary")).toHaveText(/Follow up/);
    await expect(r.getByText("Quote sent", { exact: true })).toHaveCount(0);
  });

  test("Step 3: invoiced, unpaid → 'Invoiced · ₹1,180 due' + Record payment (opens the quote's own dialog)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2758 Invoiced Plan");
    await expect(r.getByTestId("stage-chip")).toContainText("Invoiced · ₹1,180 due");
    await r.getByTestId("stage-primary").click();
    await expect(page).toHaveURL(/\/quotes\/Q-CT2758-C\?pay=1/, { timeout: 60_000 });
  });

  test("Step 4: Won't renew → no button; ⋯ has 'Undo Won't renew'", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const r = await rowOf(page, "CT R2758 Ending Plan");
    await expect(r.getByTestId("stage-chip")).toContainText("Won't renew · ends");
    await expect(r.getByTestId("stage-primary")).toHaveCount(0);
    await r.getByRole("button", { name: /More renewal actions/ }).click();
    await expect(page.getByRole("menuitem", { name: /Undo Won't renew/ })).toBeVisible();
  });
});
