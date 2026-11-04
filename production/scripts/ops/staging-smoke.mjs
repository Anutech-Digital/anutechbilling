#!/usr/bin/env node
/**
 * Staging smoke — R-2035 (1 Nov 2026). One READ-ONLY command after a staging train.
 *
 * Why: 27 Oct, after a train, staging was checked by hand — the old page kept showing until the
 * new build finished, then the buy page's brand and prices were opened one by one. Slow, and it
 * cost usage. This asks the same questions in one go and prints one line per check:
 *
 *   1. build sha   — GET /api/version shows --expect-sha (7-char compare, migrations-health-check's
 *                    sameBuild). A still-starting Cloud Run revision is waited for (default 10 min,
 *                    every 30 s). Without --expect-sha it only prints the served sha.
 *   2. migrations  — GET /api/health/migrations with MIGRATIONS_HEALTH_TOKEN (env, or the token file
 *                    of migrations-health-check.mjs — reused, never printed). No token here → "!"
 *                    warning, not red.
 *   3. buy page    — GET /api/public/catalog/buy-workspace is 200 (not 503) with at least one priced
 *                    plan; GET /api/public/brand gives the brand name (or --brand); GET /buy/workspace
 *                    is 200, carries that brand name and every catalogue price (server-rendered).
 *   4. login       — GET /login is 200.
 *   5. consent     — OPTIONS /api/public/consent is 2xx and (if it sends Allow) allows POST.
 *                    NEVER a POST: that would write a consent record.
 * Last line: "SMOKE GREEN" (exit 0) or "SMOKE RED: <checks>" (exit 1). Exit 2 = bad arguments.
 *
 * READ-ONLY: only GET and OPTIONS, only to --base. No login, no form, no DB. Each request has a
 * 30 s timeout; a network error or 5xx is retried (3 tries, 5 s apart) for a cold start.
 *
 * Usage (from production/):
 *   node scripts/ops/staging-smoke.mjs                                   staging, no sha wait
 *   node scripts/ops/staging-smoke.mjs --expect-sha <commit>             wait for that build first
 *   node scripts/ops/staging-smoke.mjs --base http://localhost:3001      another server
 *   options: --brand "<name>"  --sha-wait-min <n> (default 10)
 * staging-train.mjs --push runs it by itself after the push (with the merge commit as --expect-sha).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGING_URL, SHA_LEN, sameBuild, waitForBuild, readToken, checkMigrations, verdict } from "./migrations-health-check.mjs";

export const REQUEST_TIMEOUT_MS = 30_000;
export const TRIES = 3;
export const PAUSE_MS = 5_000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));
const trimBase = (b) => String(b).replace(/\/+$/, "");
const NO_CACHE = { "cache-control": "no-cache" };
/** A desktop browser — /buy/workspace picks its mobile layout from the user agent. */
const DESKTOP_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 staging-smoke";

