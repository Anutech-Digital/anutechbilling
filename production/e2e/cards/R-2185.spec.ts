/**
 * Card test — R-2185 "Ctrl+K search: phone "9876500031" (digits only) finds nothing; "98765 00031" works".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2185`.
 *
 * Data (made fresh on every run, E2E Test Co + the local docker DB only, removed again after the run):
 * a company "CT R2185 Phone Co" whose work phone is "+91 98765 00031", and a company
 * "CT R2185 Mobile Co" whose own mobile is "+91-98765-00032".
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { CARD_TESTS_ON, onlyInCardTests, openAppPage, pageAs } from "./card-steps";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

const PROD = path.resolve(__dirname, "..", "..");
const PHONE_CO = { id: "c2185000-0000-4000-8000-000000000001", name: "CT R2185 Phone Co" };
const MOBILE_CO = { id: "c2185000-0000-4000-8000-000000000002", name: "CT R2185 Mobile Co" };

/* ── local docker DB (same guard as scripts/dev/scenario.mjs) ── */
function container(): string {
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const c = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  const env: Record<string, string> = {};
  const f = path.join(PROD, ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
  const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container: c, urls: keys.flatMap((k) => [process.env[k], env[k]]) });
  if (why || !c) throw new Error(`R-2185 card test refuses to write test data: ${why}`);
  return c;
}

function psql(c: string, sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", c, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const CLEAN = `delete from public.customers where id in ('${PHONE_CO.id}', '${MOBILE_CO.id}');`;

function clean(): void {
  psql(container(), `begin; ${CLEAN} commit;`);
}

function seed(): void {
  const c = container();
  const tenants = psql(c, `select id from public.tenants where email = '${E2E_TENANT_EMAIL}';`);
  if (tenants.length !== 1) throw new Error(`E2E Test Co: expected 1 company, found ${tenants.length}`);
  const tenant = tenants[0].trim();
  psql(c, `
    begin;
    ${CLEAN}
    insert into public.customers (id, tenant_id, name, contact_name, contact_phone) values
      ('${PHONE_CO.id}', '${tenant}', '${PHONE_CO.name}', 'Card Test R2185', '+91 98765 00031');
    insert into public.customers (id, tenant_id, name, contact_mobile) values
      ('${MOBILE_CO.id}', '${tenant}', '${MOBILE_CO.name}', '+91-98765-00032');
    commit;`);
}

/** Open Ctrl+K, type `q`, wait for the search to settle. */
async function searchPalette(page: Page, q: string) {
  await page.keyboard.press("Control+k");
  const box = page.getByPlaceholder(/Search customers, leads/);
  await expect(box).toBeVisible({ timeout: 60_000 });
  await box.fill(q);
  await expect(page.getByText("Searching…")).toHaveCount(0, { timeout: 30_000 });
  return box;
}

test.describe("R-2185 card test", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });

  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => {
    if (!CARD_TESTS_ON) return;
    seed();
    page = await pageAs(browser, baseURL, "owner");
  });
  test.afterAll(async () => {
    if (!CARD_TESTS_ON) return;
    await page?.context().close();
    clean();
  });

  test("Step 1: Ctrl+K → type 9876500031 (digits only) → CT R2185 Phone Co appears", async () => {
    await openAppPage(page, "/dashboard");
    await searchPalette(page, "9876500031");
    await expect(page.getByRole("option", { name: new RegExp(PHONE_CO.name) })).toBeVisible({ timeout: 60_000 });
    await page.keyboard.press("Escape");
  });

  test("Step 2: the same number typed as 98765 00031, +919876500031 and 98765-00031 finds it too", async () => {
    for (const q of ["98765 00031", "+919876500031", "98765-00031"]) {
      await searchPalette(page, q);
      await expect(page.getByRole("option", { name: new RegExp(PHONE_CO.name) }), q).toBeVisible({ timeout: 60_000 });
      await page.keyboard.press("Escape");
    }
  });

  test("Step 3: a company's own mobile (+91-98765-00032) is found by 9876500032", async () => {
    await searchPalette(page, "9876500032");
    await expect(page.getByRole("option", { name: new RegExp(MOBILE_CO.name) })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("option", { name: new RegExp(PHONE_CO.name) })).toHaveCount(0);
    await page.keyboard.press("Escape");
  });
});
