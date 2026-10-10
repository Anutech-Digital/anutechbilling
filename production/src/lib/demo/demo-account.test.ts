/**
 * R-524: the pure rules of "Try the demo" — who is a demo visitor, which requests the
 * middleware refuses for them, how long a session lives, where leaving it may go, and the
 * migration that makes the database refuse every write.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  DEMO_SESSION_MINUTES, DEMO_VISITOR_EMAIL, DEMO_SEEDER_EMAIL,
  demoCookieLive, demoCookieValue, demoEnabled, demoExitTarget, demoHomePath, demoRequestVerdict,
  hasAuthCookie, isDemoVisitor, isReadOnlyRefusal,
} from "./demo-account";

describe("demoEnabled — owner switch, default OFF", () => {
  it("only DEMO_ENABLED=1 turns it on", () => {
    expect(demoEnabled({})).toBe(false);
    expect(demoEnabled({ DEMO_ENABLED: "true" })).toBe(false);
    expect(demoEnabled({ DEMO_ENABLED: "0" })).toBe(false);
    expect(demoEnabled({ DEMO_ENABLED: "1" })).toBe(true);
  });
});

describe("isDemoVisitor", () => {
  it("the visitor login, by flag or by email", () => {
    expect(isDemoVisitor({ email: "x@y.in", app_metadata: { demo_visitor: true } })).toBe(true);
    expect(isDemoVisitor({ email: DEMO_VISITOR_EMAIL.toUpperCase() })).toBe(true);
  });
  it("never the seeder, a real user or nobody", () => {
    expect(isDemoVisitor({ email: DEMO_SEEDER_EMAIL, app_metadata: { demo_seeder: true } })).toBe(false);
    expect(isDemoVisitor({ email: "owner@anutech.in", app_metadata: {} })).toBe(false);
    expect(isDemoVisitor(null)).toBe(false);
  });
  it("demo logins can never receive mail (.invalid)", () => {
    expect(DEMO_VISITOR_EMAIL.endsWith(".invalid")).toBe(true);
    expect(DEMO_SEEDER_EMAIL.endsWith(".invalid")).toBe(true);
  });
});

describe("demoRequestVerdict — what a demo visitor may do", () => {
  it("refuses every write: API routes, server actions, settings, invites, payments, sends", () => {
    for (const [m, p] of [
      ["POST", "/api/invoices"], ["PUT", "/api/customers/1"], ["PATCH", "/api/settings"], ["DELETE", "/api/quotes/Q-1"],
      ["POST", "/quotes/new"], ["POST", "/api/team/invite"], ["POST", "/api/payments/razorpay/order"],
      ["POST", "/api/campaigns/send"], ["POST", "/api/marketing/whatsapp/broadcast"], ["POST", "/api/public/demo-session"],
      ["POST", "/api/demo-data"], ["POST", "/api/upload"],
    ] as const) {
      expect(demoRequestVerdict(m, p), `${m} ${p}`).toBe("refuse");
    }
  });
  it("refuses exports, downloads and paid lookups even as GET", () => {
    for (const p of ["/api/invoices/export", "/api/reports/export.csv", "/api/customers/download", "/api/gst/verify", "/api/ai/plan-project", "/api/cron/renewals", "/api/backup.zip"]) {
      expect(demoRequestVerdict("GET", p), p).toBe("refuse");
    }
  });
  it("allows reading pages and data, and leaving the demo", () => {
    for (const p of ["/dashboard", "/invoices", "/settings", "/api/customers", "/manifest.json"]) {
      expect(demoRequestVerdict("GET", p), p).toBe("allow");
    }
    expect(demoRequestVerdict("HEAD", "/dashboard")).toBe("allow");
    expect(demoRequestVerdict("POST", "/api/demo/end")).toBe("allow");
  });
});

describe("demo session window", () => {
  const now = 1_760_000_000_000;
  it("lives DEMO_SESSION_MINUTES, then ends", () => {
    const v = demoCookieValue(now);
    expect(demoCookieLive(v, now)).toBe(true);
    expect(demoCookieLive(v, now + DEMO_SESSION_MINUTES * 60_000 - 1)).toBe(true);
    expect(demoCookieLive(v, now + DEMO_SESSION_MINUTES * 60_000)).toBe(false);
  });
  it("a missing, forged-far-future or garbage cookie is not live", () => {
    expect(demoCookieLive(undefined, now)).toBe(false);
    expect(demoCookieLive("abc", now)).toBe(false);
    expect(demoCookieLive(String(now + 365 * 86_400_000), now)).toBe(false);
  });
});

describe("demoExitTarget / demoHomePath — never an open redirect", () => {
  it("only /signup or home", () => {
    expect(demoExitTarget("/signup")).toBe("/signup");
    expect(demoExitTarget("https://evil.example")).toBe("/");
    expect(demoExitTarget("//evil.example")).toBe("/");
    expect(demoExitTarget(null)).toBe("/");
  });
  it("homepage is / on the product host, /reselleros elsewhere", () => {
    expect(demoHomePath("reselleros.anutech.in")).toBe("/");
    expect(demoHomePath("localhost:3000")).toBe("/reselleros");
  });
});

describe("hasAuthCookie", () => {
  it("sees a Supabase sign-in cookie, chunked or not, and nothing else", () => {
    expect(hasAuthCookie("a=1; sb-abc-auth-token=xyz")).toBe(true);
    expect(hasAuthCookie("sb-abc-auth-token.0=xyz")).toBe(true);
    expect(hasAuthCookie("sb-abc-auth-token=")).toBe(false);
    expect(hasAuthCookie("ros_demo=1")).toBe(false);
    expect(hasAuthCookie(null)).toBe(false);
  });
});

describe("isReadOnlyRefusal", () => {
  it("knows PostgREST's read-only-transaction answer", () => {
    expect(isReadOnlyRefusal({ code: "25006", message: "cannot execute INSERT in a read-only transaction" })).toBe(true);
    expect(isReadOnlyRefusal({ message: "cannot execute UPDATE in a read-only transaction" })).toBe(true);
    expect(isReadOnlyRefusal({ code: "42501", message: "permission denied" })).toBe(false);
    expect(isReadOnlyRefusal(null)).toBe(false);
  });
});

describe("migrations 20261009220000 + 20261009220100 — the database wall", () => {
  const sql = readFileSync("supabase/migrations/20261009220000_demo_tenant_readonly.sql", "utf8");
  const wiring = readFileSync("supabase/migrations/20261009220100_demo_readonly_wiring.sql", "utf8");
  it("deploy headers the manager's script needs", () => {
    const [l1, l2] = sql.split(/\r?\n/);
    expect(l1).toMatch(/^-- deploy-peek: .*to_regclass\('public\.demo_tenants'\).*to_regprocedure\('public\.demo_pre_request\(\)'\)/);
    expect(l1).not.toMatch(/[|"$]/);
    expect(l2).toMatch(/^-- deploy-key: [a-z0-9]+$/);
    const [w1, w2, w3] = wiring.split(/\r?\n/);
    expect(w1).toMatch(/^-- deploy-peek: /);
    expect(w1).not.toMatch(/[|"$]|::reg/);
    expect(w2).toMatch(/^-- deploy-key: [a-z0-9]+$/);
    expect(w3).toBe("-- deploy-user: postgres");
  });
  it("turns a demo visitor's whole request read-only, wired into PostgREST", () => {
    expect(sql).toMatch(/set_config\('transaction_read_only', 'on', true\)/);
    expect(wiring).toMatch(/alter role authenticator set pgrst\.db_pre_request to ''public\.demo_pre_request''/);
    expect(wiring).toMatch(/notify pgrst, 'reload config'/);
  });
  it("refuses demo uploads in storage with RESTRICTIVE policies", () => {
    for (const op of ["insert", "update", "delete"]) {
      expect(wiring).toMatch(new RegExp(`on storage\\.objects as restrictive for ${op} to public`));
    }
  });
  it("only the server can register a demo tenant", () => {
    expect(sql).toMatch(/revoke all on table public\.demo_tenants from anon, authenticated/);
  });
});
