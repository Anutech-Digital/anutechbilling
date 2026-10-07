/**
 * R-051 (7 Oct 2026) — every API route that holds the SERVICE ROLE must say who let the
 * caller in. The service role bypasses RLS, so for these routes the TypeScript check IS the
 * tenant boundary; a route that creates the admin client before (or without) proving who is
 * calling hands every tenant's rows to whoever can reach the URL.
 *
 * Each route under src/app/api/** that calls createAdminClient() or reads
 * SUPABASE_SERVICE_ROLE_KEY must land in exactly one bucket:
 *
 *   (a) secret   — machine caller: cron secret, agent token, API key, webhook signature,
 *                  per-tenant ingest key, or a signed/unguessable document token.
 *   (b) user     — signed-in user whose tenant/role is read from the DB (withRoute(), or
 *                  getUser() + a `users` row lookup of tenant_id/role).
 *       platform — signed-in founder, checked with isPlatformAdmin() on the auth email.
 *       self     — signed-in user, and every service-role read/write is pinned to their own
 *                  user id (their own Google token, push endpoint, password). SELF_SCOPED.
 *   (c) public   — anonymous by design, each with its reason. PUBLIC_BY_DESIGN.
 *
 * Anything else fails this test: a NEW service-role route must either prove its caller or be
 * added to a list below with a written reason — in review, not by accident. Stale list
 * entries fail too, so the lists only ever shrink.
 *
 * ROLE_GATED: routes that change money, reach many people at once or touch company-wide
 * accounts must also carry a role gate (ACTION_ROLES / roles: / mayDo) — "signed in + same
 * tenant" is not enough for those (S19, R-217; broadcast + template sync fixed in R-051).
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const API = path.resolve(__dirname);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

/** Comments out, so a route that only TALKS about a guard does not pass for having one. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const rel = (f: string) => path.relative(API, f).split(path.sep).join("/").replace(/\/route\.ts$/, "");

const USES_SERVICE_ROLE = /createAdminClient\s*\(|SUPABASE_SERVICE_ROLE_KEY/;

const SECRET_EVIDENCE = new RegExp([
  "CRON_SECRET", "AGENT_QUEUE_TOKEN", "authenticateApiKey", "checkPanelKey",
  "verifyMetaSignature", "createHmac", "timingSafeEqual", "secretMatches", "WEBHOOK_SECRET",
  "INBOUND_EMAIL_SECRET", "x-ingest-key", "verifyPdfToken", "quoteTokenMatches",
  "verifyClaimToken", "verifyUnsubscribe", "verifyTrialToken",
].join("|"));

const SIGNED_IN = /\.auth\.getUser\s*\(/;
const USERS_ROW = /\.from\(\s*["']users["']\s*\)\s*\.select\(\s*["'`][^"'`]*\b(tenant_id|role)\b/;
const PLATFORM = /isPlatformAdmin\s*\(/;
const OWN_ID_ONLY = /["']user_id["']\s*,\s*(auth\.)?user\.id\b|updateUserById\(\s*user\.id\b/;
const ROLE_GATE = /roles:\s*(ACTION_ROLES|\[|OM\b|OWNER)|\.\.\.OWNER_ONLY|mayDo\s*\(/;

/** (b-self) signed in, and the service role only ever touches the caller's own rows. */
const SELF_SCOPED: Record<string, string> = {
  "integrations/google-contacts": "reads/deletes user_google_tokens where user_id = caller",
  "integrations/google-contacts/connect": "reads the caller's own prior Google token before OAuth",
  "integrations/google-gmail": "reads the caller's own Gmail token status",
  "integrations/google-gmail/connect": "reads the caller's own prior Google token before OAuth",
  "push/unsubscribe": "deletes the caller's own push endpoint (user_id = caller)",
  "settings/change-password": "re-checks the current password, then updates only the caller's auth user",
};

