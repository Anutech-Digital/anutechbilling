#!/usr/bin/env node
/**
 * Night IST check — R-1826 (24 Oct 2026).
 *
 * Why: R-1653, R-1716 and R-1816 only showed for records made between 00:00 and 05:30 IST,
 * when the UTC day (CURRENT_DATE on Cloud SQL, toISOString on Cloud Run) is still yesterday.
 * The tests fake that hour; this is the real thing — a GitHub Actions run at 01:00 IST
 * (.github/workflows/night-ist-check.yml, cron "30 19 * * *") against STAGING.
 *
 *   node scripts/ops/night-ist-check.mjs http://localhost:3001             local (E2E seed owner from .env.test)
 *   SMOKE_EMAIL=… SMOKE_PASSWORD=… node scripts/ops/night-ist-check.mjs <staging url>
 *
 * Steps: log in through /login (same as smoke-check, R-1722). Take the PostgREST address and
 * token from a request the app itself makes. Read the logged-in user's tenant and REFUSE
 * anything but E2E Test Co (f588b89d-…). Insert ONE draft quote with no created_date, so the
 * database default stamps it, notes "NIGHT-IST-CHECK <IST date> (<UTC instant>)". Read
 * created_date back; it must be today's IST date. Delete the draft (if delete is refused, mark
 * it expired). No invoice, payment or GST document — those take real numbers. The draft's id
 * is NIGHT-IST-<UTC stamp>, so the quote number series is not touched either.
 *
 * Host allow-list: localhost, or a host with "staging" in its name — never live.
 * Credentials come only from env (SMOKE_EMAIL / SMOKE_PASSWORD; on localhost the .env.test
 * seed owner) and are never printed.
 * Exit 0 = right date. 1 = WRONG date (the bug is back). 2 = could not run.
 * Run from production/.
 */
import fs from "node:fs";
import { chromium } from "@playwright/test";
import { resolveCreds } from "./smoke-check-lib.mjs";
import {
  E2E_TENANT_ID, refuseBase, refuseTenant, isLocal, judge, nightMarker, nightQuoteId, restFromRequest, istDateOf, utcDateOf,
} from "./night-ist-check-lib.mjs";

const HELP = `node scripts/ops/night-ist-check.mjs <base-url> [--headed]
Login: SMOKE_EMAIL + SMOKE_PASSWORD (env). On localhost only, falls back to E2E_OWNER_PASSWORD (.env.test).`;

function fail(code, msg) { console.error(`✗ ${msg}`); process.exit(code); }

