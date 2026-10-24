/**
 * R-732 (16 Oct 2026) — every API route that CHANGES data must say which roles may call it.
 *
 * The 9 Oct security audit counted ~77 route files that write with nothing more than "signed
 * in + same tenant". Middleware's role guard skips /api, so a sales login could reset the
 * company's data, sync the catalog, start an Account Aggregator bank pull or raise a renewal
 * quote from the browser console. roles.ts has had a PERMISSIONS table since day one; this
 * test makes the routes use it.
 *
 * A mutating route (exports POST / PUT / PATCH / DELETE) counts as ROLE-GATED when its own code
 * shows one of:
 *   • withRoute({ roles: … }) or withRoute({ permission: … })          ← the intended way
 *   • can(role, "…") / canRecordMoney / canDeleteMoney / MONEY_*_ROLES / vaultGate() / mayDo()
 *   • ACTION_ROLES / OWNER_ONLY / isPlatformAdmin()
 *   • a literal comparison of the users row's role (role === "owner", ["owner","manager"].includes(role) …)
 * Machine-called routes (cron secret, webhook signature, API key, ingest key, signed token) and
 * the routes that are anonymous by design (sign-up, public forms) are not user routes and are
 * left out; they prove their caller in admin-client-ratchet.test.ts instead.
 *
 * RATCHET: the number of ungated mutating routes may only go DOWN. Gate a route → lower
 * UNGATED_BASELINE in the same commit. A new mutating route without a gate fails here.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const API = path.resolve(__dirname);

/** Ungated mutating user routes today. Only ever lower this number. */
const UNGATED_BASELINE = 0; // 17 Oct 2026, R-1470: the last 30 — 25 gated, 2 team routes' owner checks recognised, 3 listed below as not user routes.

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, out);
    else if (e.name === "route.ts") out.push(full);
  }
  return out;
}

/** Comments out, so a route that only TALKS about a gate does not pass for having one. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
}

const rel = (f: string) => path.relative(API, f).split(path.sep).join("/").replace(/\/route\.ts$/, "");

const MUTATES = /export\s+(async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/;

const MACHINE_CALLER = new RegExp([
  "CRON_SECRET", "AGENT_QUEUE_TOKEN", "authenticateApiKey", "checkPanelKey",
  "verifyMetaSignature", "createHmac", "timingSafeEqual", "secretMatches", "WEBHOOK_SECRET",
  "INBOUND_EMAIL_SECRET", "x-ingest-key", "verifyPdfToken", "quoteTokenMatches",
  "verifyClaimToken", "verifyUnsubscribe", "verifyTrialToken", "portalSession", "requirePortal",
  /* R-739: the AGENT_QUEUE_TOKEN check, now shared (lib/security/agent-token.ts). */
  "authorizeAgent\\(",
].join("|"));

const ROLE_GATE = new RegExp([
  String.raw`withRoute\s*(<[^>]*>)?\s*\(\s*\{[^}]*\b(roles|permission|pages)\s*:`,
  // R-1470: "may this role open the page that calls me" (nav.ts rule, fail-closed) and the
  // owner checks the team routes already had.
  String.raw`\bmayOpenPage\s*\(`, String.raw`\bisActiveOwner\s*\(`, String.raw`\bdecideTempPassword\s*\(`,
  String.raw`\bcan\s*\(`, String.raw`\bcanRecordMoney\s*\(`, String.raw`\bcanDeleteMoney\s*\(`,
  String.raw`\bMONEY_(RECORD|DELETE)_ROLES\b`, String.raw`\bvaultGate\s*\(`, String.raw`\bmayDo\s*\(`,
  String.raw`\bACTION_ROLES\b`, String.raw`\bOWNER_ONLY\b`, String.raw`\bisPlatformAdmin\s*\(`,
  String.raw`\brole\s*(===|!==|==|!=)\s*["'](owner|manager|accountant|billing)["']`,
  String.raw`["'](owner|manager)["']\s*\]\s*\.includes\s*\(`,
  String.raw`\.includes\s*\(\s*(me|caller|who|row)?\.?role\b`,
  String.raw`\brequireRole\s*\(`, String.raw`\bassertRole\s*\(`,
  // R-1776: every Cold Calling route starts with coldCallContext() (src/server/coldcall/route-context.ts),
  // which returns 403 unless the users row's role is in COLD_CALL_ROLES — fail-closed, like mayOpenPage.
  String.raw`\bcoldCallContext\s*\(`,
  // R-1792 (merged 24 Oct 2026): every Marketing budget route starts with budgetContext()
  // (src/server/marketing-budget/budget.server.ts) — 403 unless the users row's role is in
  // BUDGET_ROLES (owner, marketing, billing, accountant); who may approve / pay is then checked
  // per route (canApproveBudget / canPay / canAskBudget) and again by the DB triggers.
  String.raw`\bbudgetContext\s*\(`,
].join("|"));

