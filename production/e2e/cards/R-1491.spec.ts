/**
 * Card test — R-1491 "Google Workspace product badalne par WhatsApp ke sandesh ek ke upar ek jud
 * jaate hain — har baar sirf naya sandesh dikhe" (R-2550).
 *
 * Pawan (staging, 17 Oct): on the website trial form, trying one Google Workspace product and then
 * another stacked the old request onto the new one. The owner's path, with real clicks on the
 * public /trial page (no login — a website visitor): Business Starter → Request → Send on WhatsApp
 * → "← Change the request" → Business Standard → Request again. The second WhatsApp message must
 * be Standard's only, say which request it replaces, and the old "WhatsApp also opened" note must
 * be gone.
 *
 * /api/enquiry is answered by the test (page.route) — so no lead / draft quote is written to the
 * local DB; what is checked is what the visitor sees and what WhatsApp would receive.
 * Run: `node scripts/ops/card-tests.mjs R-1491`.
 */
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests } from "./card-steps";

async function stubEnquiry(page: Page): Promise<string[]> {
  const bodies: string[] = [];
  await page.route("**/api/enquiry", async (route) => {
    bodies.push(route.request().postData() ?? "");
    await route.fulfill({ status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, ackSent: false, reference: `Q-CARD-000${bodies.length}` }) });
  });
  return bodies;
}

async function waText(page: Page): Promise<string> {
  const href = (await page.getByRole("link", { name: "Send on WhatsApp" }).getAttribute("href")) ?? "";
  return decodeURIComponent(href.split("?text=")[1] ?? "");
}

async function requestTrial(page: Page): Promise<void> {
  await page.getByRole("button", { name: /Request the free trial/ }).first().click();
  await expect(page.getByRole("link", { name: "Send on WhatsApp" })).toBeVisible({ timeout: 30_000 });
}

test.describe("R-1491 trial form — product change replaces the WhatsApp message", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;
  let bodies: string[];

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
    page = await context.newPage();
    // WhatsApp must not really open in a tab during the test.
    await context.route(/wa\.me|whatsapp\.com/, (r) => r.fulfill({ status: 204, body: "" }));
    bodies = await stubEnquiry(page);
  });
  test.afterAll(async () => { await page?.context().close(); });

  test("Step 1: /trial — Business Starter request → WhatsApp message is Starter's", async () => {
    await page.goto("/trial", { waitUntil: "domcontentloaded", timeout: 120_000 });
    await page.getByRole("radio", { name: /Google Workspace Business Starter/ }).click();
    await page.getByRole("button", { name: /Continue to details/ }).click();
    await page.getByLabel(/^Company/).first().fill("Card Test Traders");
    await page.getByLabel(/Your name/).first().fill("Card Tester");
    await page.getByLabel(/Domain/).first().fill("cardtest.in");
    await page.getByLabel(/Email — the logins go here/).first().fill("cardtest@cardtest.in");
    await page.getByLabel(/^Mobile/).first().fill("98765 43210");
    await requestTrial(page);
    const text = await waText(page);
    expect(text).toContain("TRIAL REQUEST Q-CARD-0001");
    expect(text).toContain("Edition: Google Workspace Business Starter");
    await page.getByRole("link", { name: "Send on WhatsApp" }).click();
    await expect(page.getByText(/WhatsApp also opened with the request written/)).toBeVisible();
  });

  test("Step 2: Change the request → Business Standard → only Standard's message, names the old request", async () => {
    await page.getByRole("button", { name: /Change the request/ }).click();
    await page.getByRole("radio", { name: /Google Workspace Business Standard/ }).click();
    await page.getByRole("button", { name: /Continue to details/ }).click();
    await requestTrial(page);
    const text = await waText(page);
    expect(text).toContain("TRIAL REQUEST Q-CARD-0002");
    expect(text).toContain("Edition: Google Workspace Business Standard");
    expect(text).not.toContain("Business Starter");
    expect(text.match(/TRIAL REQUEST/g)?.length).toBe(1);
    expect(text).toContain("Replaces my earlier request Q-CARD-0001");
    const second = JSON.parse(bodies[1] ?? "{}") as { edition?: string; requirement?: string };
    expect(second.edition).toBe("GW Business Standard");
    expect(second.requirement).toContain("Replaces my earlier request Q-CARD-0001");
  });

  test("Step 3: the old 'WhatsApp also opened' note is gone from the new confirmation", async () => {
    await expect(page.getByText(/WhatsApp also opened with the request written/)).toHaveCount(0);
    await expect(page.getByText(/We confirm the trial length and cap before switching anything on/)).toBeVisible();
  });
});
