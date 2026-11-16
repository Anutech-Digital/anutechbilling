/**
 * Card test — R-2856 "Renewals: 'Remind 1 in Overdue' with 8 overdue — skipped list is one long paragraph;
 * row menu has Follow up / Nudge / Voice note (look-alike words)" (coordinator's human test on staging, 16 Nov).
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co, grace 0 days) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2856`. NOTHING IS SENT: the dialog's "Email N" is never pressed,
 * and the ⋯ items that message a customer (WhatsApp draft / voice note) are only read, never clicked.
 *
 * Data (fresh on every run, E2E Test Co + the local docker DB only, fixed ids, removed after):
 *   · "CT R2856 Grace Pvt Ltd"   — yearly, renewal date 2 days ago, +7 days grace, email on file → can be reminded;
 *   · "CT R2856 Ravi Pvt Ltd"    — billed quarterly, renewal date 46 days ago → skipped (billed in parts);
 *   · "CT R2856 Supreme Pvt Ltd" — billed quarterly, renewal date 44 days ago → skipped (billed in parts).
 * Other Overdue rows in the shared local DB vary, so the counts are read as "N of M", never fixed numbers.
 */
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const C_GRACE = "c2856000-0000-4000-8000-000000000001";
const C_RAVI = "c2856000-0000-4000-8000-000000000002";
const C_SUPREME = "c2856000-0000-4000-8000-000000000003";
const S_GRACE = "c2856000-0000-4000-8000-000000000021";
const S_RAVI = "c2856000-0000-4000-8000-000000000022";
const S_SUPREME = "c2856000-0000-4000-8000-000000000023";
const CUSTS = [C_GRACE, C_RAVI, C_SUPREME];
const SUBS = [S_GRACE, S_RAVI, S_SUPREME];
const GRACE = "CT R2856 Grace Pvt Ltd";
const RAVI = "CT R2856 Ravi Pvt Ltd";
const SUPREME = "CT R2856 Supreme Pvt Ltd";
const db = () => localDb("R-2856");
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
      ('${C_GRACE}',   ${T}, '${GRACE}',   'ct2856-grace@example.test', '07', 'India'),
      ('${C_RAVI}',    ${T}, '${RAVI}',    'ct2856-ravi@example.test', '07', 'India'),
      ('${C_SUPREME}', ${T}, '${SUPREME}', 'ct2856-supreme@example.test', '07', 'India');
    insert into public.subscriptions (id, tenant_id, customer_id, customer_name, plan, vendor, seats, mrr, term_months, billing_cycle,
                                      start_date, renewal_date, grace_until, status, renewal_state, auto_renew, outstanding_amount) values
      ('${S_GRACE}',   ${T}, '${C_GRACE}',   '${GRACE}',   'CT R2856 Grace Plan',   'google', 5, 500, 12, 'yearly',    public.ist_today() - 367, public.ist_today() - 2,  public.ist_today() + 5, 'active', 'notice_sent', true, 0),
      ('${S_RAVI}',    ${T}, '${C_RAVI}',    '${RAVI}',    'CT R2856 Ravi Plan',    'google', 5, 500, 12, 'quarterly', public.ist_today() - 411, public.ist_today() - 46, null,                   'active', 'notice_sent', true, 0),
      ('${S_SUPREME}', ${T}, '${C_SUPREME}', '${SUPREME}', 'CT R2856 Supreme Plan', 'google', 5, 500, 12, 'quarterly', public.ist_today() - 409, public.ist_today() - 44, null,                   'active', 'notice_sent', true, 0);
    commit;`);
}

async function openOverdue(page: Page): Promise<void> {
  await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
  for (const name of [GRACE, RAVI, SUPREME]) {
    await expect(page.locator("tr", { hasText: name }).filter({ visible: true })).toHaveCount(1, { timeout: 90_000 });
  }
}

test.describe("R-2856 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (!CARD_TESTS_ON) return; clean(); seed(); });
  test.afterAll(() => { if (CARD_TESTS_ON) clean(); });

  test("Step 1: Overdue tab — the reminder button says N of M ('Remind 1 of 8 in Overdue'), its tooltip why the rest are not included", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openOverdue(page);
    const btn = await onlyOne(page.getByTestId("renewals-remind"), "Remind button");
    await expect(btn).toHaveText(/^Remind \d+ of \d+ in Overdue$/, { timeout: 60_000 });
    const [, n, m] = /^Remind (\d+) of (\d+) /.exec((await btn.textContent()) ?? "") ?? [];
    expect(Number(n)).toBeGreaterThanOrEqual(1);              // the in-grace row
    expect(Number(m) - Number(n)).toBeGreaterThanOrEqual(2);  // the two part-billed rows
    await expect(btn).toBeEnabled();
    await expect(btn).toHaveAttribute("title", new RegExp(`^${Number(m) - Number(n)} not included — .*billed in parts`));
    /* the button fits the header at 1280 — no sideways scroll */
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test("Step 2: the dialog lists who is left out one per line, each with its reason, how late it is and its next step (never sends)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openOverdue(page);
    const btn = await onlyOne(page.getByTestId("renewals-remind"), "Remind button");
    await expect(btn).toHaveText(/^Remind \d+ of \d+ in Overdue$/, { timeout: 60_000 });
    await btn.click();
    const dlg = await onlyOne(page.getByTestId("renewal-reminder-dialog"), "reminder dialog");
    await expect(dlg.getByRole("region", { name: "Will be emailed" })).toContainText(`${GRACE} · CT R2856 Grace Plan`);
    const skipped = await onlyOne(dlg.getByRole("region", { name: "Skipped" }), "Skipped list");
    const parts = await onlyOne(skipped.getByTestId("reminder-skip-group").filter({ hasText: "billed in parts" }), "billed-in-parts group");
    await expect(parts).toContainText("Next: Bill next part, or Follow up if a part is late");
    const ravi = await onlyOne(parts.getByTestId("reminder-skip-row").filter({ hasText: RAVI }), "Ravi's line");
    const supreme = await onlyOne(parts.getByTestId("reminder-skip-row").filter({ hasText: SUPREME }), "Supreme's line");
    await expect(ravi).toHaveText(new RegExp(`^${RAVI} · CT R2856 Ravi Plan\\s*Overdue 46d\\s*Open renewal$`));
    await expect(supreme).toContainText("Overdue 44d");
    /* one customer per line — Ravi's line does not carry Supreme */
    await expect(ravi).not.toContainText(SUPREME);
    /* the next step: Open renewal closes the dialog and opens THAT renewal, where Bill next part / Follow up are */
    await ravi.getByRole("button", { name: `Open renewal — ${RAVI} · CT R2856 Ravi Plan` }).click();
    await expect(page.getByTestId("renewal-reminder-dialog")).toHaveCount(0);
    const drawer = await onlyOne(page.getByTestId("renewal-drawer"), "renewal drawer");
    await expect(drawer).toContainText(RAVI, { timeout: 30_000 });
    await expect(drawer.getByTestId("stage-primary")).toHaveText(/Bill next part|Follow up/, { timeout: 60_000 });
  });

  test("Step 3: a row's ⋯ — every item says what it does (log a call, draft a WhatsApp message, send a voice note)", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    await page.setViewportSize({ width: 1280, height: 900 });
    await openOverdue(page);
    const r = page.locator("tr", { hasText: GRACE }).filter({ visible: true });
    const more = r.getByRole("button", { name: /More renewal actions/ });
    await expect(more).toBeVisible({ timeout: 60_000 });
    await more.click();
    await expect(page.getByRole("menuitem", { name: "Draft a WhatsApp message (AI)" })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByRole("menuitem", { name: "Send a WhatsApp voice note" })).toBeVisible();
    /* the follow-up dialog: a ⋯ item, unless it is already the row's own button */
    const primary = (await r.getByTestId("stage-primary").textContent())?.trim();
    if (primary !== "Follow up") await expect(page.getByRole("menuitem", { name: "Follow up — log a call or promise" })).toBeVisible();
    /* the look-alike one-word labels are gone, and no two items read the same */
    const items = (await page.getByRole("menuitem").allTextContents()).map((t) => t.trim());
    expect(items.filter((t) => /^(Nudge|Voice note|Follow up)$/.test(t))).toEqual([]);
    expect(new Set(items).size).toBe(items.length);
    await page.keyboard.press("Escape");   // nothing is sent
  });
});
