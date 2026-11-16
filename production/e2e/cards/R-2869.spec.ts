/**
 * Card test — R-2869 (R-2865 follow-up 2): the UPI "Scan to pay" block of a part / renewal proforma says "Scan to pay"
 * and that the tax invoice is raised when the payment is received — never "this advance" / "receipt voucher". An
 * ordinary quote keeps "Scan to pay this advance". The preview is what the owner sees on the quote page.
 * Run: `node scripts/ops/card-tests.mjs R-2869`.
 *
 * UPI ID: the E2E Test Co has none, and without one the UPI block is hidden. Step 1 sets one THROUGH THE APP's own
 * Settings page (Your UPI ID → Save changes), and afterAll puts the old value back the same way (the owner's real path;
 * no SQL write). The test UPI ID is a made-up address on the "okhdfcbank" handle, local DB only.
 * Data: scenario "bill-together-pair" (part proforma made with Renewals → Overdue → ⋯ → Bill next part, as R-2865) and
 * scenario "approved-quote" (ordinary quote Q-SCN-AP-1, sent, nothing paid). Both are reloaded first and cleared after.
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import { CARD_TESTS_ON, E2E_TENANT_SQL, localDb, onlyInCardTests, onlyOne, openAppPage, pageAs, fillKept } from "./card-steps";

const PART = { scenario: "bill-together-pair", name: "SCN Pair Works", plan: "SCN Pair Standard", sub: "c2859000-0000-4000-8000-000000000021" };
const ORDINARY = { scenario: "approved-quote", quote: "Q-SCN-AP-1" };
const TEST_UPI = "r2869cardtest@okhdfcbank";
const db = () => localDb("R-2869");
let oldUpi = "";

function scenario(name: string, flag: "--reset" | "--clear"): void {
  const prod = path.resolve(__dirname, "..", "..");
  const r = spawnSync(process.execPath, ["scripts/dev/scenario.mjs", name, flag], { cwd: prod, encoding: "utf8", timeout: 180_000 });
  if (r.status !== 0) throw new Error(`scenario ${name} ${flag} failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
}

const tenantUpi = (): string => db().one(`select coalesce(upi_vpa, '') from public.tenants where id = ${E2E_TENANT_SQL}`);

/** Settings → Your UPI ID → Save changes (the app's own step). */
async function setUpi(page: Page, value: string): Promise<void> {
  await openAppPage(page, "/settings", /Settings/);
  const input = page.locator("#settings-your-upi-id-optional");
  await expect(input).toBeVisible({ timeout: 90_000 });
  await fillKept(input, value);
  const save = page.getByRole("button", { name: "Save changes" });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await expect.poll(() => tenantUpi(), { timeout: 60_000 }).toBe(value);
}

/** The live part proforma of the scenario's Standard subscription. */
function proformaId(): string {
  return db().one(`select q.id from public.quotes q join public.subscription_billings b on b.id = q.subscription_billing_id
    where q.tenant_id = ${E2E_TENANT_SQL} and b.subscription_id = '${PART.sub}' and q.cancelled_at is null and q.invoice_id is null
    order by q.created_at desc limit 1`);
}

/** Open a quote page, press Preview, return the UPI block's text (the QR must be there too). */
async function previewUpi(page: Page, quoteId: string): Promise<string> {
  await openAppPage(page, `/quotes/${encodeURIComponent(quoteId)}`);
  const btn = page.getByRole("button", { name: "Preview", exact: true });
  await expect(btn).toBeVisible({ timeout: 90_000 });
  await btn.click();
  const block = await onlyOne(page.getByTestId("preview-upi-block"), "the preview's UPI block", 90_000);
  await expect(block.getByTestId("preview-upi-qr")).toBeVisible({ timeout: 60_000 });
  await expect(block).toContainText(TEST_UPI);
  return block.innerText();
}

test.describe("R-2869 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  test.beforeAll(() => {
    if (!CARD_TESTS_ON) return;
    oldUpi = tenantUpi();
    scenario(PART.scenario, "--reset");
    scenario(ORDINARY.scenario, "--reset");
  });
  test.afterAll(async ({ browser }: { browser: Browser }) => {
    if (!CARD_TESTS_ON) return;
    try {
      if (tenantUpi() !== oldUpi) {
        const page = await pageAs(browser, process.env.BASE_URL ?? "http://localhost:3001", "owner");
        await setUpi(page, oldUpi);
        await page.context().close();
      }
    } finally {
      scenario(PART.scenario, "--clear");
      scenario(ORDINARY.scenario, "--clear");
    }
  });

  test("Step 1: Settings → set a UPI ID (so the QR block shows), then Renewals → Overdue → ⋯ → Bill next part makes a part proforma", async ({ browser, baseURL }) => {
    test.setTimeout(600_000);
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await setUpi(page, TEST_UPI);
      await page.setViewportSize({ width: 1280, height: 800 });
      await openAppPage(page, "/renewals?bucket=overdue", /Renewals/);
      const row = page.locator("tr").filter({ has: page.getByTestId("renewal-open-drawer").filter({ hasText: PART.plan }) }).filter({ visible: true });
      await expect(row).toHaveCount(1, { timeout: 150_000 });
      const dlg = page.getByRole("dialog");
      await expect(async () => {
        if (!(await page.getByRole("menuitem", { name: /Bill next part/ }).isVisible())) await row.getByTestId("stage-more").click({ timeout: 5_000 });
        await page.getByRole("menuitem", { name: /Bill next part/ }).click({ timeout: 5_000 });
        await expect(dlg).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 90_000 });
      await expect(dlg).toContainText(`${PART.name} · ${PART.plan}`, { timeout: 60_000 });
      const create = await onlyOne(dlg.getByRole("button", { name: /^Create (\d+ )?proformas?$/ }), "Create proforma button");
      await expect(create).toBeEnabled({ timeout: 150_000 });
      await create.click();
      await expect.poll(() => proformaId(), { timeout: 150_000 }).not.toBe("");
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: the part proforma's Preview → UPI block says 'Scan to pay' + tax invoice raised on payment — not 'this advance' / 'receipt voucher'", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    const id = proformaId();
    test.skip(!id, "needs Step 1's part proforma");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const text = await previewUpi(page, id);
      expect(text).toMatch(/^Scan to pay\n/);
      expect(text).toContain("A GST tax invoice is raised when the payment is received.");
      expect(text).not.toMatch(/advance|receipt voucher/i);
    } finally {
      await page.context().close();
    }
  });

  test("Step 3: an ordinary quote's Preview still says 'Scan to pay this advance' + receipt voucher", async ({ browser, baseURL }) => {
    test.setTimeout(300_000);
    test.skip(tenantUpi() !== TEST_UPI, "needs Step 1's UPI ID");
    const page = await pageAs(browser, baseURL, "owner");
    try {
      const text = await previewUpi(page, ORDINARY.quote);
      expect(text).toMatch(/^Scan to pay this advance\n/);
      expect(text).toContain("You'll receive a receipt voucher, and a GST tax invoice when the order is provisioned.");
    } finally {
      await page.context().close();
    }
  });
});
