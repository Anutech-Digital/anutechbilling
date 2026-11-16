/**
 * Card test — R-2871 (found by the R-2850 card test): a TOGETHER renewal quote (Bill together, 2 yearly subscriptions)
 * names every subscription it renews. The quote page says "For subscriptions:" with one line per member, and the
 * Record payment sheet's "What this does" says "Renews 2 subscriptions: <A>, <B>" — not "Renews the existing
 * subscription". A single-subscription renewal quote keeps the old "For subscription: <plan>" line and wording.
 * Run: `node scripts/ops/card-tests.mjs R-2871`.
 *
 * Data: scenario "yearly-together" (as R-2850: SCN Yearly Pair Pvt Ltd, A "SCN Yearly Standard" 20 seats renewing in
 * 10 days, B "SCN Yearly Starter" 10 seats renewing in 20 days), reloaded first and cleared after. Every quote is made
 * through the app (Bill together; Cancel quote; row → Review renewal quote). Nothing is paid — the Record payment sheet is
 * opened and closed. SQL only reads.
 */
import { execFileSync } from "node:child_process";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs } from "./card-steps";

const CUST = "c2850000-0000-4000-8000-000000000001";
const SUB_A = "c2850000-0000-4000-8000-000000000021";
const SUB_B = "c2850000-0000-4000-8000-000000000022";
const NAME = "SCN Yearly Pair Pvt Ltd";
const PLAN_A = "SCN Yearly Standard";
const PLAN_B = "SCN Yearly Starter";
const db = () => localDb("R-2871");
const T = E2E_TENANT_SQL;

function scenario(flag: "--reset" | "--clear"): void {
  execFileSync(process.execPath, ["scripts/dev/scenario.mjs", "yearly-together", flag], { stdio: "pipe", timeout: 180_000 });
}

/** The live renewal quote BOTH subscriptions are linked to ("" when none). */
function togetherId(): string {
  return db().one(`select q.id from public.quotes q
                    where q.tenant_id = ${T}
                      and q.id = (select s.renewal_quote_id from public.subscriptions s where s.id = '${SUB_A}')
                      and q.id = (select s.renewal_quote_id from public.subscriptions s where s.id = '${SUB_B}')`);
}
/** The live renewal quote of one subscription ("" when none). */
function ownQuoteId(sub: string): string {
  return db().one(`select coalesce(s.renewal_quote_id, '') from public.subscriptions s where s.id = '${sub}' and s.tenant_id = ${T}`);
}

const rowOf = (page: Page, plan: string): Locator =>
  page.getByTestId("renewal-row").filter({ hasText: NAME }).filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: plan }) });
const groupOf = (page: Page): Locator => page.getByTestId("bill-together-group").filter({ hasText: NAME });

async function openD30(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openAppPage(page, "/renewals?bucket=d30", /Renewals/);
  await expect(rowOf(page, PLAN_A)).toHaveCount(1, { timeout: 120_000 });
  await expect(rowOf(page, PLAN_B)).toHaveCount(1, { timeout: 60_000 });
}

/** Open the quote's Record payment sheet (?pay=1), return its text (it holds "What this does"), close it unsaved. */
async function sheetText(page: Page, quoteId: string): Promise<string> {
  await openAppPage(page, `/quotes/${encodeURIComponent(quoteId)}?pay=1`);
  const sheet = page.getByRole("dialog", { name: "Record payment received" });
  await expect(sheet).toBeVisible({ timeout: 90_000 });
  await expect(sheet.getByText("What this does")).toBeVisible({ timeout: 60_000 });
  const text = await sheet.innerText();
  await page.keyboard.press("Escape");
  await expect(sheet).toBeHidden({ timeout: 30_000 });
  return text;
}

