/**
 * GP-07c (R-2117, G-PERSONAL measure 2) — every API route says whether a FREE personal login can
 * reach it, and a personal route that holds the service role proves it only touches the caller.
 *
 * GP-07b (R-2116) put a /api allowlist in middleware: a personal session may call only
 * PERSONAL_API_PREFIXES (its own money/assets/support routes) and PERSONAL_OPEN_API_PREFIXES
 * (sign-in, public site, webhooks, health, the data gateway); every other /api path is 403 JSON.
 * The allowlist is by PREFIX, so a new route dropped under /api/personal/… or /api/vault/personal/…
 * is open to every free user the moment it is merged. This sibling of role-gate-ratchet.test.ts
 * makes that a reviewed step, never an accident:
 *
 *   • every src/app/api/**\/route.ts lands in exactly one bucket —
 *       personal  under a PERSONAL_API_PREFIX              (a free login reaches it)
 *       open      under a PERSONAL_OPEN_API_PREFIX         (machine / public / app shell)
 *       business  everything else                          (middleware refuses a personal session)
 *     and the bucket agrees with isPersonalApiAllowed(), the function middleware runs;
 *   • a route in the personal bucket must be listed in PERSONAL_API_ROUTES with a reason
 *     (a new one fails here; a stale entry fails too, so the list only says what is true);
 *   • a personal route that calls createAdminClient / reads SUPABASE_SERVICE_ROLE_KEY must show,
 *     in code (comments do not count), BOTH a session read (auth.getUser / auth()) AND a filter
 *     pinned to that session's user (owner_user_id, user_id = who.userId / user.id,
 *     createAdminClientFor(who.userId)) — the service role skips RLS, so this pin IS the wall;
 *   • the app-shell open prefixes (/api/sb, /api/monitoring/sentry-dsn) never hold the service
 *     role — a personal session reaches them and nothing there proves the caller.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PERSONAL_API_PREFIXES,
  PERSONAL_OPEN_API_PREFIXES,
  PERSONAL_API_ROUTES,
  isPersonalApiAllowed,
} from "@/lib/workspace/personal-allowlist";

const API = path.resolve(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

/** Comments out, so a route that only TALKS about a pin does not pass for having one. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const rel = (f: string) => path.relative(API, f).split(path.sep).join("/").replace(/\/route\.ts$/, "");
const urlOf = (route: string) => "/api/" + route;
const under = (p: string, prefix: string) => p === prefix || p.startsWith(prefix + "/");

type Bucket = "personal" | "open" | "business";

function bucketOf(route: string): Bucket {
  const p = urlOf(route);
  if (PERSONAL_API_PREFIXES.some((x) => under(p, x))) return "personal";
  if (PERSONAL_OPEN_API_PREFIXES.some((x) => under(p, x))) return "open";
  return "business";
}

const USES_SERVICE_ROLE = /createAdminClient(For)?\s*\(|SUPABASE_SERVICE_ROLE_KEY/;
const SESSION = /\.auth\.getUser\s*\(|\bauth\s*\(\s*\)/;
const OWNER_PIN = new RegExp([
  String.raw`\bowner_user_id\b`,
  String.raw`\bcreateAdminClientFor\s*\(\s*(who|me|caller)\.userId\b`,
  String.raw`\bcreateAdminClientFor\s*\(\s*user\.id\b`,
  String.raw`["']?\b(p_)?(owner_)?user_id["']?\s*[:,]\s*(who|me|caller)\.userId\b`,
  String.raw`["']?\b(p_)?(owner_)?user_id["']?\s*[:,]\s*(auth\.)?user\.id\b`,
].join("|"));

/** The app-shell open prefixes: reached by a personal SESSION, with nothing else proving the caller. */
const SESSION_SHELL_PREFIXES = ["/api/sb", "/api/monitoring/sentry-dsn"];

const routes = walk(API).map((f) => ({ route: rel(f), src: code(fs.readFileSync(f, "utf8")) }));