/** argv (without node + script) → { base, expectSha, brand, shaWaitMin, help }. Throws on a bad argument. */
export function parseArgs(argv) {
  const out = { base: STAGING_URL, expectSha: null, brand: null, shaWaitMin: 10, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { const v = argv[++i]; if (!v) throw new Error(`${a} needs a value`); return v; };
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--base") out.base = next().replace(/\/+$/, "");
    else if (a === "--expect-sha") {
      const v = next();
      if (!/^[0-9a-f]{7,40}$/i.test(v)) throw new Error(`--expect-sha needs a commit (7–40 hex), got ${v}`);
      out.expectSha = v.toLowerCase();
    } else if (a === "--brand") out.brand = next();
    else if (a === "--sha-wait-min") {
      const n = Number(next());
      if (!Number.isFinite(n) || n < 0) throw new Error("--sha-wait-min needs a number of minutes");
      out.shaWaitMin = n;
    } else throw new Error(`Unknown argument ${a} (--base / --expect-sha / --brand / --sha-wait-min / --help)`);
  }
  if (!/^https?:\/\//.test(out.base)) throw new Error(`--base must start with http:// or https:// (got ${out.base})`);
  return out;
}

/**
 * One request with a timeout; a network error or 5xx is tried again (cold start). Gives back the
 * last Response (also a 5xx); throws only when every try was a network error.
 */
export async function fetchWithRetry(url, init = {}, { fetchFn = fetch, sleep = realSleep, tries = TRIES, pauseMs = PAUSE_MS, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  let last = null;
  let lastErr = null;
  for (let i = 1; i <= tries; i++) {
    try {
      last = await fetchFn(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      lastErr = null;
      if (last.status < 500) return last;
    } catch (e) {
      lastErr = e;
    }
    if (i < tries) await sleep(pauseMs);
  }
  if (last) return last;
  throw lastErr ?? new Error("no response");
}

const errText = (e) => (e instanceof Error ? e.message : String(e));
const pass = (name, detail, extra = {}) => ({ name, ok: true, detail, ...extra });
const fail = (name, detail) => ({ name, ok: false, detail });

/** 1. The served build is the expected commit (waits for a still-starting revision). */
export async function checkBuildSha({ base, expectSha, fetchFn = fetch, sleep = realSleep, now = Date.now, timeoutMs = 10 * 60_000, intervalMs = 30_000, log = () => {} }) {
  const name = "build sha";
  if (!expectSha) {
    try {
      const r = await fetchWithRetry(`${trimBase(base)}/api/version`, { headers: NO_CACHE }, { fetchFn, sleep });
      if (!r.ok) return fail(name, `/api/version HTTP ${r.status}`);
      const sha = (await r.json())?.sha ?? "?";
      return pass(name, `serving ${sha} (no --expect-sha given)`);
    } catch (e) {
      return fail(name, `/api/version unreachable (${errText(e)})`);
    }
  }
  const want = expectSha.slice(0, SHA_LEN);
  const w = await waitForBuild({
    base, sha: expectSha, sleep, now, timeoutMs, intervalMs,
    fetchFn: (u, init) => fetchFn(u, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
    onTick: (s) => log(`  build sha: serving ${s ?? "no answer"}, waiting for ${want} …`),
  });
  if (w.arrived && sameBuild(w.lastSha, expectSha)) return pass(name, `serving ${w.lastSha} = ${want}`);
  return fail(name, `still serving ${w.lastSha ?? "no answer"}, expected ${want} (waited ${Math.round(timeoutMs / 60_000)} min)`);
}

/** 2. Every migration the build carries is on its DB (migrations-health-check.mjs, reused). */
export async function checkMigrationsHealth({ base, fetchFn = fetch, sleep = realSleep, env = process.env, readFile }) {
  const name = "migrations";
  const token = readFile ? readToken(env, readFile) : readToken(env);
  if (!token) return pass(name, verdict({ kind: "no-token" }).message, { warn: true });
  const r = await checkMigrations({ base, token, fetchFn: (u, init) => fetchWithRetry(u, init, { fetchFn, sleep }) });
  const v = verdict(r);
  return v.level === "ok" ? pass(name, v.message) : fail(name, v.message);
}

/** HTML text → what a reader sees for the few entities React writes in text and attributes. */
function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Every price > 0 a catalogue answer carries (msrp, annual, monthly), unique. */
export function catalogPrices(items) {
  const set = new Set();
  for (const i of items ?? []) {
    for (const v of [i?.msrp, i?.prices?.annual?.msrp, i?.prices?.monthly?.msrp]) {
      if (typeof v === "number" && Number.isFinite(v) && v > 0) set.add(v);
    }
  }
  return [...set];
}

/** A price is on the page as the raw number (the page's props) or Indian-formatted (shown text). */
function pageHasPrice(html, v) {
  return html.includes(String(v)) || html.includes(v.toLocaleString("en-IN"));
}

/** 3. Buy page: catalogue 200 with prices, brand name and every price on the server-rendered page. */
export async function checkBuyPage({ base, fetchFn = fetch, sleep = realSleep, brand = null, tries = TRIES, pauseMs = PAUSE_MS }) {
  const name = "buy page";
  const b = trimBase(base);
  const opt = { fetchFn, sleep };
  try {
    const cat = await fetchWithRetry(`${b}/api/public/catalog/buy-workspace`, { headers: NO_CACHE }, opt);
    if (cat.status !== 200) return fail(name, `/api/public/catalog/buy-workspace HTTP ${cat.status}${cat.status === 503 ? " (price list unknown)" : ""}`);
    const prices = catalogPrices((await cat.json())?.items);
    if (!prices.length) return fail(name, "catalogue has no priced plan");

    let brandName = brand;
    if (!brandName) {
      const br = await fetchWithRetry(`${b}/api/public/brand`, { headers: NO_CACHE }, opt);
      brandName = br.ok ? (await br.json())?.brand?.name ?? null : null;
      if (!brandName) return fail(name, `/api/public/brand gave no brand name (HTTP ${br.status}) — tenant row or BUY_PAGE_TENANT_ID?`);
    }

    /* The page's own server read may miss on a cold start (it then shows "Loading prices…") — try again. */
    let problem = "";
    for (let i = 1; i <= tries; i++) {
      const page = await fetchWithRetry(`${b}/buy/workspace`, { headers: { ...NO_CACHE, "user-agent": DESKTOP_UA } }, opt);
      if (page.status !== 200) problem = `/buy/workspace HTTP ${page.status}`;
      else {
        const html = decodeEntities(await page.text());
        const missing = prices.filter((v) => !pageHasPrice(html, v));
        if (!html.includes(brandName)) problem = `brand "${brandName}" not on /buy/workspace`;
        else if (missing.length) problem = `prices not on /buy/workspace: ${missing.join(", ")}`;
        else return pass(name, `brand "${brandName}", ${prices.length} price(s) shown, catalogue 200`);
      }
      if (i < tries) await sleep(pauseMs);
    }
    return fail(name, problem);
  } catch (e) {
    return fail(name, `unreachable (${errText(e)})`);
  }
}

/** 4. The login page opens. */
export async function checkLogin({ base, fetchFn = fetch, sleep = realSleep }) {
  try {
    const r = await fetchWithRetry(`${trimBase(base)}/login`, { headers: NO_CACHE }, { fetchFn, sleep });
    return r.status === 200 ? pass("login", "HTTP 200") : fail("login", `HTTP ${r.status}`);
  } catch (e) {
    return fail("login", `unreachable (${errText(e)})`);
  }
}

/** 5. The consent route is there and takes POST — asked with OPTIONS only (a POST writes a record). */
export async function checkConsent({ base, fetchFn = fetch, sleep = realSleep }) {
  const name = "consent";
  try {
    const r = await fetchWithRetry(`${trimBase(base)}/api/public/consent`, { method: "OPTIONS" }, { fetchFn, sleep });
    if (r.status < 200 || r.status >= 300) return fail(name, `OPTIONS /api/public/consent HTTP ${r.status}`);
    const allow = r.headers.get("allow");
    if (allow && !/\bPOST\b/i.test(allow)) return fail(name, `OPTIONS /api/public/consent allows "${allow}", not POST`);
    return pass(name, `OPTIONS ${r.status}${allow ? ` (allow: ${allow})` : ""}`);
  } catch (e) {
    return fail(name, `unreachable (${errText(e)})`);
  }
}

export function formatResult(r) {
  return `${r.ok ? (r.warn ? "!" : "✓") : "✗"} ${r.name}: ${r.detail}`;
}

export function summaryLine(results) {
  const red = results.filter((r) => !r.ok).map((r) => r.name);
  return red.length ? `SMOKE RED: ${red.join(", ")}` : "SMOKE GREEN";
}

/** All five checks, sha first (so the rest see the new build). → { results, exitCode } */
export async function runSmoke({ base = STAGING_URL, expectSha = null, brand = null, shaWaitMin = 10, log = console.log, ...deps }) {
  log(`Staging smoke: ${trimBase(base)}${expectSha ? ` (expect ${expectSha.slice(0, SHA_LEN)})` : ""}`);
  const results = [];
  const run = async (fn) => { const r = await fn; results.push(r); log(formatResult(r)); };
  await run(checkBuildSha({ base, expectSha, timeoutMs: shaWaitMin * 60_000, log, ...deps }));
  await run(checkMigrationsHealth({ base, ...deps }));
  await run(checkBuyPage({ base, brand, ...deps }));
  await run(checkLogin({ base, ...deps }));
  await run(checkConsent({ base, ...deps }));
  const line = summaryLine(results);
  log(line);
  return { results, exitCode: line === "SMOKE GREEN" ? 0 : 1 };
}

async function main(argv) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { console.error(`✗ ${errText(e)}`); process.exit(2); }
  if (opts.help) {
    console.log("node scripts/ops/staging-smoke.mjs [--base <url>] [--expect-sha <commit>] [--brand <name>] [--sha-wait-min <n>]");
    return;
  }
  const { exitCode } = await runSmoke(opts);
  process.exit(exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).catch((e) => { console.error(`✗ ${errText(e)}`); process.exit(2); });
}
