/**
 * Card test — R-2762 "Renewals drawer: renewal emails/reminders sent (count + dates + channel) in the
 * Follow-ups section".
 *
 * At 1276×800 the owner opens a renewal's drawer: Follow-ups → Reminders reads "3 reminders sent this term
 * (2 email, 1 WhatsApp) · last <date> · 1 try not sent", and the list shows the four tries newest
 * first — date · Email/WhatsApp · step · status · to whom. A renewal with nothing sent reads
 * "No reminder sent yet" and has no list.
 * Run: `BASE_URL=http://localhost:<your port> node scripts/ops/card-tests.mjs R-2762`.
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): one customer,
 * two yearly subscriptions renewing in 20 days; the first has 3 renewal_email_log rows (2 sent, 1
 * stubbed) and 1 whatsapp_reminder_log row (delivered).
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, openAppPage, pageAs } from "./card-steps";

const CUST = "c2762000-0000-4000-8000-000000000001";
const SUB_SENT = "c2762000-0000-4000-8000-000000000021";
const SUB_NONE = "c2762000-0000-4000-8000-000000000022";
const WA = "c2762000-0000-4000-8000-000000000031";
const NAME = "CT R2762 Reminder Traders";
const db = () => localDb("R-2762");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    delete from public.whatsapp_reminder_log where id = '${WA}' and tenant_id = ${T};
    delete from public.renewal_email_log where subscription_id in ('${SUB_SENT}', '${SUB_NONE}') and tenant_id = ${T};
    delete from public.subscriptions where id in ('${SUB_SENT}', '${SUB_NONE}') and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ct2762@example.test', '+91 98765 27620', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew, outstanding_amount, reminder_count)
      values ('${SUB_SENT}', ${T}, '${CUST}', '${NAME}', 'CT R2762 Plan A', 'google', 5, 2000, 12, 'yearly',
              public.ist_today() - 345, public.ist_today() + 20, 'active', 'notice_sent', true, 0, 2),
             ('${SUB_NONE}', ${T}, '${CUST}', '${NAME}', 'CT R2762 Plan B', 'google', 5, 2000, 12, 'yearly',
              public.ist_today() - 345, public.ist_today() + 20, 'active', 'pending', true, 0, 0);
    insert into public.renewal_email_log (tenant_id, subscription_id, cadence_step, recipient_email, subject, status, sent_at)
      values (${T}, '${SUB_SENT}', 'early_notice', 'ct2762@example.test', 'Renewal coming up', 'sent', now() - interval '10 days'),
             (${T}, '${SUB_SENT}', 'notice_sent', 'ct2762@example.test', 'Renewal notice', 'sent', now() - interval '5 days'),
             (${T}, '${SUB_SENT}', 'reminder_1', 'ct2762@example.test', 'Renewal reminder', 'stubbed', now() - interval '1 day');
    insert into public.whatsapp_reminder_log (id, tenant_id, kind, subject_type, subject_id, step, phone, status, sent_at)
      values ('${WA}', ${T}, 'renewal_upcoming', 'subscription', '${SUB_SENT}', 'early_notice', '+919876527620', 'delivered', now() - interval '7 days');
    commit;`);
}

async function openFollowups(page: Page, sub: string): Promise<ReturnType<Page["getByTestId"]>> {
  await page.setViewportSize({ width: 1276, height: 800 });
  await openAppPage(page, `/renewals?bucket=d30&sub=${sub}`);
  const drawer = page.getByTestId("renewal-drawer");
  await expect(drawer).toBeVisible({ timeout: 60_000 });
  await expect(drawer.getByRole("heading", { name: NAME })).toBeVisible({ timeout: 60_000 });
  return drawer.getByTestId("renewal-drawer-followups");
}

test.describe("R-2762 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Follow-ups → Reminders: 3 sent this term (2 email, 1 WhatsApp) · last … · 1 try not sent, listed newest first", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const fu = await openFollowups(page, SUB_SENT);
    const summary = fu.getByTestId("renewal-drawer-reminders-summary");
    await expect(summary).toHaveText(/^3 reminders sent this term \(2 email, 1 WhatsApp\) · last \d{1,2} \w{3} \d{4} · 1 try not sent$/, { timeout: 60_000 });
    const rows = fu.getByTestId("renewal-drawer-reminder");
    await expect(rows).toHaveCount(4);
    await expect(rows.nth(0)).toContainText("Email · Reminder 1 (T-12)");
    await expect(rows.nth(0)).toContainText("Not sent — email sending is not set up");
    await expect(rows.nth(1)).toContainText("Email · Notice sent (T-15)");
    await expect(rows.nth(2)).toContainText("WhatsApp · Early notice (T-30)");
    await expect(rows.nth(2)).toContainText("Delivered");
    await expect(rows.nth(2)).toContainText("to +919876527620");
    await expect(rows.nth(3)).toContainText("Email · Early notice (T-30)");
    await expect(rows.nth(3)).toContainText("to ct2762@example.test");
    const spill = await page.getByTestId("renewal-drawer").evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(spill, "drawer has no horizontal scroll").toBeLessThanOrEqual(1);
    await page.screenshot({ path: test.info().outputPath("r2762-reminders.png") });
    await page.context().close();
  });

  test("Step 2: a renewal with nothing sent → No reminder sent yet, no list", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    const fu = await openFollowups(page, SUB_NONE);
    await expect(fu.getByTestId("renewal-drawer-reminders-summary")).toHaveText("No reminder sent yet", { timeout: 60_000 });
    await expect(fu.getByTestId("renewal-drawer-reminders")).toHaveCount(0);
    await page.context().close();
  });
});
