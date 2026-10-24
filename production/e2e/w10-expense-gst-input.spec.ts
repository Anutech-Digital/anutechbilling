/**
 * W10 — Expense / purchase bill → GST input credit (R-053).
 *
 * Logged in as the ACCOUNTANT of "E2E Test Co". Both entries are made in the UI:
 *   1. COGS bill  — "Add Bill": subtotal ₹1,000, "Intra-state GST 18%" → CGST 90 + SGST 90
 *   2. Expense    — "Add Expense" → "GST invoice": ₹2,xxx incl. 18% GST, vendor picked from
 *                   the list (the seeded "E2E Vendor Pvt Ltd", which has a GSTIN — without a
 *                   vendor GSTIN the app correctly refuses to count it as input credit)
 * Then /accounting/gst for today shows both under "Input GST · purchases" with the GST
 * as claimable, and the bill is stored with the right heads.
 */
import {
  test, expect, skipUnlessRoles, inr, runTag, todayIST, expectAppPage,
} from "./fixtures/roles";
import { E2E_VENDOR_NAME, E2E_VENDOR_GSTIN } from "./fixtures/e2e-roles.mjs";

test.describe("W10 expense / purchase bill → GST input (accountant)", () => {
  skipUnlessRoles(["accountant"]);
  test.use({ role: "accountant" });
  test.describe.configure({ timeout: 120_000 });

  test("a GST bill and a GST expense both become claimable input GST", async ({ page, db }) => {
    const tag = runTag();
    const day = todayIST();
    const billVendor = `E2E Bill Vendor ${tag}`;
    const expenseNote = `E2E expense ${tag}`;
    // A unique amount per run: the app (rightly) asks before saving a same-vendor,
    // same-day, same-amount expense twice.
    const expTaxable = 2000 + Math.floor(Math.random() * 900) + 1;
    const expGst = Math.round(expTaxable * 0.18);
    const expTotal = expTaxable + expGst;

    // ── 1. COGS bill ──
    await expectAppPage(page, "/accounting/bills", /COGS Bills/);
    await page.getByRole("button", { name: "Add Bill" }).filter({ visible: true }).first().click();
    await page.locator("#vendor_name").fill(billVendor);
    await page.locator("#vendor_gstin").fill(E2E_VENDOR_GSTIN);
    await page.locator("#bill_no").fill(`E2E-BILL-${tag}`);
    await page.locator("#bill_date").fill(day);
    await page.locator("#subtotal").fill("1000");
    await page.getByRole("button", { name: /Intra-state GST 18%/ }).click();
    await expect(page.locator("#cgst")).toHaveValue("90");
    await expect(page.locator("#sgst")).toHaveValue("90");
    await expect(page.locator("#total")).toHaveValue("1180"); // the GST button fills the total too
    await page.getByRole("button", { name: "Save bill" }).click();
    await expect(page.getByText("Bill added").first()).toBeVisible({ timeout: 20_000 });

    const { data: bills } = await db.from("vendor_bills")
      .select("total, cgst, sgst, igst, status").eq("vendor_name", billVendor);
    expect(bills).toHaveLength(1);
    expect(bills![0]).toMatchObject({ total: 1180, cgst: 90, sgst: 90, status: "unpaid" });

    // ── 2. GST expense ──
    await expectAppPage(page, "/accounting/expenses", /Expenses/);
    await page.getByRole("button", { name: "Add Expense" }).filter({ visible: true }).first().click();
    await page.getByRole("button", { name: "GST invoice", exact: true }).click();
    await page.locator("#expense_date").fill(day);
    await page.locator("#description").fill(expenseNote);
    await page.locator("#amount").fill(String(expTotal));
    // R-1729: Category starts empty and is required (it used to sit on "Hosting").
    await page.locator("#category").click();
    await page.getByRole("option", { name: "Software", exact: true }).click();
    await page.locator("#gst_paid").fill(String(expGst));
    await page.locator("#vendor_name").fill(E2E_VENDOR_NAME.slice(0, 10));
    await page.getByRole("button", { name: new RegExp(`${E2E_VENDOR_NAME}.*${E2E_VENDOR_GSTIN}`) }).click();
    await expect(page.locator("#vendor_name")).toHaveValue(E2E_VENDOR_NAME);
    await page.getByRole("button", { name: "Save expense" }).click();
    await expect(page.getByText("Expense added").first()).toBeVisible({ timeout: 20_000 });

    const { data: exp } = await db.from("expenses")
      .select("amount, gst_paid, bill_type, vendor_id").eq("description", expenseNote);
    expect(exp).toHaveLength(1);
    expect(exp![0]).toMatchObject({ amount: expTotal, gst_paid: expGst, bill_type: "gst" });
    expect((exp![0] as { vendor_id: string | null }).vendor_id, "expense is linked to the GST vendor").toBeTruthy();

    // ── 3. Both are input GST on the GST report ──
    await expectAppPage(page, "/accounting/gst", /GST Reports/);
    await page.getByLabel("From date").fill(day);
    await page.getByLabel("To date").fill(day);
    const input = page.getByRole("table").filter({
      has: page.getByRole("columnheader", { name: "GST claimable" }),
    });
    const billRow = input.getByRole("row").filter({ hasText: billVendor });
    await expect(billRow).toBeVisible({ timeout: 20_000 });
    await expect(billRow).toContainText(inr(1000));
    await expect(billRow).toContainText(inr(180));
    const expRow = input.getByRole("row").filter({ hasText: E2E_VENDOR_NAME }).filter({ hasText: inr(expGst) });
    await expect(expRow.first()).toBeVisible();
    await expect(expRow.first()).toContainText(inr(expTaxable));
    await expect(page.getByText("Input GST paid").first()).toBeVisible();
  });
});
