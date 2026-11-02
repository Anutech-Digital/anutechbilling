import path from "node:path";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  parseArgs,
  checkBuildSha,
  checkMigrationsHealth,
  checkBuyPage,
  checkLogin,
  checkConsent,
  fetchWithRetry,
  runSmoke,
  summaryLine,
  formatResult,
  // @ts-expect-error — plain .mjs ops script, no types
} from "../../scripts/ops/staging-smoke.mjs";

/* R-2035 (1 Nov 2026): after a train, staging was checked by hand (old page showing until the
   build finished, buy page brand/prices) — slow and costs usage. staging-smoke.mjs does it in one
   READ-ONLY command: build sha, migrations health, buy page brand + prices, /login, consent route. */

const BASE = "https://staging.example.test";
const SHA = "abcdef1234567890abcdef1234567890abcdef12";

type Reply = { status: number; body?: unknown; text?: string; headers?: Record<string, string> };
type Call = { url: string; method: string; headers: Record<string, string> };

function res(r: Reply): Response {
  const text = r.text ?? (r.body === undefined ? "" : JSON.stringify(r.body));
  return new Response(r.status === 204 ? null : text, { status: r.status, headers: r.headers });
}

/** A mocked fetch: route by "METHOD /path" → reply (or a function of the call count). Records every call. */
function mockFetch(routes: Record<string, Reply | ((n: number) => Reply | Error)>) {
  const calls: Call[] = [];
  const count: Record<string, number> = {};
  const fn = async (url: string, init: RequestInit = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const key = `${method} ${new URL(url).pathname}`;
    calls.push({ url, method, headers: Object.fromEntries(new Headers(init.headers).entries()) });
    count[key] = (count[key] ?? 0) + 1;
    const r = routes[key];
    if (!r) return res({ status: 404, text: "not found" });
    const v = typeof r === "function" ? r(count[key]) : r;
    if (v instanceof Error) throw v;
    return res(v);
  };
  return { fn, calls };
}

const CATALOG = {
  items: [
    { id: "1", name: "Google Workspace Business Starter", msrp: 1680, prices: { annual: { msrp: 1680 }, monthly: { msrp: 175 } } },
    { id: "2", name: "Google Workspace Business Standard", msrp: 9960, prices: { annual: { msrp: 9960 } } },
    { id: "3", name: "Google Workspace Business Plus", msrp: 0, prices: {} },
  ],
};
const BRAND = { brand: { name: "Acme & Co Pvt Ltd" } };
const BUY_HTML = `<html><head><title>Buy Google Workspace · Acme &amp; Co Pvt Ltd</title></head><body>
<script>self.__next_f.push([1,"{\\"name\\":\\"Google Workspace Business Starter\\",\\"msrp\\":1680,\\"prices\\":{\\"annual\\":{\\"msrp\\":1680},\\"monthly\\":{\\"msrp\\":175}}},{\\"msrp\\":9960}"])</script>
</body></html>`;

function greenRoutes(over: Record<string, Reply | ((n: number) => Reply | Error)> = {}) {
  return {
    "GET /api/version": { status: 200, body: { sha: SHA.slice(0, 7), buildId: "b1" } },
    "GET /api/health/migrations": { status: 200, body: { ok: true, missing: [] } },
    "GET /api/public/brand": { status: 200, body: BRAND },
    "GET /api/public/catalog/buy-workspace": { status: 200, body: CATALOG },
    "GET /buy/workspace": { status: 200, text: BUY_HTML },
    "GET /login": { status: 200, text: "<html>login</html>" },
    "OPTIONS /api/public/consent": { status: 204, headers: { allow: "OPTIONS, POST" } },
    ...over,
  };
}

const noSleep = async () => {};
const token = { env: { MIGRATIONS_HEALTH_TOKEN: "t" }, readFile: () => null };

