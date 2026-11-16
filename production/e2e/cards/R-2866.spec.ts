/**
 * Card test — R-2866 "Renewals row: clicking the quote number opens a quote pop-up (not the full page)" + the same
 * day's ask: hovering the number lists every product line of the quote with its subscription period.
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login, at a 1280 laptop.
 * Run: `node scripts/ops/card-tests.mjs R-2866` (R2866_KEEP=1 leaves the rows in place to look at by hand).
 *
 * Data (fresh every run, E2E Test Co + local docker DB only, fixed ids, removed after): the customer
 * "CT R2866 Ravi Shankar" with one Google subscription whose renewal date was 5 days ago (Overdue tab) and its
 * renewal quote Q-T866-27-0124, sent on 30 Oct, two product lines, ₹3,823 incl. GST. Nothing is sent to anyone.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2866000-0000-4000-8000-000000000001";
const NAME = "CT R2866 Ravi Shankar";
const SUB = "c2866000-0000-4000-8000-000000000021";
const PLAN = "CT R2866 Workspace Starter";
const ADDON = "CT R2866 Vault Add-on";
const QUOTE = "Q-T866-27-0124";
const db = () => localDb("R-2866");
const T = E2E_TENANT_SQL;

function clean(): void {
  db().psql(`begin;
    update public.subscriptions set renewal_quote_id = null where id = '${SUB}' and tenant_id = ${T};
    delete from public.quotes where id = '${QUOTE}' and tenant_id = ${T};
    delete from public.subscriptions where id = '${SUB}' and tenant_id = ${T};
    delete from public.customers where id = '${CUST}' and tenant_id = ${T};
    commit;`);
}

function seed(): void {
  db().psql(`begin;
    insert into public.customers (id, tenant_id, name, contact_email, contact_phone, state_code, country)
      values ('${CUST}', ${T}, '${NAME}', 'ravi@ct2866.test', '+91 98765 28661', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, status, renewal_state, auto_renew)
      values ('${SUB}', ${T}, '${CUST}', '${NAME}', '${PLAN}', 'google', 473, 270, 12, 'yearly',
              public.ist_today() - 370, public.ist_today() - 5, 'active', 'notice_sent', true);
    insert into public.quotes (id, tenant_id, customer_id, customer_name, status, payment_status, is_renewal, renewal_subscription_id,
                               renewal_term_date, extension_months, created_date, expires_date, amount, subtotal, tax_rate, line_items)
      values ('${QUOTE}', ${T}, '${CUST}', '${NAME}', 'sent', 'none', true, '${SUB}',
              public.ist_today() - 5, 12, '2026-10-30', public.ist_today() + 14, 3823, 3240, 18,
              jsonb_build_array(
                jsonb_build_object('name', '${PLAN}', 'qty', 473, 'rate', 5, 'commitment', 'annual_yearly'),
                jsonb_build_object('name', '${ADDON}', 'qty', 2, 'rate', 437.5, 'commitment', 'annual_yearly')));
    update public.subscriptions set renewal_quote_id = '${QUOTE}' where id = '${SUB}';
    commit;`);
}

const row = (page: Page) => page.locator("tr", { hasText: PLAN }).filter({ visible: true });
/** "1 Oct–31 Oct 2026" / "12 Nov 2026–11 Nov 2027" — a day range (the dates depend on today). */
const RANGE = String.raw`\d{1,2} [A-Z][a-z]{2}( \d{4})?–\d{1,2} [A-Z][a-z]{2} \d{4}`;

async function openOverdue(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  /* a busy laptop's local Supabase sometimes drops a read ("couldn't load") — reload (up to 3 tries) rather than judge a failed read */
  for (let attempt = 1; ; attempt++) {
    await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
    const table = page.getByTestId("renewals-table");
    await expect(table).toBeVisible({ timeout: 90_000 });
    await expect(row(page)).toHaveCount(1, { timeout: 90_000 });
    await expect(table.getByTestId("renewal-row-quote").filter({ hasText: /^…$/ })).toHaveCount(0, { timeout: 90_000 });
    if (!(await table.getByText(/couldn.t load/).count())) return;
    if (attempt >= 3) throw new Error(`a row read failed ${attempt}x on this server (local Supabase load)`);
  }
}

/** The row's quote number — a link once the viewer's permissions are read (wait for what you click, R-2666). */
async function quoteNumber(page: Page) {
  const line = await onlyOne(row(page).getByTestId("renewal-row-quote"), "the row's quote line");
  const link = line.getByRole("link", { name: QUOTE });
  await expect(link).toBeVisible({ timeout: 90_000 });
  return link;
}

