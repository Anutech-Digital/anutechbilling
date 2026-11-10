/**
 * card-steps.ts — shared helpers for CARD TESTS (R-2550, 7 Nov 2026).
 *
 * Pardeep: "test ek baar likho, hamesha chalao". A board card's howToCheck becomes one spec
 * here (e2e/cards/<card id>.spec.ts), ONE test per howToCheck step, and
 * `node scripts/ops/card-tests.mjs <card id>` runs it against the localhost app in about a minute.
 *
 * Logins: the same "Local test login" buttons the /login page shows on localhost (R-281) —
 * POST /api/dev/test-login { role }. The SERVER picks the seeded E2E test account and its
 * password; this runner never sees or needs a password, and the route answers 404 anywhere but
 * `npm run dev:local` on localhost. So a card test cannot sign in to staging or live at all.
 *
 * Card specs run ONLY through card-tests.mjs (it sets CARD_TESTS=1). The normal E2E suite
 * (`npm run test:e2e`, GitHub's E2E job against staging) also collects e2e/cards/*.spec.ts —
 * there every card spec skips, because the local test login does not exist there.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Locator, type Page } from "@playwright/test";
import type { TestLoginRole } from "../../src/app/api/dev/test-login/rules";
// @ts-expect-error — plain .mjs helpers (no types)
import { scenarioTargetReason } from "../../scripts/dev/local-guard.mjs";
import { E2E_TENANT_EMAIL } from "../fixtures/e2e-roles.mjs";

/** True only inside `node scripts/ops/card-tests.mjs`. */
export const CARD_TESTS_ON = process.env.CARD_TESTS === "1";

/** Call at the top of every card spec's describe. */
export function onlyInCardTests() {
  test.skip(!CARD_TESTS_ON, "Card test — runs only via `node scripts/ops/card-tests.mjs <card>` on localhost (uses the local test login).");
}

/** The roles the Local test login box offers (src/app/api/dev/test-login/rules.ts). */
export type LocalRole = TestLoginRole;

/** Logins seeded only when their password is in .env.test (e2e-roles.mjs E2E_LOCAL_EXTRA_ROLES). */
const LOCAL_ONLY_ROLES: ReadonlySet<LocalRole> = new Set<LocalRole>(["owner2", "billing", "support"]);

/** Sign this page's browser context in as a seeded local test role (cookies land in the context). */
export async function loginLocal(page: Page, role: LocalRole): Promise<void> {
  // 60 s, not the config's 10 s action timeout: sign-in on a busy local dev server can take longer.
  const res = await page.request.post("/api/dev/test-login", { data: { role }, timeout: 60_000 });
  if (!res.ok()) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    // R-2553: owner2 / billing / support are optional local-only logins. Not seeded on this machine
    // (412: no password in .env.test) → the step is SKIPPED with the fix, not shown as a red ✗.
    if (res.status() === 412 && LOCAL_ONLY_ROLES.has(role)) {
      test.skip(true, `Local test login "${role}" is not seeded here: ${body.error ?? "no password"} ` +
        "(add it to production/.env.test, then E2E_ALLOW_SEED=1 node e2e/fixtures/seed-e2e-tenant.mjs — local DB only).");
    }
    throw new Error(
      `Local test login as ${role} answered ${res.status()}${body.error ? `: ${body.error}` : ""} — ` +
        "is localhost running with `npm run dev:local` and are the E2E test users seeded?",
    );
  }
}