/** .env.test (local seed logins) — read only for a localhost run; values never printed. */
function loadEnvTest() {
  if (!fs.existsSync(".env.test")) return;
  for (const line of fs.readFileSync(".env.test", "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    if (!process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, "");
  }
}

/** Same login as smoke-check.mjs: wait for hydration, never let the password reach a URL. */
async function login(page, base, creds) {
  await page.route((u) => new URL(u).searchParams.has("password"), (route) => route.abort());
  await page.goto(`${base}/login`, { waitUntil: "load", timeout: 120_000 });
  await page.waitForLoadState("networkidle", { timeout: 60_000 }).catch(() => {});
  await page.fill("#email", creds.email);
  await page.fill("#password", creds.password);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForURL((u) => !new URL(u).pathname.startsWith("/login"), { timeout: 60_000 });
}

/** PostgREST call with the app's own token, through the logged-in browser context. */
async function rest(ctx, api, method, path, body) {
  const res = await ctx.request.fetch(api.base + path, {
    method,
    headers: { ...api.headers, "content-type": "application/json", prefer: "return=representation", "cache-control": "no-store" },
    data: body === undefined ? undefined : JSON.stringify(body),
    failOnStatusCode: false,
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status(), json };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) { console.log(HELP); return; }
  const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
  if (!base) fail(2, `base URL missing\n${HELP}`);
  const refused = refuseBase(base);
  if (refused) fail(2, refused);
  if (isLocal(base)) loadEnvTest();
  const creds = resolveCreds(process.env, base);
  if (creds.missing) fail(2, `login missing: put ${creds.missing.join(", ")} in env (never in chat or a commit).`);

  const startedAt = Date.now();
  console.log(`${base}  ·  IST ${istDateOf(startedAt)}  ·  UTC ${utcDateOf(startedAt)}  ·  login: ${creds.source}`);

  const browser = await chromium.launch({ headless: !args.includes("--headed") });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  let api = null;
  page.on("request", (r) => { if (!api && r.url().includes("/rest/v1/")) { const a = restFromRequest(r.url(), r.headers()); if (a?.headers.authorization) api = a; } });

  let code = 2;
  let quoteId = null;
  try {
    try { await login(page, base, creds); } catch (e) { throw new Error(`login failed: ${String(e.message).split("\n")[0]}`); }
    await page.goto(`${base}/quotes`, { waitUntil: "load", timeout: 120_000 });
    for (let i = 0; i < 30 && !api; i++) await page.waitForTimeout(1000);
    if (!api) throw new Error("no database request seen on /quotes — cannot reach the data API");

    // ── Tenant guard: E2E Test Co only, checked BEFORE any write ──
    const who = await rest(ctx, api, "GET", `users?select=tenant_id&email=eq.${encodeURIComponent(creds.email)}&limit=1`);
    const tenantId = Array.isArray(who.json) ? who.json[0]?.tenant_id : null;
    const no = refuseTenant(tenantId);
    if (no) throw new Error(no);
    console.log(`tenant ${tenantId} = E2E Test Co ✓`);

    // ── One draft quote; created_date left to the database default ──
    const before = Date.now();
    quoteId = nightQuoteId(before);
    const ins = await rest(ctx, api, "POST", "quotes?select=id,created_date,tenant_id", {
      id: quoteId, tenant_id: E2E_TENANT_ID, customer_name: "NIGHT-IST-CHECK", status: "draft",
      notes: nightMarker(before), line_items: [], amount: 0, subtotal: 0, tax_rate: 0,
    });
    if (ins.status >= 300) { quoteId = null; throw new Error(`draft insert refused: HTTP ${ins.status} ${JSON.stringify(ins.json).slice(0, 200)}`); }

    // ── Read it back (a fresh GET, not the insert's echo) ──
    const back = await rest(ctx, api, "GET", `quotes?select=id,created_date,notes&id=eq.${encodeURIComponent(quoteId)}`);
    const after = Date.now();
    const row = Array.isArray(back.json) ? back.json[0] : null;
    if (!row) throw new Error(`draft ${quoteId} not found on read-back (HTTP ${back.status})`);
    const v = judge(row.created_date, before, after);
    console.log(`${quoteId}: created_date ${v.got} · IST today ${v.expected} · UTC day ${v.utcDay}${v.night ? " · NIGHT WINDOW (00:00–05:30 IST)" : " · daytime (IST and UTC agree)"}`);
    code = v.ok ? 0 : 1;
    console.log(v.ok ? "✓ PASS: the record got today's IST date" : `✗ FAIL: the record got ${v.got}, today in IST is ${v.expected} — a date default is on the UTC day again`);
  } catch (e) {
    console.error(`✗ ${e.message}`);
    code = 2;
  } finally {
    if (quoteId && api) {
      const del = await rest(ctx, api, "DELETE", `quotes?id=eq.${encodeURIComponent(quoteId)}`).catch(() => ({ status: 0, json: null }));
      if (del.status < 300 && Array.isArray(del.json) && del.json.length === 1) console.log(`draft ${quoteId} deleted`);
      else {
        const upd = await rest(ctx, api, "PATCH", `quotes?id=eq.${encodeURIComponent(quoteId)}`, { status: "expired", notes: `${nightMarker(Date.now())} — delete refused (HTTP ${del.status}), left expired` }).catch(() => ({ status: 0 }));
        console.log(upd.status < 300 ? `draft ${quoteId} could not be deleted (HTTP ${del.status}) — marked expired` : `⚠ draft ${quoteId} left behind (delete HTTP ${del.status}, update HTTP ${upd.status}) — remove it by hand`);
      }
    }
    await browser.close();
  }
  process.exit(code);
}

main().catch((e) => fail(2, String(e?.message ?? e)));
