#!/usr/bin/env node
/**
 * Smoke check after a staging train — R-1722 (24 Oct 2026).
 *
 * Why: 21 Oct a change passed on localhost and broke only on staging (gateway, DB login,
 * catalog cache). Finding that meant opening pages by hand, and a hand fetch without a
 * login token rang the wrong bell (401 for everything). This opens the real pages in a
 * real browser, logged in, and counts what went wrong on each.
 *
 *   npm run smoke -- http://localhost:3001                   local (E2E seed owner from .env.test)
 *   SMOKE_EMAIL=… SMOKE_PASSWORD=… npm run smoke -- <staging url>   after the train (manager)
 *
 * Options: --only dashboard,quotes   --extra /some/path   --mock-500 /customers (proves red)
 *          --json (rows as JSON on stdout after the table)   --headed (watch it)
 *
 * Steps: GET /api/version → print sha. Log in through the /login form. Open each page in
 * SMOKE_PAGES (detail pages: first matching link on the list page). Per page: HTTP status of
 * the document, console errors + uncaught page errors, same-origin requests that failed or
 * came back 4xx/5xx, and an error boundary / "didn't load" text. Table; exit 1 on any red.
 *
 * READ-ONLY: it only navigates (GET) and reads links. It never clicks a button, never fills a
 * form other than /login. Credentials come only from env and are never printed.
 * Exit 0 = all green. 1 = a page is red. 2 = could not run (no login, version unreachable…).
 * Run from production/.
 */
import fs from "node:fs";
import { chromium } from "@playwright/test";
import {
  SMOKE_PAGES, parseArgs, resolveCreds, isLocalBase, isCountedRequest, isRealFailure,
  isNoiseConsole, findErrorState, redReasons, formatReport,
} from "./smoke-check-lib.mjs";

const HELP = `node scripts/ops/smoke-check.mjs <base-url> [--only a,b] [--extra /path] [--mock-500 /path] [--json] [--headed]
Login: SMOKE_EMAIL + SMOKE_PASSWORD (env). On localhost only, falls back to E2E_OWNER_PASSWORD (.env.test).`;