describe("parseArgs", () => {
  it("defaults to the staging URL the other ops scripts use, no expected sha, 10 min sha wait", () => {
    const o = parseArgs([]);
    expect(o.base).toBe("https://resellersos-staging-njvk4nxhdq-as.a.run.app");
    expect(o.expectSha).toBeNull();
    expect(o.shaWaitMin).toBe(10);
  });
  it("takes --base, --expect-sha, --brand, --sha-wait-min", () => {
    const o = parseArgs(["--base", "http://localhost:3001/", "--expect-sha", "ABCDEF1", "--brand", "Acme", "--sha-wait-min", "2"]);
    expect(o).toMatchObject({ base: "http://localhost:3001", expectSha: "abcdef1", brand: "Acme", shaWaitMin: 2 });
  });
  it("refuses a bad sha, a bad URL and unknown flags", () => {
    expect(() => parseArgs(["--expect-sha", "xyz"])).toThrow();
    expect(() => parseArgs(["--base", "staging"])).toThrow();
    expect(() => parseArgs(["--post"])).toThrow();
  });
});

describe("fetchWithRetry", () => {
  it("retries a network error and a 5xx, then returns the good answer", async () => {
    const m = mockFetch({ "GET /x": (n) => (n === 1 ? new Error("ECONNRESET") : n === 2 ? { status: 503 } : { status: 200, text: "ok" }) });
    const r = await fetchWithRetry(`${BASE}/x`, {}, { fetchFn: m.fn, sleep: noSleep, tries: 3 });
    expect(r.status).toBe(200);
    expect(m.calls).toHaveLength(3);
  });
  it("gives back the last 5xx after the tries run out (never throws for an HTTP status)", async () => {
    const m = mockFetch({ "GET /x": { status: 503 } });
    const r = await fetchWithRetry(`${BASE}/x`, {}, { fetchFn: m.fn, sleep: noSleep, tries: 2 });
    expect(r.status).toBe(503);
    expect(m.calls).toHaveLength(2);
  });
  it("does not retry a 4xx", async () => {
    const m = mockFetch({});
    const r = await fetchWithRetry(`${BASE}/x`, {}, { fetchFn: m.fn, sleep: noSleep, tries: 3 });
    expect(r.status).toBe(404);
    expect(m.calls).toHaveLength(1);
  });
});

