import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
// @ts-expect-error — plain .mjs ops script, no types
import { SMOKE_PAGES, parseArgs, resolveCreds, isLocalBase, isCountedRequest, isRealFailure, findErrorState, redReasons, formatReport } from "../../scripts/ops/smoke-check-lib.mjs";

// R-1722 (24 Oct 2026): after a staging train, open the real pages logged in and count reds.
const root = path.resolve(__dirname, "../..");
const green = { name: "Quotes", path: "/quotes", status: 200, finalPath: "/quotes", consoleErrors: [], badRequests: [], errorState: null, note: null };

describe("smoke check (R-1722)", () => {
  it("covers the pages the owner walks, and each list page exists in the app", () => {
    expect(SMOKE_PAGES.length).toBeGreaterThanOrEqual(15);
    for (const p of SMOKE_PAGES) {
      const route = p.path ?? p.from;
      expect(fs.existsSync(path.join(root, "src/app/(app)", route, "page.tsx")), route).toBe(true);
    }
    expect(SMOKE_PAGES.filter((p: { from?: string }) => p.from).map((p: { name: string }) => p.name)).toEqual(["A customer", "A quote", "An invoice"]);
  });

  it("parses the base URL and options; refuses a bad one", () => {
    expect(parseArgs(["http://localhost:3001/", "--mock-500", "/customers", "--only", "quotes,Leads"]))
      .toMatchObject({ base: "http://localhost:3001", mock500: ["/customers"], only: ["quotes", "leads"] });
    expect(() => parseArgs([])).toThrow(/Base URL missing/);
    expect(() => parseArgs(["staging.example"])).toThrow(/http/);
    expect(() => parseArgs(["http://a", "--nope"])).toThrow(/Unknown/);
    expect(() => parseArgs(["http://a", "--mock-500", "C:/Program Files/Git/customers"])).toThrow(/MSYS_NO_PATHCONV/);
  });

  it("falls back to the E2E seed owner ONLY on localhost", () => {
    const env = { E2E_OWNER_PASSWORD: "x" };
    expect(isLocalBase("http://localhost:3001")).toBe(true);
    expect(isLocalBase("https://resellersos-staging-x.a.run.app")).toBe(false);
    expect(resolveCreds(env, "http://localhost:3001")).toMatchObject({ email: "e2e-owner@example.test", source: "E2E_OWNER (local seed)" });
    expect(resolveCreds(env, "https://staging.example.com")).toEqual({ missing: ["SMOKE_EMAIL", "SMOKE_PASSWORD"] });
    expect(resolveCreds({ SMOKE_EMAIL: "a@b.test", SMOKE_PASSWORD: "y" }, "https://staging.example.com").source).toBe("SMOKE_EMAIL");
  });

  it("counts only same-origin app requests, not dev plumbing or cancelled ones", () => {
    const b = "http://localhost:3001";
    expect(isCountedRequest("http://localhost:3001/api/quotes?x=1", b)).toBe(true);
    expect(isCountedRequest("https://fonts.googleapis.com/x", b)).toBe(false);
    expect(isCountedRequest("http://localhost:3001/_next/webpack-hmr", b)).toBe(false);
    expect(isRealFailure("net::ERR_ABORTED")).toBe(false);
    expect(isRealFailure("net::ERR_CONNECTION_REFUSED")).toBe(true);
  });

  it("spots an error boundary or a didn't-load state", () => {
    expect(findErrorState("We hit a snag loading this page.")).toMatch(/snag/);
    expect(findErrorState("Payments didn’t load. Try again.")).toMatch(/load/);
    expect(findErrorState("Application error: a client-side exception has occurred")).toBeTruthy();
    expect(findErrorState("All quotes · 12 open")).toBeNull();
  });

  it("is red on a 500, a bad request, a console error, an error state or a bounce to /login", () => {
    expect(redReasons(green)).toEqual([]);
    expect(redReasons({ ...green, status: 500 })).toEqual(["HTTP 500"]);
    expect(redReasons({ ...green, badRequests: [{ status: 502, method: "POST", path: "/quotes" }] })).toEqual(["1 bad request(s)"]);
    expect(redReasons({ ...green, consoleErrors: ["boom"] })).toEqual(["1 console error(s)"]);
    expect(redReasons({ ...green, errorState: "didn't load" })[0]).toMatch(/error state/);
    expect(redReasons({ ...green, finalPath: "/login" })).toEqual(["sent to /login (session lost)"]);
    expect(redReasons({ ...green, status: null, note: "could not open: timeout" })).toEqual(["could not open: timeout", "no response"]);
  });

  it("prints a table and lists each red page with its bad requests", () => {
    const out = formatReport([green, { ...green, name: "Customers", path: "/customers", status: 500, badRequests: [{ status: 500, method: "GET", path: "/api/x" }] }], { sha: "abc1234", base: "http://localhost:3001" });
    expect(out).toContain("version abc1234");
    expect(out).toMatch(/✓ {2}Quotes/);
    expect(out).toMatch(/✗ 1 of 2 page laal/);
    expect(out).toContain("500 GET /api/x");
    expect(formatReport([green])).toContain("Sab 1 page hare");
  });

  it("a detail page with nothing to open is a skip, not a green tick or a red", () => {
    const skip = { name: "An invoice", path: null, skipped: "no record linked on /invoices" };
    expect(redReasons(skip)).toEqual([]);
    const out = formatReport([green, skip]);
    expect(out).toMatch(/– {2}An invoice +skip {2}no record linked/);
    expect(out).toContain("Sab 1 page hare");
  });

  it("never lets the password ride in a URL (unhydrated form = GET with ?password=)", () => {
    const src = fs.readFileSync(path.join(root, "scripts/ops/smoke-check.mjs"), "utf8");
    expect(src).toMatch(/searchParams\.has\("password"\), \(route\) => route\.abort\(\)/);
    expect(src.indexOf('searchParams.has("password")')).toBeLessThan(src.indexOf('page.fill("#password"'));
    expect(src).not.toMatch(/console\.(log|error)\([^)]*creds\.password/);
  });

  it("is read-only: the driver never clicks anything except the login submit", () => {
    const src = fs.readFileSync(path.join(root, "scripts/ops/smoke-check.mjs"), "utf8");
    expect(src.match(/\.click\(/g)?.length).toBe(1);
    expect(src).toMatch(/button\[type="submit"\]'\)\.first\(\)\.click\(\)/);
    expect(src).not.toMatch(/\.fill\((?!"#email"|"#password")/);
    expect(src).not.toMatch(/method:\s*["'](POST|PUT|PATCH|DELETE)/);
  });
});
