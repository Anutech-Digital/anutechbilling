/**
 * Card test — R-1002 "Data leak: activity_log readable by all roles and holds secrets".
 *
 * One test per howToCheck step (titles start "Step N"), on the LOCAL app (E2E Test Co) through
 * the Local test login. Run: `node scripts/ops/card-tests.mjs R-1002`.
 *
 * The card's howToCheck was written for staging; here every step runs on localhost:
 *   - Step 2 uses the Sales login (Billing / Support / Delivery: the SQL proof in step 5 covers
 *     every role). The deals Sales can open have no activity_log rows locally, so the test adds
 *     one stage-change row on such a deal (removed after) and checks the owner DOES see it.
 *   - Step 3: the "Changes by staff" box now lives on Payroll → Attendance Register
 *     (/accounting/attendance, AttendanceTab), not on /accounting/payroll. Both pages are opened;
 *     the box is judged where it is. The owner sees the same box non-empty (contrast).
 *   - Step 4 uses its OWN dummy employee (inserted in the local DB, deleted after) — no real
 *     employee's PIN is touched.
 *   - Step 5 runs supabase/tests/r1002_activity_log.test.sql in the local docker DB
 *     (one rolled-back transaction).
 * Local DB access: `docker exec <R1002_DB_CONTAINER|supabase_db_resellerosv3> psql`.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { onlyInCardTests, openAppPage, pageAs, pathOf } from "./card-steps";

const DB = process.env.R1002_DB_CONTAINER || "supabase_db_resellerosv3";
const TENANT_NAME = "E2E Test Co";
/** A deal the Sales test login can open (RLS) — seeded scenario data in E2E Test Co. */
const SALES_DEAL = "L-S14TEST1";
const SALES_DEAL_NAME = "S14 Test Buyer Pvt Ltd";