test.describe("R-2871 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => { if (CARD_TESTS_ON) scenario("--reset"); });
  test.afterAll(() => { if (CARD_TESTS_ON) scenario("--clear"); });

  test("Step 1: Bill together → the quote page says 'For subscriptions:' with one line per member (plan · seats · its own renewal date)", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openD30(page);
      const btn = (await onlyOne(groupOf(page), "the customer's Bill together box", 120_000)).getByRole("button", { name: /Bill together/ });
      await expect(btn).toBeVisible({ timeout: 60_000 });
      await btn.click();
      const dlg = page.getByRole("dialog");
      await expect(dlg.getByRole("heading", { name: "Bill together — one renewal quote" })).toBeVisible({ timeout: 150_000 });
      await expect(dlg.getByTestId("bill-together-line")).toHaveCount(2, { timeout: 150_000 });
      const create = dlg.getByRole("button", { name: "Create renewal quote" });
      await expect(create).toBeEnabled({ timeout: 60_000 });
      await create.click();
      await expect(page).toHaveURL(/\/quotes\/[^/]+$/, { timeout: 120_000 });

      expect(togetherId(), "both subscriptions are linked to ONE renewal quote").not.toBe("");
      const box = page.getByTestId("quote-for-subscription");
      await expect(box).toBeVisible({ timeout: 90_000 });
      await expect(box).toContainText("For subscriptions:");
      const members = box.getByTestId("quote-for-subscription-member");
      await expect(members).toHaveCount(2);
      const lines = await members.allInnerTexts();
      /* each member line = plan · seats · renews <its OWN date> (A in 10 days, B in 20) */
      const dueA = db().one(`select to_char(renewal_date, 'FMDD Mon YYYY') from public.subscriptions where id = '${SUB_A}'`);
      const dueB = db().one(`select to_char(renewal_date, 'FMDD Mon YYYY') from public.subscriptions where id = '${SUB_B}'`);
      const a = lines.find((l) => l.includes(PLAN_A));
      const b = lines.find((l) => l.includes(PLAN_B));
      expect(a, `a line for ${PLAN_A}: ${JSON.stringify(lines)}`).toBeTruthy();
      expect(b, `a line for ${PLAN_B}: ${JSON.stringify(lines)}`).toBeTruthy();
      expect(a).toContain("20 seats");
      expect(a).toContain(dueA);
      expect(b).toContain("10 seats");
      expect(b).toContain(dueB);
      expect(dueA).not.toBe(dueB);
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Record payment on it → 'What this does' says 'Renews 2 subscriptions: …', not 'Renews the existing subscription' (closed, nothing saved)", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const id = togetherId();
    test.skip(!id, "needs Step 1's together renewal quote");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const text = await sheetText(page, id);
      expect(text).toMatch(new RegExp(`Renews 2 subscriptions: (${PLAN_A}, ${PLAN_B}|${PLAN_B}, ${PLAN_A}) — each moves to its own next renewal date, on one tax invoice`));
      expect(text).not.toContain("Renews the existing subscription");
      expect(db().one(`select count(*) from public.payments p where p.customer_id = '${CUST}' and p.tenant_id = ${T}`)).toBe("0");
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: a single-subscription renewal quote still says 'For subscription: <plan>' and 'Renews the existing subscription'", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const together = togetherId();
    test.skip(!together, "needs Step 1's together renewal quote");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      /* Cancel the together quote (as R-2850 Step 2), then make A's OWN renewal quote from its ⋯ menu */
      await openAppPage(page, `/quotes/${encodeURIComponent(together)}`);
      const more = page.locator("main").getByRole("button", { name: "More", exact: true });
      await expect(more).toBeVisible({ timeout: 90_000 });
      await more.click();
      await page.getByRole("menuitem", { name: "Cancel quote" }).click();
      const dlg = page.getByRole("dialog", { name: `Cancel ${together}?` });
      await dlg.locator("#cancel-quote-reason").fill("R-2871 card test — one subscription at a time");
      await dlg.getByRole("button", { name: "Cancel quote" }).click();
      await expect(dlg).toBeHidden({ timeout: 90_000 });
      await expect.poll(() => ownQuoteId(SUB_A), { timeout: 60_000 }).toBe("");

      await openD30(page);
      /* the row's own next step: Review renewal quote → makes A's own renewal quote as a draft and opens its editor */
      const menu = rowOf(page, PLAN_A).locator("td").last().getByRole("button").last();
      await expect(async () => {
        if ((await page.getByRole("menuitem").count()) === 0) await menu.click();
        const items = await page.getByRole("menuitem").allInnerTexts();
        const pick = page.getByRole("menuitem", { name: /renewal quote|Send renewal|Generate/i });
        if ((await pick.count()) === 0) throw new Error(`no own-renewal-quote item in the menu: ${JSON.stringify(items)}`);
        await pick.first().click({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
      await expect(page).toHaveURL(/\/quotes\/[^/]+\/edit/, { timeout: 120_000 });
      const id = ownQuoteId(SUB_A);
      expect(id, "A has its own renewal quote").not.toBe("");
      expect(id).not.toBe(together);
      expect(ownQuoteId(SUB_B), "B is not on it").toBe("");

      await openAppPage(page, `/quotes/${encodeURIComponent(id)}`);
      const box = page.getByTestId("quote-for-subscription");
      await expect(box).toBeVisible({ timeout: 90_000 });
      await expect(box).toContainText(`For subscription: ${PLAN_A}`);
      await expect(box.getByTestId("quote-for-subscription-member")).toHaveCount(0);
      expect(await box.innerText()).not.toContain("For subscriptions:");

      /* The scenario's subscriptions have no vendor cost → the draft Needs approval: the owner approves it in
         Review & decide (the app's own step), then "Mark as sent" records it without emailing anyone. */
      await page.getByRole("button", { name: "Review & decide" }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawer).toBeVisible({ timeout: 60_000 });
      const note = drawer.getByLabel("You are the only owner — write why this price is OK");
      if ((await note.count()) > 0) await note.fill("R-2871 card test — one subscription renewal at list price");
      await drawer.getByRole("button", { name: /^Approve/ }).click();
      await expect(drawer).toBeHidden({ timeout: 90_000 });
      const markSent = page.getByRole("button", { name: "Mark as sent", exact: true });
      await expect(markSent).toBeEnabled({ timeout: 60_000 });
      await markSent.click();
      await expect(page.getByRole("button", { name: "Record payment", exact: true }).first()).toBeVisible({ timeout: 90_000 });

      const text = await sheetText(page, id);
      expect(text).toContain("Renews the existing subscription — the same subscription moves to its next renewal date.");
      expect(text).not.toMatch(/Renews \d+ subscriptions/);
    } finally {
      await page.context().close();
    }
  });
});