/** .env.test (local seed logins) — read only for a localhost run; values never printed. */
function loadEnvTest() {
  if (!fs.existsSync(".env.test")) return;
  for (const line of fs.readFileSync(".env.test", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

async function readVersion(base) {
  const res = await fetch(`${base}/api/version`, { headers: { "cache-control": "no-store" } });
  if (!res.ok) throw new Error(`/api/version → HTTP ${res.status}`);
  return (await res.json())?.sha ?? "?";
}

async function login(page, base, creds) {
  // Before React hydrates, the bare <form> submits as a GET with the password in the URL (seen
  // 24 Oct on a cold dev server). Wait for hydration, and block any such request outright.
  await page.route((u) => new URL(u).searchParams.has("password"), (route) => route.abort());
  await page.goto(`${base}/login`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await page.fill("#email", creds.email);
  await page.fill("#password", creds.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((u) => !new URL(u).pathname.startsWith("/login"), { timeout: 60_000 });
}

/** Open one path and count what went wrong. */
async function checkPage(page, base, name, path) {
  const row = { name, path, status: null, finalPath: null, consoleErrors: [], badRequests: [], errorState: null, note: null };
  const onConsole = (m) => { if (m.type() === "error" && !isNoiseConsole(m.text())) row.consoleErrors.push(m.text()); };
  const onPageError = (e) => row.consoleErrors.push(`uncaught: ${e.message}`);
  const onResponse = (r) => {
    if (!isCountedRequest(r.url(), base) || r.status() < 400) return;
    row.badRequests.push({ status: r.status(), method: r.request().method(), path: new URL(r.url()).pathname + new URL(r.url()).search });
  };
  const onFailed = (q) => {
    if (!isCountedRequest(q.url(), base) || !isRealFailure(q.failure()?.errorText)) return;
    row.badRequests.push({ status: null, method: q.method(), path: new URL(q.url()).pathname, error: q.failure()?.errorText });
  };
  page.on("console", onConsole); page.on("pageerror", onPageError);
  page.on("response", onResponse); page.on("requestfailed", onFailed);
  try {
    const res = await page.goto(base + path, { waitUntil: "load", timeout: 120_000 });
    row.status = res?.status() ?? null;
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
    row.finalPath = new URL(page.url()).pathname;
    row.errorState = findErrorState(await page.locator("body").innerText({ timeout: 10_000 }).catch(() => ""));
  } catch (e) {
    row.note = `could not open: ${String(e.message).split("\n")[0]}`;
  } finally {
    page.off("console", onConsole); page.off("pageerror", onPageError);
    page.off("response", onResponse); page.off("requestfailed", onFailed);
  }
  // The document's own 4xx/5xx is already the HTTP column — don't count it twice.
  row.badRequests = row.badRequests.filter((b) => !(b.method === "GET" && b.path === path && b.status === row.status));
  return row;
}

/** First link on the list page whose path matches (a detail page without a hardcoded id). */
async function findDetailPath(page, base, from, re) {
  await page.goto(base + from, { waitUntil: "load", timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => {});
  // Lists fill in after the first paint — look again for up to ~20 s before calling it empty.
  for (let i = 0; i < 20; i++) {
    const hrefs = await page.$$eval("a[href]", (as) => as.map((a) => a.getAttribute("href")));
    for (const h of hrefs) {
      try { const p = new URL(h, base).pathname; if (re.test(p)) return p; } catch {}
    }
    await page.waitForTimeout(1000);
  }
  return null;
}

async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(`✗ ${e.message}\n${HELP}`); process.exit(2); }
  if (opts.help) { console.log(HELP); return; }
  const base = opts.base;
  if (isLocalBase(base)) loadEnvTest();
  const creds = resolveCreds(process.env, base);
  if (creds.missing) {
    console.error(`✗ Login nahi mila: ${creds.missing.join(", ")} env me daalo (password kabhi chat/commit me nahi).`);
    process.exit(2);
  }

  let sha;
  try { sha = await readVersion(base); } catch (e) { console.error(`✗ ${base}/api/version: ${e.message}`); process.exit(2); }
  console.log(`${base} → version ${sha}  (login: ${creds.source})`);

  const browser = await chromium.launch({ headless: !opts.headed });
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // --mock-500: the server never sees it — the browser gets a fake 500 for that path. Only to
  // prove the check goes red; it changes nothing on the server.
  for (const p of opts.mock500) {
    await context.route((u) => new URL(u).pathname === p, (route) =>
      route.fulfill({ status: 500, contentType: "text/html", body: "<h1>Mock 500 (smoke --mock-500)</h1>" }));
  }
  const page = await context.newPage();
  const rows = [];
  try {
    try { await login(page, base, creds); } catch (e) {
      const shown = await page.locator('[role="alert"]').allInnerTexts().catch(() => []);
      console.error(`✗ Login fail: ${String(e.message).split("\n")[0]} (page: ${new URL(page.url()).pathname}${shown.length ? `; it says: ${shown.join(" | ").slice(0, 200)}` : ""})`);
      await browser.close(); process.exit(2);
    }
    const pages = [...SMOKE_PAGES, ...opts.extra.map((p) => ({ name: p.slice(0, 14), path: p }))]
      .filter((p) => !opts.only || opts.only.some((o) => p.name.toLowerCase().includes(o) || (p.path ?? p.from).includes(o)));
    for (const p of pages) {
      let path = p.path;
      if (!path) {
        path = await findDetailPath(page, base, p.from, p.link).catch(() => null);
        if (!path) { rows.push({ name: p.name, path: null, skipped: `no record linked on ${p.from}` }); console.log(`– ${p.name} (skip)`); continue; }
      }
      const row = await checkPage(page, base, p.name, path);
      rows.push(row);
      process.stdout.write(`${redReasons(row).length ? "✗" : "✓"} ${p.name}\n`);
    }
  } finally {
    await browser.close();
  }
  console.log("\n" + formatReport(rows, { sha, base }));
  if (opts.json) console.log(JSON.stringify({ base, sha, rows }, null, 2));
  process.exit(rows.some((r) => redReasons(r).length) ? 1 : 0);
}

main().catch((e) => { console.error(`✗ ${e.stack || e.message}`); process.exit(2); });