describe("checkBuildSha", () => {
  it("green when /api/version shows the expected commit (7-char compare)", async () => {
    const m = mockFetch(greenRoutes());
    const r = await checkBuildSha({ base: BASE, expectSha: SHA, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("abcdef1");
  });
  it("waits for a still-starting revision: old sha twice, then the new one", async () => {
    const m = mockFetch({
      "GET /api/version": (n) => (n < 3 ? { status: 200, body: { sha: "1111111" } } : { status: 200, body: { sha: "abcdef1" } }),
    });
    const r = await checkBuildSha({ base: BASE, expectSha: SHA, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(m.calls.length).toBe(3);
  });
  it("red after the wait when the old build is still served", async () => {
    let t = 0;
    const m = mockFetch({ "GET /api/version": { status: 200, body: { sha: "1111111" } } });
    const r = await checkBuildSha({
      base: BASE, expectSha: SHA, fetchFn: m.fn, sleep: async (ms: number) => { t += ms; }, now: () => t, timeoutMs: 10 * 60_000,
    });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("1111111");
    expect(t).toBeGreaterThanOrEqual(10 * 60_000);
  });
  it("without --expect-sha it only reports the served sha (green when reachable)", async () => {
    const m = mockFetch(greenRoutes());
    const r = await checkBuildSha({ base: BASE, expectSha: null, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("abcdef1");
  });
});

describe("checkMigrationsHealth (reuses migrations-health-check.mjs)", () => {
  it("green when the app says every migration is on its DB, with the bearer token", async () => {
    const m = mockFetch(greenRoutes());
    const r = await checkMigrationsHealth({ base: BASE, fetchFn: m.fn, ...token });
    expect(r.ok).toBe(true);
    expect(m.calls[0].headers.authorization).toBe("Bearer t");
  });
  it("red when migrations are missing, and names them", async () => {
    const m = mockFetch(greenRoutes({ "GET /api/health/migrations": { status: 200, body: { ok: false, missing: ["20261101000000_x"] } } }));
    const r = await checkMigrationsHealth({ base: BASE, fetchFn: m.fn, ...token });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("20261101000000_x");
  });
  it("no token on this computer → a warning, not red, and no call made", async () => {
    const m = mockFetch(greenRoutes());
    const r = await checkMigrationsHealth({ base: BASE, fetchFn: m.fn, env: {}, readFile: () => null });
    expect(r.ok).toBe(true);
    expect(r.warn).toBe(true);
    expect(m.calls).toHaveLength(0);
  });
  it("red when the app cannot read its DB (HTTP 500)", async () => {
    const m = mockFetch(greenRoutes({ "GET /api/health/migrations": { status: 500, body: {} } }));
    const r = await checkMigrationsHealth({ base: BASE, fetchFn: m.fn, ...token, sleep: noSleep });
    expect(r.ok).toBe(false);
  });
});

describe("checkBuyPage", () => {
  it("green: page 200, brand name in it (HTML-escaped), every catalogue price in it", async () => {
    const m = mockFetch(greenRoutes());
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("Acme & Co Pvt Ltd");
  });
  it("red when the catalogue endpoint answers 503 (price list unknown)", async () => {
    const m = mockFetch(greenRoutes({ "GET /api/public/catalog/buy-workspace": { status: 503, body: { items: null } } }));
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("503");
  });
  it("red when the catalogue has no priced plan", async () => {
    const m = mockFetch(greenRoutes({ "GET /api/public/catalog/buy-workspace": { status: 200, body: { items: [] } } }));
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(false);
  });
  it("red when the page does not carry the brand name (neutral header)", async () => {
    const m = mockFetch(greenRoutes({ "GET /buy/workspace": { status: 200, text: BUY_HTML.replace(/Acme &amp; Co Pvt Ltd/g, "") } }));
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/brand/i);
  });
  it("red when a catalogue price is missing from the page", async () => {
    const m = mockFetch(greenRoutes({ "GET /buy/workspace": { status: 200, text: BUY_HTML.replace(/9960/g, "") } }));
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("9960");
  });
  it("--brand overrides the brand read from /api/public/brand", async () => {
    const m = mockFetch(greenRoutes());
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep, brand: "Someone Else" });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Someone Else");
  });
  it("red when the brand endpoint gives no brand and none was given", async () => {
    const m = mockFetch(greenRoutes({ "GET /api/public/brand": { status: 200, body: { brand: null } } }));
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(false);
  });
  it("red when the page itself is 500", async () => {
    const m = mockFetch(greenRoutes({ "GET /buy/workspace": { status: 500, text: "err" } }));
    const r = await checkBuyPage({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("500");
  });
});

describe("checkLogin", () => {
  it("green on 200, red otherwise", async () => {
    expect((await checkLogin({ base: BASE, fetchFn: mockFetch(greenRoutes()).fn, sleep: noSleep })).ok).toBe(true);
    const red = await checkLogin({ base: BASE, fetchFn: mockFetch(greenRoutes({ "GET /login": { status: 502 } })).fn, sleep: noSleep });
    expect(red.ok).toBe(false);
    expect(red.detail).toContain("502");
  });
});

describe("checkConsent — OPTIONS only, never POST (a POST would create a consent record)", () => {
  it("green when OPTIONS answers 2xx and allows POST", async () => {
    const m = mockFetch(greenRoutes());
    const r = await checkConsent({ base: BASE, fetchFn: m.fn, sleep: noSleep });
    expect(r.ok).toBe(true);
    expect(m.calls.map((c) => c.method)).toEqual(["OPTIONS"]);
  });
  it("green on a 2xx with no Allow header", async () => {
    const m = mockFetch(greenRoutes({ "OPTIONS /api/public/consent": { status: 204 } }));
    expect((await checkConsent({ base: BASE, fetchFn: m.fn, sleep: noSleep })).ok).toBe(true);
  });
  it("red when the route is gone (404) or its Allow header lacks POST", async () => {
    expect((await checkConsent({ base: BASE, fetchFn: mockFetch({}).fn, sleep: noSleep })).ok).toBe(false);
    const m = mockFetch(greenRoutes({ "OPTIONS /api/public/consent": { status: 204, headers: { allow: "OPTIONS, GET" } } }));
    expect((await checkConsent({ base: BASE, fetchFn: m.fn, sleep: noSleep })).ok).toBe(false);
  });
});

describe("runSmoke", () => {
  it("all green → 'SMOKE GREEN', exit 0, one line per check", async () => {
    const m = mockFetch(greenRoutes());
    const lines: string[] = [];
    const r = await runSmoke({ base: BASE, expectSha: SHA, fetchFn: m.fn, sleep: noSleep, ...token, log: (l: string) => lines.push(l) });
    expect(r.exitCode).toBe(0);
    expect(r.results.map((x: { name: string }) => x.name)).toEqual(["build sha", "migrations", "buy page", "login", "consent"]);
    expect(lines.filter((l) => /^[✓✗!] /.test(l))).toHaveLength(5);
    expect(lines.at(-1)).toBe("SMOKE GREEN");
  });
  it("red checks → 'SMOKE RED: <names>', exit 1, other checks still run", async () => {
    const m = mockFetch(greenRoutes({ "GET /login": { status: 500 }, "OPTIONS /api/public/consent": { status: 404 } }));
    const lines: string[] = [];
    const r = await runSmoke({ base: BASE, expectSha: SHA, fetchFn: m.fn, sleep: noSleep, ...token, log: (l: string) => lines.push(l) });
    expect(r.exitCode).toBe(1);
    expect(lines.at(-1)).toBe("SMOKE RED: login, consent");
    expect(r.results.find((x: { name: string }) => x.name === "buy page").ok).toBe(true);
  });
  it("READ-ONLY: every request it makes is GET or OPTIONS — never POST/PUT/PATCH/DELETE", async () => {
    const m = mockFetch(greenRoutes());
    await runSmoke({ base: BASE, expectSha: SHA, fetchFn: m.fn, sleep: noSleep, ...token, log: () => {} });
    expect(m.calls.length).toBeGreaterThan(5);
    for (const c of m.calls) expect(["GET", "OPTIONS"]).toContain(c.method);
    expect(m.calls.every((c) => c.url.startsWith(BASE))).toBe(true);
  });
  it("the sha wait runs first, so the other checks see the new build", async () => {
    const m = mockFetch(greenRoutes());
    await runSmoke({ base: BASE, expectSha: SHA, fetchFn: m.fn, sleep: noSleep, ...token, log: () => {} });
    expect(new URL(m.calls[0].url).pathname).toBe("/api/version");
  });
});

describe("summaryLine / formatResult", () => {
  it("formats", () => {
    expect(summaryLine([{ name: "a", ok: true }])).toBe("SMOKE GREEN");
    expect(summaryLine([{ name: "a", ok: false }, { name: "b", ok: false }])).toBe("SMOKE RED: a, b");
    expect(formatResult({ name: "login", ok: true, detail: "HTTP 200" })).toBe("✓ login: HTTP 200");
    expect(formatResult({ name: "login", ok: false, detail: "HTTP 500" })).toBe("✗ login: HTTP 500");
    expect(formatResult({ name: "migrations", ok: true, warn: true, detail: "no token" })).toBe("! migrations: no token");
  });
});

describe("staging-train.mjs hook", () => {
  const src = readFileSync(path.join(__dirname, "../../scripts/ops/staging-train.mjs"), "utf8");
  it("imports runSmoke and runs it only after a real push, with the pushed sha", () => {
    expect(src).toMatch(/import \{[^}]*runSmoke[^}]*\} from "\.\/staging-smoke\.mjs"/);
    const block = src.slice(src.indexOf("if (pushed && pushedSha)"));
    expect(block).toMatch(/runSmoke\(\{[^}]*expectSha: pushedSha/);
    expect(src.match(/runSmoke\(/g)).toHaveLength(1);
  });
});
