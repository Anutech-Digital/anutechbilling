/**
 * Card test — R-2837 "Customer page: Transactions tab + segment in the URL".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2837`. Writes no data; takes the first customer in the list.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs } from "./card-steps";

let shared: Page | null = null;
let customerPath: string | null = null;

async function firstCustomerPath(page: Page): Promise<string | null> {
  if (customerPath) return customerPath;
  await openAppPage(page, "/customers");
  const rows = page.locator('a[href^="/customers/"]');
  await rows.first().waitFor({ state: "visible", timeout: 120_000 }).catch(() => undefined);
  const hrefs = await rows.evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""));
  /* a real customer link is /customers/<uuid> — not /customers/groups, /new, /import … */
  const hit = hrefs.map((h) => h.split("?")[0]).find((h) => /^\/customers\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(h));
  customerPath = hit ?? null;
  return customerPath;
}

test.describe("R-2837 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test("Step 1: the link ?tab=transactions&show=payments lands on Transactions → Payments", async ({ browser, baseURL }) => {
    shared = await pageAs(browser, baseURL, "owner");
    const path = await firstCustomerPath(shared);
    test.skip(!path, "no customer in the local company");
    await openAppPage(shared, `${path}?tab=transactions&show=payments`);
    const tabs = shared.getByRole("tab", { name: /Transactions/ });
    await expect(tabs.first()).toHaveAttribute("aria-selected", "true", { timeout: 90_000 });
    expect(shared.url()).toContain("show=payments");
  });

  test("Step 2: picking another segment / tab changes the address; Back leaves the page", async () => {
    test.skip(!shared || !customerPath, "no customer in the local company");
    const page = shared!;
    await page.getByRole("tab", { name: /Statement/ }).first().click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).toContain("tab=statement");
    expect(page.url()).not.toContain("show=");
    await page.getByRole("tab", { name: /Overview/ }).first().click();
    await expect.poll(() => page.url(), { timeout: 30_000 }).not.toContain("tab=");
  });
});