/** A fresh browser context signed in as `role`. Close it when done. */
export async function pageAs(browser: Browser, baseURL: string | undefined, role: LocalRole): Promise<Page> {
  const context = await browser.newContext({ baseURL, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await loginLocal(page, role);
  return page;
}

/** Open an app page like the owner would: not bounced to /login, no error boundary. */
export async function openAppPage(page: Page, path: string, heading?: RegExp): Promise<void> {
  await page.goto(path);
  await expect(page).not.toHaveURL(/\/login/);
  if (heading) await expect(page.getByRole("heading", { name: heading }).first()).toBeVisible({ timeout: 60_000 });
  // Let the page's own data requests finish first — an error boundary or a row can appear after the heading.
  // Capped at 15 s: pages that poll never go idle, and the steps wait for their own data anyway.
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => { /* polling page: judge what is there */ });
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
}

/**
 * Which of `names` appear on the page as a WHOLE element text (exact match) — not as a piece of
 * a longer name ("Ravi" inside "Ravi Traders" does not count).
 */
export async function namesShown(page: Page, names: readonly string[]): Promise<string[]> {
  const shown: string[] = [];
  for (const n of names) {
    if ((await page.locator("main").getByText(n, { exact: true }).count()) > 0) shown.push(n);
  }
  return shown;
}

/** Pathname of the page's current URL. */
export function pathOf(page: Page): string {
  return new URL(page.url()).pathname;
}

/**
 * The "To collect" figure on Companies › Has receivables, Insights strip open or closed (R-2567,
 * shared since R-2569). Closed — the strip's default — it is the strip line's fact
 * "To collect <b>…</b>"; open, it is the tile (its <p> label + value). Never the table's
 * "To collect" column header, which is a sort button (R-2562's card test read that one with
 * getByText("To collect").first() when the strip was closed).
 */
export async function toCollectFigure(page: Page): Promise<Locator> {
  const tile = page.locator("p", { hasText: /^To collect$/ }).locator("xpath=..").filter({ visible: true });
  const fact = page.getByText(/^To collect\s+\S/).filter({ visible: true });
  await expect(tile.or(fact).first()).toBeVisible({ timeout: 60_000 });
  return (await fact.count()) > 0 ? fact.first() : tile.first();
}

/**
 * Banking → Reconcile sheet: choose the customer who paid (R-2572). The sheet opens the "Customer"
 * tile by itself only when it can guess the payer from the narration — with another local customer
 * sharing a word of the name (7 Nov: "Delhi Seats Check 2095" next to "CT R2179 Seats") it does not,
 * and "Customer who paid" is not on screen. So click the tile when the picker is not there, then
 * pick the customer by its exact name.
 */
export async function pickPayingCustomer(dlg: Locator, name: string): Promise<void> {
  const picker = dlg.getByRole("combobox", { name: "Customer who paid" });
  const tile = dlg.getByRole("radiogroup", { name: "Who is this money for?" }).getByRole("radio", { name: /^Customer\b/ });
  await expect(picker.or(tile).first()).toBeVisible({ timeout: 60_000 });
  /* R-2666 (10 Nov): a tile click while the sheet was still loading its guesses was lost — the picker never opened and
     selectOption timed out (R-2621 step 3). The tile is a radio, so clicking it again is safe: retry until the picker shows. */
  await expect(async () => {
    if (!(await picker.isVisible())) await tile.click();
    await expect(picker).toBeVisible({ timeout: 10_000 });
  }).toPass({ timeout: 60_000 });
  await picker.selectOption({ label: name });
}

/* ─────────── R-2666 (10 Nov 2026): shared fixes for the traps that broke ~8 card specs in 2 days ───────────
 * 9–10 Nov: the R-2621, R-2622, R-2624, R-2627, R-2631, R-2638, R-2642 and R-2644 specs each failed a first localhost
 * run for the SAME few reasons — no app bug. Use these instead of re-writing the fix in every spec
 * (docs/WORKER-STEPS.md → "Card spec rules"):
 *   - typed before hydration / before the stored value loaded → re-render wiped it   → waitForHydrated + fillKept
 *   - looked for a row inside a panel that opens collapsed                          → openCollapsedPanel
 *   - USD quote: the automatic "Latest" rate fetch overwrote the typed rate         → waitForAutoRateFetch
 *   - cleanup could not delete an ISSUED / PAID test invoice                        → localCleanupDeleteIssuedInvoice
 *   - getByText matched two elements (strict mode) or the wrong one (a sort header) → scope to a region + onlyOne
 *   - every spec carried its own 20-line copy of the docker/psql local-DB guard     → localDb
 */

/** SQL for E2E Test Co's tenant id (the card tests' own company). */
export const E2E_TENANT_SQL = `(select t.id from public.tenants t where t.email = '${E2E_TENANT_EMAIL}')`;

export type LocalDb = {
  /** The local supabase_db_* docker container. */
  container: string;
  /** Run SQL as postgres on the LOCAL docker DB (ON_ERROR_STOP); returns the non-empty output lines (-At). */
  psql: (sql: string) => string[];
  /** First output line, trimmed ("" when none) — for one-value reads. */
  one: (sql: string) => string;
};

/**
 * The local docker DB, guarded: throws unless every DB/Supabase URL in the env and production/.env.local points at the
 * local stack (scripts/dev/local-guard.mjs scenarioTargetReason). Call it inside a test / beforeAll — never at import
 * time — so a spec collected by the staging E2E job (where it skips) never touches docker. The guard runs once per card
 * per worker process (cached): `localDb(card).psql(...)` per statement costs no extra `docker ps`.
 */
const localDbs = new Map<string, LocalDb>();
export function localDb(card: string): LocalDb {
  const cached = localDbs.get(card);
  if (cached) return cached;
  const ps = spawnSync("docker", ["ps", "--format", "{{.Names}}"], { encoding: "utf8" });
  const c = (ps.stdout ?? "").split(/\r?\n/).map((s) => s.trim()).find((n) => /^supabase_db_/.test(n)) ?? null;
  const env: Record<string, string> = {};
  const f = path.resolve(__dirname, "..", "..", ".env.local");
  if (fs.existsSync(f)) {
    for (const line of fs.readFileSync(f, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*"?([^"\r\n]*)"?\s*$/.exec(line);
      if (m) env[m[1]] = m[2];
    }
  }
  const keys = ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL", "DATABASE_URL", "DIRECT_URL"];
  const why = scenarioTargetReason({ nodeEnv: process.env.NODE_ENV, container: c, urls: keys.flatMap((k) => [process.env[k], env[k]]) });
  if (why || !c) throw new Error(`${card} card test refuses to write test data: ${why || "no local supabase_db_* container"}`);
  if (!/^[a-z0-9@._-]+$/i.test(E2E_TENANT_EMAIL)) throw new Error("unexpected tenant email");
  const container = c;
  const psql = (sql: string): string[] => {
    const r = spawnSync("docker", ["exec", "-i", container, "psql", "-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"],
      { input: sql, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (r.status !== 0) throw new Error(`psql failed (exit ${r.status}): ${(r.stderr || r.stdout || "").trim()}`);
    return (r.stdout ?? "").split(/\r?\n/).filter(Boolean);
  };
  const db: LocalDb = { container, psql, one: (sql) => (psql(sql)[0] ?? "").trim() };
  localDbs.set(card, db);
  return db;
}

/** A fixed planted test id in SQL — only letters, digits and - _ . / ('c2631000-…', 'Q-SCN-GFO-1'). */
function sqlId(v: string): string {
  if (!/^[A-Za-z0-9._/-]+$/.test(v)) throw new Error(`not a plain test id: ${v}`);
  return `'${v}'`;
}

/**
 * Delete this card test's ISSUED / PAID local test invoices. tg_invoices_block_delete_issued refuses a plain delete; its
 * own named way past it is `set local app.invoice_amend_reason` (transaction-local), used here inside ONE transaction.
 * The delete is scoped to E2E Test Co AND the fixed ids the spec planted (or the invoices of its fixed quotes) — never a
 * pattern. `before` runs first in the same transaction (e.g. unlink quotes.invoice_id); `after` runs last (delete the
 * planted payments / quotes / customers). Local docker DB only (localDb).
 */
export function localCleanupDeleteIssuedInvoice(
  db: LocalDb,
  card: string,
  opts: { invoiceIds?: readonly string[]; quoteIds?: readonly string[]; before?: string; after?: string },
): void {
  if (!/^R-\d+$/.test(card)) throw new Error(`card id like R-1234, got ${card}`);
  const ids = (opts.invoiceIds ?? []).map(sqlId);
  const quotes = (opts.quoteIds ?? []).map(sqlId);
  const where = [ids.length ? `id in (${ids.join(", ")})` : "", quotes.length ? `quote_id in (${quotes.join(", ")})` : ""].filter(Boolean);
  if (!where.length) throw new Error(`${card}: localCleanupDeleteIssuedInvoice needs invoiceIds or quoteIds (the fixed ids this spec planted)`);
  /* before / after are the spec's OWN fixed-id statements; they share the transaction, so they must not touch invoices. */
  for (const extra of [opts.before, opts.after]) {
    if (extra && /\binvoices\b/i.test(extra.replace(/\binvoice_id\b/gi, ""))) {
      throw new Error(`${card}: before/after must not touch public.invoices — pass invoiceIds/quoteIds instead`);
    }
  }
  db.psql(`
begin;
set local app.invoice_amend_reason = '${card} card test cleanup (local test invoice)';
${opts.before ?? ""}
delete from public.invoices where (${where.join(" or ")}) and tenant_id = ${E2E_TENANT_SQL};
${opts.after ?? ""}
commit;`);
}

/**
 * Wait until a client page is HYDRATED and its stored data is on screen, before typing. `ready` = an element that shows
 * only once the saved value has loaded ("Not set" / the stored month, the statement heading, a loaded row).
 * 9 Nov: a P&L From typed during hydration was lost (reversed range → "didn't load"); "GST returns filed up to" typed
 * before the stored month loaded was wiped by the re-render and Save stayed disabled.
 */
export async function waitForHydrated(page: Page, ready: Locator, opts: { timeout?: number; idleMs?: number } = {}): Promise<void> {
  await expect(page).not.toHaveURL(/\/login/);
  await expect(ready.first()).toBeVisible({ timeout: opts.timeout ?? 90_000 });
  // Capped: polling pages never go idle, and `ready` already proved the data is there.
  await page.waitForLoadState("networkidle", { timeout: opts.idleMs ?? 15_000 }).catch(() => { /* polling page */ });
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
}

/**
 * Fill an input and prove it KEPT the value. A late re-render (hydration, a query landing, an auto-fetch) that wipes it
 * is typed again instead of failing three steps later with a confusing message. `expected` defaults to `value`
 * (a number box normalises "95.10" → "95.1").
 */
export async function fillKept(input: Locator, value: string, expected: string = value, timeout = 30_000): Promise<void> {
  await expect(async () => {
    if ((await input.inputValue()) !== expected) await input.fill(value);
    await expect(input).toHaveValue(expected, { timeout: 1_500 });
    await input.page().waitForTimeout(300); // still there a moment later = not wiped by a re-render
    await expect(input).toHaveValue(expected, { timeout: 500 });
  }).toPass({ timeout });
}

/**
 * Accounting → Overview → "GST returns filed up to" → <month> → Save → confirm (step 1 of R-2621 / R-2627 / R-2631 /
 * R-2642). Waits for the stored value ("Not set" or a saved month) BEFORE typing, keeps the typed month, waits for Save
 * to enable. `month` = "2026-09"; `monthName` = "September 2026" (what the card says once saved). The spec clears the
 * setting in beforeAll: a month that is ALREADY saved fails here (Save would stay disabled and the step would prove
 * nothing) — it never passes without pressing Save.
 */
export async function setGstFiledThrough(page: Page, month: string, monthName: string): Promise<void> {
  await openAppPage(page, "/accounting");
  const card = page.getByTestId("gst-filed-through-card");
  const text = page.getByTestId("gst-filed-through-text");
  await waitForHydrated(page, text.filter({ hasText: /Not set|GST returns are filed up to/ }));
  await expect(text, `"GST returns filed up to" must not already be ${monthName} — clear it in beforeAll`).not.toContainText(`filed up to ${monthName}`);
  await fillKept(card.getByLabel("GST returns filed up to (month)"), month);
  const save = card.getByRole("button", { name: "Save" });
  await expect(save).toBeEnabled({ timeout: 30_000 });
  await save.click();
  await page.getByRole("dialog", { name: `GST returns filed up to ${monthName}?` }).getByRole("button", { name: "Save" }).click(); // the confirm
  await expect(text).toContainText(`GST returns are filed up to ${monthName}`, { timeout: 60_000 });
}

/**
 * Open a panel that starts collapsed (e.g. /invoices "Pending GST invoice generation") and wait for its content.
 * `name` = the clickable header's text (a button or role=button); `content` = something only the OPEN panel shows.
 * Already open → nothing is clicked. A toggle with aria-expanded is trusted: it is clicked again only while it still
 * says "false" (a click before hydration does nothing). Without aria-expanded nobody can tell "closed" from "open, rows
 * still loading", so it is clicked ONCE and the content gets the whole timeout (a second click would close it).
 */
export async function openCollapsedPanel(page: Page, name: string | RegExp, content: Locator, timeout = 60_000): Promise<void> {
  const toggle = page.getByRole("button", { name }).first();
  await expect(toggle).toBeVisible({ timeout });
  if (await content.first().isVisible()) return;
  if ((await toggle.getAttribute("aria-expanded")) === null) {
    await toggle.click();
    await expect(content.first()).toBeVisible({ timeout });
    return;
  }
  await expect(async () => {
    if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 });
  }).toPass({ timeout });
  await expect(content.first()).toBeVisible({ timeout });
}