/** (c) anonymous by design — every entry says what bounds it instead of a session. */
const PUBLIC_BY_DESIGN: Record<string, string> = {
  "auth/signup": "signup itself; Turnstile + verified-domain rules, grants nothing unverified",
  "auth/resend-verification": "same answer for every email; rate-limited per IP and per address",
  "auth/verify-email": "one-time verification token is the credential; rate-limited per IP",
  "public/agent/chat": "website sales chat; capped messages, model sees only public facts",
  "public/assessment/[token]": "read scoped to the unguessable assessment share token",
  "public/assessment/[token]/submit": "write scoped to the unguessable assessment share token",
  "public/callback": "website call-back form; Turnstile + per-IP/per-number rate limits",
  "public/catalog/workspace": "public price catalogue (read-only)",
  "public/checkout/workspace": "public buy flow; creates a draft quote for the buy-page tenant only",
  "public/coupons/validate": "dry-run coupon check for the buy-page tenant; records nothing",
  "public/enquiry/general": "website enquiry form; Turnstile",
  "public/enquiry/workspace": "website workspace enquiry; Turnstile",
  "public/health/live": "uptime probe; head count on tenants, returns no rows",
  "public/site-promo/current": "the website's current promo banner (read-only)",
  "public/trial/workspace": "website trial request; inserts a lead for the buy-page tenant",
};

/** Must carry a role gate on top of sign-in (money / many recipients / company accounts). */
const ROLE_GATED = [
  "campaigns/send",
  "contacts/import",
  "seat-requests/[id]/decide",
  "subscriptions/[id]/add-seats",
  "subscriptions/[id]/extend",
  "marketing/whatsapp/broadcast",
  "marketing/whatsapp/templates/sync",
  "marketing/ads/sync",
  "marketing/gbp/reply",
  "leads/indiamart",
];

type Kind = "secret" | "platform" | "user" | "self" | "public" | "FINDING";

function classify(route: string, src: string): Kind {
  if (SECRET_EVIDENCE.test(src)) return "secret";
  const signedIn = SIGNED_IN.test(src);
  if (signedIn && PLATFORM.test(src)) return "platform";
  if (/\bwithRoute\s*\(/.test(src) || (signedIn && USERS_ROW.test(src))) return "user";
  if (route in SELF_SCOPED && signedIn && OWN_ID_ONLY.test(src)) return "self";
  if (route in PUBLIC_BY_DESIGN) return "public";
  return "FINDING";
}

const routes = walk(API)
  .map((f) => ({ route: rel(f), src: code(fs.readFileSync(f, "utf8")) }))
  .filter((r) => USES_SERVICE_ROLE.test(r.src));
const kinds = new Map(routes.map((r) => [r.route, classify(r.route, r.src)]));

describe("service-role API routes prove their caller (R-051 ratchet)", () => {
  it("finds the service-role routes (the scan is not silently empty)", () => {
    expect(routes.length).toBeGreaterThan(100);
  });

  it("every service-role route is secret / user / platform / self / public — none unguarded", () => {
    const findings = [...kinds].filter(([, k]) => k === "FINDING").map(([r]) => r);
    expect(findings, "service-role route with no caller check — guard it or list it with a reason").toEqual([]);
  });

  it("SELF_SCOPED and PUBLIC_BY_DESIGN have no stale entries (the lists only shrink)", () => {
    const stale = [...Object.keys(SELF_SCOPED), ...Object.keys(PUBLIC_BY_DESIGN)].filter((r) => {
      const k = kinds.get(r);
      return k !== (r in SELF_SCOPED ? "self" : "public");
    });
    expect(stale, "route gone, no longer service-role, or now proven another way — remove it").toEqual([]);
  });

  it("public entries never read a session (a signed-in route belongs in (b))", () => {
    const withSession = Object.keys(PUBLIC_BY_DESIGN).filter((r) => {
      const hit = routes.find((x) => x.route === r);
      return hit && SIGNED_IN.test(hit.src);
    });
    expect(withSession).toEqual([]);
  });

  it("money / broadcast / company-account routes carry a role gate, not just sign-in", () => {
    const missing = ROLE_GATED.filter((r) => {
      const f = path.join(API, r, "route.ts");
      return !fs.existsSync(f) || !ROLE_GATE.test(code(fs.readFileSync(f, "utf8")));
    });
    expect(missing).toEqual([]);
  });

  it("the classifier catches an unguarded route and ignores guards that are only in comments", () => {
    const bare = code(`import { createAdminClient } from "x";\nexport async function POST() { const a = createAdminClient(); }`);
    expect(classify("new/thing", bare)).toBe("FINDING");
    const commented = code(`// checks CRON_SECRET\n/* withRoute( */\nconst a = createAdminClient();`);
    expect(classify("new/thing", commented)).toBe("FINDING");
    const url = code(`const u = "https://x"; if (h !== process.env.CRON_SECRET) return; createAdminClient();`);
    expect(classify("new/thing", url)).toBe("secret");
  });
});