describe("personal API classification (GP-07c ratchet)", () => {
  it("every route.ts lands in exactly one bucket, and it matches middleware's isPersonalApiAllowed", () => {
    expect(routes.length).toBeGreaterThan(100);
    const wrong = routes
      .filter((r) => (bucketOf(r.route) !== "business") !== isPersonalApiAllowed(urlOf(r.route)))
      .map((r) => `${r.route} (${bucketOf(r.route)})`);
    expect(wrong, "bucket and middleware disagree:\n  " + wrong.join("\n  ")).toEqual([]);
  });

  it("every route under a personal prefix is listed in PERSONAL_API_ROUTES (a new one is a reviewed step)", () => {
    const unlisted = routes
      .filter((r) => bucketOf(r.route) === "personal" && !(r.route in PERSONAL_API_ROUTES))
      .map((r) => r.route);
    expect(
      unlisted,
      "a route a FREE personal login can call is not listed — add it to PERSONAL_API_ROUTES " +
        "(src/lib/workspace/personal-allowlist.ts) with how it is scoped to the caller:\n  " + unlisted.join("\n  "),
    ).toEqual([]);
  });

  it("every PERSONAL_API_ROUTES entry exists and sits under a personal prefix (stale entries fail)", () => {
    const all = new Set(routes.map((r) => r.route));
    const stale = Object.keys(PERSONAL_API_ROUTES).filter((r) => !all.has(r) || bucketOf(r) !== "personal");
    expect(stale).toEqual([]);
    for (const [r, why] of Object.entries(PERSONAL_API_ROUTES)) expect(why.trim().length, r).toBeGreaterThan(10);
  });

  it("a personal route holding the service role reads the session AND pins every write to that user", () => {
    const open = routes
      .filter((r) => bucketOf(r.route) === "personal" && USES_SERVICE_ROLE.test(r.src))
      .filter((r) => !(SESSION.test(r.src) && OWNER_PIN.test(r.src)))
      .map((r) => r.route);
    expect(
      open,
      "service role in a personal route without a session read + owner_user_id/user_id pin — " +
        "this would hand other people's rows to any free login:\n  " + open.join("\n  "),
    ).toEqual([]);
  });

  it("the app-shell open prefixes (/api/sb, /api/monitoring/sentry-dsn) never hold the service role", () => {
    const bad = routes
      .filter((r) => SESSION_SHELL_PREFIXES.some((x) => under(urlOf(r.route), x)))
      .filter((r) => USES_SERVICE_ROLE.test(r.src))
      .map((r) => r.route);
    expect(bad).toEqual([]);
  });

  it("known routes land where GP-07b put them", () => {
    expect(bucketOf("vault/personal/pin")).toBe("personal");
    expect(bucketOf("dms/sso")).toBe("personal");
    expect(bucketOf("vault")).toBe("business");
    expect(bucketOf("invoices")).toBe("business");
    expect(bucketOf("ai/extract-statement")).toBe("business");
    expect(bucketOf("public/checkout/cart")).toBe("open");
    expect(bucketOf("sb/rest/v1/[...path]")).toBe("open");
  });
});

describe("the ratchet's own checks catch what they claim to", () => {
  const svc = `import { createAdminClient } from "@/lib/supabase/server";
    export async function POST() { const db = createAdminClient(); await db.from("x").delete(); }`;
  it("an admin-client personal route with no session/owner pin is caught", () => {
    expect(USES_SERVICE_ROLE.test(code(svc))).toBe(true);
    expect(SESSION.test(code(svc)) && OWNER_PIN.test(code(svc))).toBe(false);
  });
  it("a pin that lives only in a comment does not count", () => {
    const src = svc + `\n// .eq("owner_user_id", user.id) after supabase.auth.getUser()`;
    expect(SESSION.test(code(src)) && OWNER_PIN.test(code(src))).toBe(false);
  });
  it("a session read + owner pin passes", () => {
    const src = svc + `\nconst { data: { user } } = await supabase.auth.getUser(); q.eq("owner_user_id", user.id);`;
    expect(SESSION.test(code(src)) && OWNER_PIN.test(code(src))).toBe(true);
  });
  it("the GP-02b style createAdminClientFor(who.userId) counts as a pin", () => {
    expect(OWNER_PIN.test("createAdminClientFor(who.userId)")).toBe(true);
    expect(OWNER_PIN.test("createAdminClientFor(tenantId)")).toBe(false);
  });
  it("a fake /api/personal/x route is personal and, unlisted, would fail the listing check", () => {
    expect(bucketOf("personal/x")).toBe("personal");
    expect("personal/x" in PERSONAL_API_ROUTES).toBe(false);
  });
});