/**
 * USD (foreign-currency) quote: picking the currency fetches the "Latest" exchange rate on its own. A rate typed before
 * that fetch lands is overwritten later (R-2638 / R-2644) — wait for it, then fillKept the rate. Resolves once the rate
 * box holds a real rate (not empty / 0 / 1 / 1.00) that has stayed the same for 2 s, or after `timeout` when the rate
 * service is off on localhost (then nothing will overwrite the typed rate).
 */
export async function waitForAutoRateFetch(page: Page, rate: Locator = page.locator("#billingRate"), timeout = 20_000): Promise<void> {
  await expect(rate).toBeVisible({ timeout: 60_000 });
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => { /* polling page */ });
  await expect(async () => {
    const v = await rate.inputValue();
    expect(v, "exchange rate still the placeholder").not.toMatch(/^(|0+(\.0*)?|1(\.0*)?)$/);
    await page.waitForTimeout(2_000);
    expect(await rate.inputValue(), "exchange rate still changing").toBe(v);
  }).toPass({ timeout }).catch(() => { /* no rate service on this localhost: the typed rate stays */ });
}

/**
 * Strict-mode-safe: assert the locator matches exactly ONE element and return it. Scope first (a dialog, `main`, a row,
 * a testid card), then onlyOne — instead of `.first()` on a page-wide getByText, which hides that the text is ALSO a
 * sort header, a toast or the page title (R-2562, R-2625: the test read the wrong element).
 */
export async function onlyOne(locator: Locator, what = "the element", timeout = 60_000): Promise<Locator> {
  await expect(locator, `${what}: exactly one on the page`).toHaveCount(1, { timeout });
  return locator;
}