/** Anonymous or self-service by design — a session is not what bounds these. Each says why. */
const NOT_A_USER_ROUTE: Record<string, string> = {
  // pre-login / the login itself
  "auth/[...nextauth]": "Auth.js sign-in endpoints",
  "auth/mfa/[action]": "the second sign-in step itself (enrol / verify for the caller's own account)",
  "auth/onboarding/join-request": "a fresh login asking to join a workspace — has no role yet",
  "auth/onboarding/new-tenant": "a fresh login creating its own workspace — becomes its owner",
  "auth/password/forgot": "pre-login",
  "auth/password/reset": "pre-login token",
  "auth/password/update": "the caller's own password",
  "auth/signup": "sign-up itself",
  "auth/resend-verification": "pre-login",
  "auth/verify-email": "pre-login token",
  "dev/test-login": "local/e2e only (refused outside test env)",
  "team/claim": "a fresh login claiming the users row an owner pre-created for its email",
  // website / public forms, bounded by rate limits + tokens, not a session
  "enquiry": "website form",
  "public/assessment/[token]/submit": "token-bound public form",
  "public/callback": "website form",
  "public/cart-coupon": "website cart",
  "public/checkout/cart": "website checkout",
  "public/checkout/workspace": "website checkout",
  "public/checkout/verify": "website checkout's return from Razorpay — bounded by the Razorpay signature (R-1596)",
  "public/coupons/validate": "website cart",
  "public/demo-session": "anonymous demo (R-524)",
  "public/agent/chat": "website chat",
  "public/enquiry/general": "website form",
  "public/enquiry/workspace": "website form",
  "public/trial/workspace": "website form",
  "public/ux/events": "anonymous UX events",
  "demo/end": "ends the caller's own demo session",
  // self-service: every member may act on their OWN rows only
  "attendance/device/auth/options": "WebAuthn for the caller's own device",
  "attendance/device/register/options": "WebAuthn for the caller's own device",
  "attendance/device/register/verify": "WebAuthn for the caller's own device",
  "attendance/mark": "the caller's own attendance",
  "attendance/self": "the caller's own attendance",
  "auth/login-event": "records the caller's OWN sign-in (R-1010) — user, time, IP and device all read on the server; the body is ignored",
  "push/subscribe": "the caller's own push endpoint",
  "push/unsubscribe": "the caller's own push endpoint",
  "push/test": "a test push to the caller's own device",
  "settings/change-password": "the caller's own password",
  "vault/personal/pin": "the caller's own personal-vault PIN",
  "aa/setu/callback": "Setu redirects the bank's browser here; it only flips the consent row the state token names",
  // R-1470
  "agent": "website chat bridge — forwards the visitor's messages to public/agent/chat; no session, no tenant data",
  "integrations/google-contacts": "DELETE removes the caller's OWN Google token (user_id = caller) — a per-user connection (action-roles.ts)",
  "integrations/google-contacts/sync": "retired (CONTACT_IMPORT_RETIRED fails closed); synced only the caller's OWN Google token",
};

const routes = walk(API)
  .map((f) => ({ route: rel(f), src: code(fs.readFileSync(f, "utf8")) }))
  .filter((r) => MUTATES.test(r.src))
  .filter((r) => !MACHINE_CALLER.test(r.src))
  .filter((r) => !(r.route in NOT_A_USER_ROUTE));

const ungated = routes.filter((r) => !ROLE_GATE.test(r.src)).map((r) => r.route).sort();

describe("mutating API routes carry a role gate (R-732 ratchet)", () => {
  it(`ungated mutating routes: ${ungated.length} (baseline ${UNGATED_BASELINE}) — may only go down`, () => {
    expect(ungated.length, "a NEW or regressed mutating route has no role gate:\n  " + ungated.join("\n  ")).toBeLessThanOrEqual(UNGATED_BASELINE);
    expect(ungated.length, "fewer ungated routes than the baseline — lower UNGATED_BASELINE to " + ungated.length).toBe(UNGATED_BASELINE);
  });

  it("every NOT_A_USER_ROUTE entry still exists (stale entries fail — the list only shrinks)", () => {
    const all = new Set(walk(API).map(rel));
    const stale = Object.keys(NOT_A_USER_ROUTE).filter((r) => !all.has(r));
    expect(stale).toEqual([]);
  });

  it("the slice-1 routes of R-732 are gated", () => {
    const gated = new Set(routes.filter((r) => ROLE_GATE.test(r.src)).map((r) => r.route));
    for (const r of [
      "settings/reset-data", "catalog/sync-domains", "catalog/sync-hosting",
      "aa/setu/consent/init", "aa/setu/fetch/[connectionId]",
      "subscriptions/[id]/generate-renewal-quote", "whatsapp/send", "leads/[id]/email",
    ]) expect(gated.has(r), r).toBe(true);
  });

  it("the R-1470 routes are gated (role-gate-r1470.test.ts proves each one refuses)", () => {
    const gated = new Set(routes.filter((r) => ROLE_GATE.test(r.src)).map((r) => r.route));
    for (const r of [
      "ai/classify-junk", "ai/data-entry", "ai/draft-followup", "ai/extract-bill", "ai/extract-statement",
      "ai/generate-assessment", "ai/help", "ai/plan-project", "ai/scan-visiting-card", "campaigns/ai-generate",
      "contacts/[id]/promote", "feedback/triage", "gstin/verify", "inbound-emails/[id]/convert",
      "inbound-emails/[id]/reply", "inbound-emails/[id]/state", "leads/[id]/draft-reply", "leads/google-import",
      "leads/start-trial", "marketing/review-request", "my-advances", "quotes/[id]/send", "renewals/send-now",
      "support/call-request", "voice/whatsapp-note", "team/join-requests/[id]", "team/members/[id]/temp-password",
    ]) expect(gated.has(r), r).toBe(true);
  });
});
