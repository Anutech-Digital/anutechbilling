/**
 * Card test — R-2173 "Correct an issued invoice's date while its GST month is not filed".
 *
 * One test per howToCheck step, on the LOCAL app (E2E Test Co) through the Local test login.
 * Run: `node scripts/ops/card-tests.mjs R-2173`.
 *
 * Data: the newest paid/pending INR tax invoice of E2E Test Co dated in Oct 2026 with no IRN, no Zoho
 * import, no credit/debit note and no network copy (local docker DB only — the local guard refuses any
 * other target). Step 1 moves it 10 days earlier and back again (two logged corrections, date restored);
 * Step 2 sets "GST returns filed up to" September 2026 in the DB, checks the refusal, and clears it again.
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
  if (why || !c) throw new Error(`R-2173 card test refuses to touch test data: ${why}`);
  return c;
}

function psql(sql: string): string[] {
  const r = spawnSync("docker", ["exec", "-i", container(), "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
    { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
  return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
}

const TENANT = `(select id from public.tenants where email = '${E2E_TENANT_EMAIL}')`;

function pickInvoice(): { id: string; date: string } {
  const row = psql(`select i.id || '|' || i.invoice_date from public.invoices i
    where i.tenant_id = ${TENANT} and coalesce(i.document_kind, 'tax_invoice') = 'tax_invoice' and i.status in ('pending', 'paid', 'overdue')
      and nullif(btrim(coalesce(i.gst_irn, '')), '') is null and i.zoho_invoice_id is null and i.fx_rate is null and coalesce(i.currency, 'INR') = 'INR'
      and i.invoice_date between '2026-10-11' and '2026-10-31'
      and not exists (select 1 from public.credit_notes c where c.invoice_id = i.id)
      and not exists (select 1 from public.debit_notes d where d.invoice_id = i.id)
      and not exists (select 1 from public.network_documents n where n.seller_invoice_id = i.id)
      and not exists (select 1 from public.vendor_bills b where b.source_tenant_invoice_id = i.id)
    order by i.invoice_date desc, i.id limit 1;`)[0];
  if (!row) throw new Error("No Oct 2026 INR tax invoice in E2E Test Co to correct (seed / scenarios?)");
  const [id, date] = row.split("|");
  return { id, date };
}

const dateOf = (id: string) => psql(`select invoice_date from public.invoices where id = '${id}';`)[0];
const logs = (id: string) => Number(psql(`select count(*) from public.activity_log where action = 'invoice.date_corrected' and entity_id = '${id}';`)[0]);
const minusDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const clearFiled = () => psql(`update public.tenants set gst_filed_through = null where id = ${TENANT};`);

async function correct(page: Page, id: string, to: string, reason: string): Promise<void> {
  await openAppPage(page, `/invoices/${encodeURIComponent(id)}`);
  const btn = page.getByTestId("correct-invoice-date");
  await expect(btn).toBeVisible({ timeout: 60_000 });
  await btn.click();
  const sheet = page.getByRole("dialog", { name: "Correct invoice date" });
  await expect(sheet).toBeVisible({ timeout: 30_000 });
  await sheet.getByLabel("Correct date").fill(to);
  await sheet.getByLabel(/^Why/).fill(reason);
  await sheet.getByTestId("correct-invoice-date-save").click();
}

test.describe("R-2173 correct invoice date", () => {
  onlyInCardTests();
  test.describe.configure({ mode: "serial" });
  let inv = { id: "", date: "" };
  test.beforeAll(() => { if (CARD_TESTS_ON) { clearFiled(); inv = pickInvoice(); } });
  test.afterAll(() => { if (CARD_TESTS_ON) clearFiled(); });

  test("Step 1: owner corrects an Oct 2026 invoice's date (and back), each change logged", async ({ browser, baseURL }) => {
    test.setTimeout(240_000);
    const page = await pageAs(browser, baseURL, "owner");
    const before = logs(inv.id);
    const to = minusDays(inv.date, 10);
    await correct(page, inv.id, to, "Card test R-2173 - money came earlier");
    await expect.poll(() => dateOf(inv.id), { timeout: 60_000 }).toBe(to);
    await expect(page.getByText(new RegExp(`Invoice ${inv.id} is now dated`)).first()).toBeVisible({ timeout: 30_000 });
    await correct(page, inv.id, inv.date, "Card test R-2173 - put back");
    await expect.poll(() => dateOf(inv.id), { timeout: 60_000 }).toBe(inv.date);
    expect(logs(inv.id)).toBe(before + 2);
    await page.context().close();
  });

  test("Step 2: GST filed up to September 2026 → moving it into September is refused", async ({ browser, baseURL }) => {
    test.setTimeout(180_000);
    psql(`update public.tenants set gst_filed_through = '2026-09-30' where id = ${TENANT};`);
    const page = await pageAs(browser, baseURL, "owner");
    await correct(page, inv.id, "2026-09-20", "Card test R-2173 - filed month");
    await expect(page.getByText(/GST for Sep 2026 is already filed/).first()).toBeVisible({ timeout: 60_000 });
    expect(dateOf(inv.id)).toBe(inv.date);
    clearFiled();
    await page.context().close();
  });

  test("Step 3: a manager login sees the invoice but no Correct date button", async ({ browser, baseURL }) => {
    test.setTimeout(120_000);
    const page = await pageAs(browser, baseURL, "manager");
    await openAppPage(page, `/invoices/${encodeURIComponent(inv.id)}`);
    await expect(page.getByText(inv.id).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId("correct-invoice-date")).toHaveCount(0);
    await page.context().close();
  });
});
