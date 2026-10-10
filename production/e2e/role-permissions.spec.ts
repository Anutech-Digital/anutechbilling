/**
 * role-permissions.spec.ts — verify role-based UI gating + middleware redirects.
 *
 * Sales role (Darshan @ Excel Tech) is restricted:
 *   - Sidebar nav shows only 3 items (Leads / Deal Pipeline / Tasks)
 *   - /accounting/* routes redirect to /leads
 *   - /customers, /quotes, /invoices, /payments redirect to /leads
 *   - /settings is hidden / blocked
 *   - Lead page header hides: Import CSV, Send campaign, Start trial, Import Google
 *   - Mobile bottom nav shows only 4 tabs (Leads / Deals / Tasks / More)
 *   - Lead Intelligence card hidden for sales
 *   - CSV import button hidden — sales can't bulk-import
 *
 * Owner role (Pardeep) sees everything.
 *
 * Tests skip until staging Supabase has test users seeded. Written now
 * to lock in expected behavior and catch regressions during refactors.
 */
import { expect, test } from "@playwright/test";
import { loginViaSupabase } from "./fixtures/auth";

const hasEnv = Boolean(
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY,
);

test.describe("Role gating — Sales role restrictions", () => {
  test.skip(!hasEnv, "Needs NEXT_PUBLIC_SUPABASE_ANON_KEY + seeded sales user in .env.test.");

  test.beforeEach(async ({ context }) => {
    await loginViaSupabase(context, "sales@testa.dev");
  });

  test("Sidebar shows only Workspace section (3 items) for sales", async ({ page }) => {
    await page.goto("/leads");
    // Sales should see: Leads, Deal Pipeline, Tasks. Nothing else from Workspace
    // or any other section (Revenue, Procurement, Accounting are owner-only).
    const sidebar = page.locator('aside.md\\:flex').first();
    await expect(sidebar).toBeVisible();
    await expect(sidebar.getByText("Leads", { exact: true })).toBeVisible();
    await expect(sidebar.getByText(/Deal Pipeline/i)).toBeVisible();
    await expect(sidebar.getByText("Tasks", { exact: true })).toBeVisible();
    // Companies / Items / Revenue / Accounting MUST NOT appear.
    await expect(sidebar.getByText("Companies", { exact: true })).not.toBeVisible();
    await expect(sidebar.getByText("Quotes",    { exact: true })).not.toBeVisible();
    await expect(sidebar.getByText("Invoices",  { exact: true })).not.toBeVisible();
    await expect(sidebar.getByText(/Accounting|Revenue/i)).not.toBeVisible();
  });

  test("/customers — sales gets redirected away", async ({ page }) => {
    await page.goto("/customers");
    // Middleware should bounce them to /leads (their ROLE_HOME).
    await expect(page).toHaveURL(/\/leads/, { timeout: 5_000 });
  });

  test("/accounting/saas-metrics — sales blocked", async ({ page }) => {
    await page.goto("/accounting/saas-metrics");
    await expect(page).toHaveURL(/\/leads/, { timeout: 5_000 });
  });

  test("/quotes — sales blocked", async ({ page }) => {
    await page.goto("/quotes");
    await expect(page).toHaveURL(/\/leads/, { timeout: 5_000 });
  });

  test("/leads — sales sees the inbox, NOT the advanced toolbar buttons", async ({ page }) => {
    await page.goto("/leads");
    // Advanced toolbar buttons MUST be hidden for sales:
    await expect(page.getByRole("button", { name: /^Import CSV/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Send campaign/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Start trial/i })).not.toBeVisible();
    await expect(page.getByRole("button", { name: /Import from Google/i })).not.toBeVisible();
    // Lead Intelligence card (owner-only) MUST be hidden.
    await expect(page.getByText(/Lead intelligence/i)).not.toBeVisible();
  });
});

test.describe("Role gating — Owner has full access", () => {
  test.skip(!hasEnv, "Needs NEXT_PUBLIC_SUPABASE_ANON_KEY + seeded owner user in .env.test.");

  test.beforeEach(async ({ context }) => {
    await loginViaSupabase(context, "owner@testa.dev");
  });

  test("Sidebar shows full nav with Revenue + Accounting + Procurement sections", async ({ page }) => {
    await page.goto("/dashboard");
    const sidebar = page.locator('aside.md\\:flex').first();
    await expect(sidebar.getByText("Dashboard", { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Companies",  { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Quotes",     { exact: true })).toBeVisible();
    await expect(sidebar.getByText("Invoices",   { exact: true })).toBeVisible();
    // Section headers (sticky labels in the sidebar)
    await expect(sidebar.getByText(/Revenue/i)).toBeVisible();
    await expect(sidebar.getByText(/Accounting/i)).toBeVisible();
  });

  test("/leads — owner sees toolbar: Import CSV, Send campaign, Start trial", async ({ page }) => {
    await page.goto("/leads");
    await expect(page.getByRole("button", { name: /^Import CSV/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Send campaign/i })).toBeVisible();
    await expect(page.getByRole("button", { name: /Start trial/i })).toBeVisible();
  });

  test("/accounting/saas-metrics — owner can access", async ({ page }) => {
    await page.goto("/accounting/saas-metrics");
    // Should NOT be redirected. URL stays put.
    await page.waitForTimeout(1_000);
    await expect(page).toHaveURL(/\/accounting\/saas-metrics/);
  });
});