function psql(sql: string, input?: string): { ok: boolean; out: string } {
  const args = ["exec", "-i", DB, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
  const r = spawnSync("docker", input === undefined ? [...args, "-c", sql] : args, { input, encoding: "utf8", timeout: 120_000 });
  return { ok: r.status === 0, out: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() };
}
function needDb(): void {
  const r = psql("select 1");
  test.skip(!r.ok, `Local DB container ${DB} not reachable (${r.out.slice(0, 120)}) — start the local Supabase stack.`);
}
function tenantId(): string {
  const r = psql(`select id from public.tenants where name = '${TENANT_NAME}' limit 1`);
  expect(r.ok, r.out).toBe(true);
  expect(r.out, `${TENANT_NAME} not found in the local DB`).toMatch(/^[0-9a-f-]{36}$/);
  return r.out;
}

async function stageLines(page: Page) {
  return page.locator("main").getByText(/^Stage: .+ → .+/);
}

test.describe("R-1002 — activity_log only for owner / manager, never holds a secret", () => {
  onlyInCardTests();

  test("Step 1: Owner opens Activity Log — full list with logins and changes", async ({ browser, baseURL }) => {
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/activity", /^Activity Log$/);
      const rows = page.locator("main li");
      await expect(rows.first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/Could not load activity/)).toHaveCount(0);
      await expect(page.locator("main").getByText(/^logged in$/).first()).toBeVisible();
      await expect(page.locator("main").getByText(/^(created|updated|deleted) \S/).first()).toBeVisible();
      test.info().annotations.push({ type: "note", description: `Owner sees ${await rows.count()} activity lines (logins + changes).` });
    } finally {
      await page.context().close();
    }
  });

  test("Step 2: Sales opens a deal from /deals — no error, no stage-history/audit lines", async ({ browser, baseURL }) => {
    // Sales can open only some deals, and none of them has activity_log rows locally. So the test
    // adds ONE stage-change audit row (own test data, removed after) on a deal Sales can open, and
    // the owner must see it as "Stage: … → …" — then "none" for Sales is a real proof.
    needDb();
    const tid = tenantId();
    const add = psql(`insert into public.activity_log (tenant_id, user_id, action, entity, entity_id, label, changes) values ('${tid}', null, 'update', 'leads', '${SALES_DEAL}', 'R1002 card test', '{"stage": {"old": "contact", "new": "quote"}}') returning id`);
    expect(add.ok, add.out).toBe(true);
    const logId = Number(add.out.split("\n")[0].trim());
    try {
      const owner = await pageAs(browser, baseURL, "owner");
      let ownerStages = 0;
      try {
        await openAppPage(owner, `/deals/${SALES_DEAL}`);
        await expect(owner.getByText("Newest first").first()).toBeVisible({ timeout: 60_000 });
        await expect((await stageLines(owner)).first()).toBeVisible({ timeout: 60_000 });
        ownerStages = await (await stageLines(owner)).count();
      } finally {
        await owner.context().close();
      }

      const page = await pageAs(browser, baseURL, "sales");
      try {
        await openAppPage(page, "/deals");
        expect(pathOf(page)).toBe("/deals");
        // List view: a table row opens the deal page (the Kanban card is also a drag handle).
        await page.getByRole("button", { name: "List", exact: true }).click({ timeout: 60_000 });
        await page.locator("main tr").filter({ hasText: SALES_DEAL_NAME }).first().click({ timeout: 60_000 });
        await expect(page).toHaveURL(new RegExp(`/deals/${SALES_DEAL}$`), { timeout: 60_000 });
        await expect(page.getByText("Newest first").first()).toBeVisible({ timeout: 60_000 });
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
        await expect(page.getByRole("heading", { name: "Deal not found" })).toHaveCount(0);
        await expect(await stageLines(page), "Sales must not see stage-history lines from activity_log").toHaveCount(0);
        await expect(page.getByText(/Couldn't load \(permission or network\)/)).toHaveCount(0);
        await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
        test.info().annotations.push({ type: "note", description: `Deal "${SALES_DEAL_NAME}" (${SALES_DEAL}) opened from /deals: owner sees ${ownerStages} "Stage: … → …" line(s) from activity_log, Sales sees 0, no red error.` });
      } finally {
        await page.context().close();
      }
    } finally {
      psql(`delete from public.activity_log where id = ${logId}`);
    }
  });

  test("Step 3: Accountant — Payroll opens; 'Changes by staff' says 'No changes by staff yet.'", async ({ browser, baseURL }) => {
    // Owner contrast: the same box lists real attendance changes for the owner.
    const owner = await pageAs(browser, baseURL, "owner");
    let ownerHasChanges = false;
    try {
      await openAppPage(owner, "/accounting/attendance");
      const box = owner.getByText("Changes by staff", { exact: true });
      await expect(box).toBeVisible({ timeout: 60_000 });
      await expect(owner.getByText(/^Loading…$/)).toHaveCount(0, { timeout: 60_000 });
      ownerHasChanges = (await owner.getByText("No changes by staff yet.").count()) === 0;
    } finally {
      await owner.context().close();
    }

    const page = await pageAs(browser, baseURL, "accountant");
    try {
      await openAppPage(page, "/accounting/payroll", /^Payroll$/);
      expect(pathOf(page)).toBe("/accounting/payroll");
      // The box moved to Payroll → Attendance Register.
      await openAppPage(page, "/accounting/attendance");
      expect(pathOf(page)).toBe("/accounting/attendance");
      await expect(page.getByText("Changes by staff", { exact: true })).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText("No changes by staff yet.")).toBeVisible({ timeout: 60_000 });
      await expect(page.getByText(/Could not load the change history/)).toHaveCount(0);
      test.info().annotations.push({
        type: "note",
        description: `'Changes by staff' is on /accounting/attendance now (not /accounting/payroll). Accountant: "No changes by staff yet."; owner: ${ownerHasChanges ? "sees a non-empty list" : "also empty (weak contrast)"}.`,
      });
    } finally {
      await page.context().close();
    }
  });

  test("Step 4: Owner changes a dummy employee's kiosk PIN — Activity Log line has no PIN, only '+N more fields'", async ({ browser, baseURL }) => {
    needDb();
    const tid = tenantId();
    const stamp = Date.now().toString(36).toUpperCase();
    const name = `R1002 Pin Dummy ${stamp}`;
    const pin = String(400000 + (Date.now() % 500000)).slice(0, 6);
    const ins = psql(`insert into public.employees (tenant_id, name, monthly_gross, is_active) values ('${tid}', '${name}', 1000, true) returning id`);
    expect(ins.ok, ins.out).toBe(true);
    const empId = ins.out.split("\n")[0].trim();
    const page = await pageAs(browser, baseURL, "owner");
    try {
      await openAppPage(page, "/accounting/employees", /^Employees$/);
      await page.getByRole("button", { name: `Actions for ${name}` }).click({ timeout: 60_000 });
      await page.getByRole("menuitem", { name: /Edit profile & salary/ }).click();
      const dlg = page.getByRole("dialog");
      await dlg.getByRole("button", { name: /Statutory & Access/ }).click();
      await dlg.getByLabel(/Attendance Kiosk PIN/).fill(pin);
      await dlg.getByRole("button", { name: /^Save$/ }).click();
      await expect(dlg).toHaveCount(0, { timeout: 60_000 });

      // DB: the update row carries _redacted: ["pin_hash"], never the hash itself.
      const log = psql(`select changes::text from public.activity_log where entity = 'employees' and entity_id = '${empId}' and action = 'update' and changes ? '_redacted' order by created_at desc limit 1`);
      expect(log.ok, log.out).toBe(true);
      expect(log.out, "no update row with _redacted for the PIN change").toContain("pin_hash");
      expect(log.out).not.toMatch(/"pin_hash"\s*:/);
      const anyHash = psql(`select count(*) from public.activity_log where entity_id = '${empId}' and changes::text ~ '"pin_hash"\\s*:'`);
      expect(anyHash.out, "an activity_log row for the dummy holds a pin_hash value").toBe("0");

      await openAppPage(page, "/activity", /^Activity Log$/);
      const line = page.locator("main li").filter({ hasText: /updated employee/ }).filter({ hasText: name }).first();
      await expect(line).toBeVisible({ timeout: 60_000 });
      const text = (await line.innerText()).replace(/\s+/g, " ");
      expect(text).toMatch(/\+\d+ more fields?/);
      expect(text, "PIN value shown in the Activity Log").not.toContain(pin);
      expect(text).not.toMatch(/pin_hash/);
      test.info().annotations.push({ type: "note", description: `Activity line: "${text}". DB changes: ${log.out}` });
    } finally {
      await page.context().close();
      // Own test data only: remove the dummy and its log rows.
      psql(`delete from public.activity_log where entity = 'employees' and entity_id = '${empId}'`);
      psql(`delete from public.employees where id = '${empId}'`);
      psql(`delete from public.activity_log where entity = 'employees' and entity_id = '${empId}'`);
    }
  });

  test("Step 5: SQL proof — r1002_activity_log.test.sql on the local DB says PASS", async () => {
    needDb();
    const file = path.resolve(__dirname, "../../supabase/tests/r1002_activity_log.test.sql");
    const r = psql("", fs.readFileSync(file, "utf8"));
    expect(r.out, r.out.slice(-1500)).toContain("PASS r1002_activity_log");
    expect(r.ok, r.out.slice(-1500)).toBe(true);
  });
});