test.describe("R-2866 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial", timeout: 480_000 });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON && process.env.R2866_KEEP !== "1") clean(); });

  test("Step 1: Renewals → Overdue: clicking the row's quote number (Q-…) opens a pop-up", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    await (await quoteNumber(page)).click();
    const dlg = page.getByRole("dialog", { name: `Quote ${QUOTE}` });
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    await expect(dlg).toContainText(NAME);
    await page.context().close();
  });

  test("Step 2: only hovering the number (no click) shows a small box with every product of the quote and its period; keyboard focus shows the same", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    const link = await quoteNumber(page);
    await link.hover();
    const tip = page.getByRole("tooltip");
    await expect(tip).toBeVisible({ timeout: 30_000 });
    /* the lines come from ONE read for the rows on screen — wait for it, then both products with a period */
    await expect(tip).toContainText(new RegExp(`${PLAN} · 473 seats · ${RANGE}`), { timeout: 60_000 });
    await expect(tip).toContainText(new RegExp(`${ADDON} · 2 seats · ${RANGE}`));
    await expect(tip).toContainText(`Quote ${QUOTE} · Sent`);
    await expect(page.getByRole("dialog")).toHaveCount(0);                    // hovering opened nothing
    await expect(page).toHaveURL(/\/renewals/);
    /* the box stays inside a 1280 window */
    const box = await page.getByTestId("renewal-row-quote-hover").first().boundingBox();
    expect(box && box.x >= 0 && box.x + box.width <= 1280, "hover box inside the window").toBe(true);
    /* keyboard: move away, then focus the number */
    await page.mouse.move(5, 5);
    await expect(tip).toHaveCount(0, { timeout: 15_000 });
    await link.focus();
    await expect(page.getByRole("tooltip")).toContainText(`${PLAN} · 473 seats`, { timeout: 30_000 });
    await page.context().close();
  });

  test("Step 3: the page does not change — the pop-up shows the quote's lines, total incl. GST, status and valid-till / pay-by date", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    const before = page.url();
    const link = await quoteNumber(page);
    await link.focus();
    await page.keyboard.press("Enter");                                        // keyboard reachable
    const dlg = page.getByRole("dialog", { name: `Quote ${QUOTE}` });
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    expect(page.url(), "still on Renewals").toBe(before);
    await expect(dlg.getByTestId("quote-peek-type")).toHaveText("Renewal", { timeout: 60_000 });
    await expect(dlg.getByTestId("quote-peek-status")).toHaveText(/^Sent · Valid till \d{1,2} [A-Z][a-z]{2} \d{4}$/);
    await expect(dlg.getByTestId("quote-peek-period")).toHaveText(new RegExp(`^${RANGE}$`), { timeout: 60_000 });
    await expect(dlg.getByTestId("quote-peek-line")).toHaveCount(2);
    await expect(dlg.getByTestId("quote-peek-lines")).toContainText(PLAN);
    await expect(dlg.getByTestId("quote-peek-lines")).toContainText("473 seats");
    await expect(dlg.getByTestId("quote-peek-lines")).toContainText(ADDON);
    await expect(dlg.getByTestId("quote-peek-gst")).toHaveText("₹583");
    await expect(dlg.getByTestId("quote-peek-total")).toHaveText("₹3,823");
    await expect(dlg.getByTestId("quote-peek-received")).toHaveText("Received ₹0 of ₹3,823 · ₹3,823 still due", { timeout: 60_000 });
    /* the next steps are there; the pop-up fits a 1280×800 window */
    await expect(dlg.getByRole("button", { name: "Record payment" })).toBeVisible();
    await expect(dlg.getByRole("button", { name: "Copy customer link" })).toBeVisible();
    await expect(dlg.getByRole("link", { name: "Send on WhatsApp" })).toHaveAttribute("href", `/quotes/${QUOTE}?send=whatsapp`);
    const box = await dlg.boundingBox();
    expect(box && box.x >= 0 && box.y >= 0 && box.x + box.width <= 1280 && box.y + box.height <= 800, "pop-up inside a 1280×800 window").toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), "no sideways scroll").toBe(true);
    /* Record payment = the SAME record-payment dialog, in place (closed again without saving anything) */
    await dlg.getByRole("button", { name: "Record payment" }).click();
    const pay = page.getByRole("dialog").filter({ hasText: /Record payment/i });
    await expect(pay).toBeVisible({ timeout: 120_000 });
    await expect(pay).toContainText(NAME);
    expect(page.url(), "still on Renewals").toBe(before);
    await page.keyboard.press("Escape");
    await page.context().close();
  });

  test("Step 4: Esc closes the pop-up and the list is where it was; 'Open full quote' opens the quote page", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await openOverdue(page);
    const link = await quoteNumber(page);
    await link.scrollIntoViewIfNeeded();
    await link.click();
    const dlg = page.getByRole("dialog", { name: `Quote ${QUOTE}` });
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    const scrolled = await page.evaluate(() => window.scrollY);
    await page.keyboard.press("Escape");
    await expect(dlg).toHaveCount(0);
    await expect(page).toHaveURL(/\/renewals\?bucket=overdue/);
    expect(await page.evaluate(() => window.scrollY), "the list did not jump").toBe(scrolled);
    await expect(link).toBeFocused();                                          // focus is back on the number
    await link.click();
    await expect(dlg).toBeVisible({ timeout: 60_000 });
    await dlg.getByRole("link", { name: "Open full quote" }).click();
    await expect(page).toHaveURL(new RegExp(`/quotes/${QUOTE}$`), { timeout: 240_000 });   // a cold dev server compiles the quote page first
    await page.context().close();
  });
});
